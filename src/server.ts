/**
 * OpenAI-compatible HTTP surface.
 *
 * Routes: GET /health, GET /v1/models, POST /v1/chat/completions.
 * Designed to sit on 127.0.0.1 behind CLIProxyAPI's `openai-compatibility`
 * upstream, so there is no CORS handling and no browser surface.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Config } from "./config.js";
import type { CursorUpstreamError } from "./cursor/errors.js";
import type { AccountPool } from "./auth.js";
import { listModelIds, toModelList, upstreamId } from "./models.js";
import { runTurn, type TurnEvent } from "./cursor/session.js";
import { buildTurnInput, type OpenAIChatRequest } from "./openai/translate.js";
import { openAIErrorResponse } from "./openai/errors.js";

export interface ServerDeps {
  config: Config;
  pool: AccountPool;
  log: (msg: string) => void;
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((err: unknown) => {
      deps.log(`unhandled: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: (err as Error).message } });
      else res.end();
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /health" || route === "GET /") {
    sendJson(res, 200, { ok: true, accounts: deps.pool.size(), models: "dynamic" });
    return;
  }

  if (!authorized(req, deps.config)) {
    sendJson(res, 401, { error: { message: "invalid api key", type: "invalid_request_error" } });
    return;
  }

  if (route === "GET /v1/models") {
    const account = await deps.pool.next();
    const ids = await listModelIds(account.accessToken, deps.config);
    sendJson(res, 200, { object: "list", data: toModelList(ids, deps.config.modelPrefix) });
    return;
  }

  if (route === "POST /v1/chat/completions") {
    await chatCompletions(req, res, deps, url);
    return;
  }

  sendJson(res, 404, { error: { message: `no route for ${route}`, type: "invalid_request_error" } });
}

function authorized(req: http.IncomingMessage, config: Config): boolean {
  if (!config.apiKey) return true;
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = (req.headers["x-api-key"] as string | undefined) ?? "";
  return bearer === config.apiKey || alt === config.apiKey;
}

async function chatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
  _url: URL,
): Promise<void> {
  const { config, pool, log } = deps;
  let body: OpenAIChatRequest;
  try {
    body = JSON.parse(await readBody(req)) as OpenAIChatRequest;
  } catch (err) {
    sendJson(res, 400, { error: { message: `bad JSON body: ${(err as Error).message}` } });
    return;
  }

  const account = await pool.next();
  const known = await listModelIds(account.accessToken, config);
  const clientModel = body.model ?? `${config.modelPrefix}auto`;
  const model = upstreamId(clientModel, config.modelPrefix, known);
  const input = buildTurnInput(body, config);

  if (config.logRequests) {
    log(
      `chat account=${account.label} model=${model} history=${input.rootMessages.length} ` +
        `tools=${input.tools.length} stream=${Boolean(body.stream)} ` +
        `action=${input.userText.trim() ? "user" : "resume"}`,
    );
  }

  const abort = new AbortController();
  req.on("close", () => abort.abort());

  const events = runTurn({
    token: account.accessToken,
    model,
    rootMessages: input.rootMessages,
    userText: input.userText,
    tools: input.tools,
    config,
    signal: abort.signal,
  });

  if (body.stream) await streamResponse(res, events, clientModel, deps, account.label);
  else await bufferResponse(res, events, clientModel, deps, account.label);
}

const OPENAI_TOOL_TYPE = "function" as const;

interface Collected {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage: { inputTokens?: number; outputTokens?: number };
  reason: "stop" | "tool_calls" | "error";
  error?: string;
  upstreamError?: CursorUpstreamError;
}

async function collect(events: AsyncGenerator<TurnEvent>): Promise<Collected> {
  const out: Collected = { text: "", reasoning: "", toolCalls: [], usage: {}, reason: "stop" };
  for await (const ev of events) {
    if (ev.type === "text") out.text += ev.delta;
    else if (ev.type === "thinking") out.reasoning += ev.delta;
    else if (ev.type === "tool_call") out.toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
    else if (ev.type === "usage") {
      if (ev.inputTokens !== undefined) out.usage.inputTokens = ev.inputTokens;
      if (ev.outputTokens !== undefined) out.usage.outputTokens = ev.outputTokens;
    } else if (ev.type === "done") {
      out.reason = ev.reason;
      out.error = ev.error;
      out.upstreamError = ev.upstreamError;
    }
  }
  return out;
}

async function bufferResponse(
  res: http.ServerResponse,
  events: AsyncGenerator<TurnEvent>,
  clientModel: string,
  deps: ServerDeps,
  accountLabel: string,
): Promise<void> {
  const result = await collect(events);
  if (result.reason === "error") {
    deps.log(`upstream error (${accountLabel}): ${result.error}`);
    const mapped = openAIErrorResponse(result.error ?? "upstream error", result.upstreamError);
    sendJson(res, mapped.status, mapped.payload);
    return;
  }
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const message: Record<string, unknown> = { role: "assistant", content: result.text || null };
  if (result.reasoning) message.reasoning_content = result.reasoning;
  if (result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((c) => ({
      id: c.id,
      type: OPENAI_TOOL_TYPE,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: clientModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: usageBlock(result.usage),
  });
}

async function streamResponse(
  res: http.ServerResponse,
  events: AsyncGenerator<TurnEvent>,
  clientModel: string,
  deps: ServerDeps,
  accountLabel: string,
): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let opened = false;
  let toolIndex = 0;
  let finish: "stop" | "tool_calls" = "stop";
  const usage: Collected["usage"] = {};

  const open = (): void => {
    if (opened) return;
    opened = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    emit(res, chunk(id, created, clientModel, { role: "assistant", content: "" }, null));
  };

  for await (const ev of events) {
    if (ev.type === "text") {
      open();
      emit(res, chunk(id, created, clientModel, { content: ev.delta }, null));
    } else if (ev.type === "thinking") {
      open();
      emit(res, chunk(id, created, clientModel, { reasoning_content: ev.delta }, null));
    } else if (ev.type === "tool_call") {
      open();
      finish = "tool_calls";
      emit(
        res,
        chunk(
          id,
          created,
          clientModel,
          {
            tool_calls: [
              {
                index: toolIndex++,
                id: ev.id,
                type: OPENAI_TOOL_TYPE,
                function: { name: ev.name, arguments: JSON.stringify(ev.args) },
              },
            ],
          },
          null,
        ),
      );
    } else if (ev.type === "usage") {
      if (ev.inputTokens !== undefined) usage.inputTokens = ev.inputTokens;
      if (ev.outputTokens !== undefined) usage.outputTokens = ev.outputTokens;
    } else if (ev.type === "done") {
      if (ev.reason === "error") {
        deps.log(`upstream error (${accountLabel}): ${ev.error}`);
        const mapped = openAIErrorResponse(ev.error ?? "upstream error", ev.upstreamError);
        if (!opened) {
          sendJson(res, mapped.status, mapped.payload);
          return;
        }
        // Mid-stream failures can only be reported inside the stream.
        emit(res, mapped.payload);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      open();
      const last = chunk(id, created, clientModel, {}, ev.reason === "tool_calls" ? "tool_calls" : finish);
      last.usage = usageBlock(usage);
      emit(res, last);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
  }

  // Generator ended without a done event (should not happen) — close cleanly.
  open();
  emit(res, chunk(id, created, clientModel, {}, finish));
  res.write("data: [DONE]\n\n");
  res.end();
}

function chunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, any> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageBlock(usage: Collected["usage"]): Record<string, number> {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function emit(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
