/**
 * One Cursor turn over Connect-RPC / HTTP2.
 *
 * `agent.v1.AgentService/Run` is a bidirectional stream, not a unary call. The
 * exchange for a single turn is:
 *
 *   client -> AgentClientMessage{run_request}
 *   server -> kv_server_message{get_blob_args}            (pulls our history blobs)
 *   client -> kv_client_message{get_blob_result}
 *   server -> exec_server_message{request_context_args}   (tool / rules handshake)
 *   client -> exec_client_message{request_context_result}
 *   server -> interaction_update{text_delta}...           (model output)
 *   server -> exec_server_message{mcp_args}               (model wants a caller tool)
 *   server -> interaction_update{turn_ended}
 *
 * Because the OpenAI protocol executes tools on the *caller* side, we do not
 * answer `mcp_args` here: it is surfaced as a `tool_call` event, the turn ends
 * with finish_reason=tool_calls, and the caller sends the result back on the next
 * request where it is replayed as conversation history.
 */
import { createHash, randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
import type { Config } from "../config.js";
import {
  formatCursorError,
  parseCursorErrorPayload,
  type CursorUpstreamError,
} from "./errors.js";
import { connectH2 } from "./h2.js";
import { AgentClientMessage, AgentServerMessage, decodeArgValue, toBytes } from "./proto.js";

export interface McpToolDefinition {
  name: string;
  toolName: string;
  providerIdentifier: string;
  description: string;
  inputSchemaJson: string;
}

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | {
      type: "done";
      reason: "stop" | "tool_calls" | "error";
      error?: string;
      upstreamError?: CursorUpstreamError;
    };

export interface RunTurnOptions {
  token: string;
  model: string;
  /** History entries (oldest first, excluding the active user message). */
  rootMessages: unknown[];
  /** The active user message text. */
  userText: string;
  tools: McpToolDefinition[];
  config: Config;
  signal?: AbortSignal;
}

const FLAG_COMPRESSED = 0x01;
const FLAG_END_STREAM = 0x02;

function connectFrame(payload: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head[0] = 0;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, Buffer.from(payload)]);
}

/** Blob ids are the sha256 of the blob contents. */
function blobId(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<TurnEvent> {
  const { config } = opts;

  // Every history entry travels as a KV blob that the server pulls back by id.
  const blobs = new Map<string, Buffer>();
  const store = (data: Buffer): Buffer => {
    const id = blobId(data);
    blobs.set(id.toString("hex"), data);
    return id;
  };
  const rootPromptMessagesJson = opts.rootMessages.map((entry) =>
    store(Buffer.from(JSON.stringify(entry), "utf8")),
  );

  const runRequest: Record<string, unknown> = {
    conversationState: {
      rootPromptMessagesJson,
      turns: [],
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [],
      summaryArchives: [],
      turnTimings: [],
    },
    // A turn driven by a fresh user message uses `userMessageAction`. When the
    // caller is mid-agent-loop (its last message is a tool result, so there is no
    // new user text) the server expects `resumeAction` instead — sending an empty
    // user message there makes the model answer the void.
    action: opts.userText.trim()
      ? { userMessageAction: { userMessage: { text: opts.userText, messageId: randomUUID() } } }
      : { resumeAction: {} },
    modelDetails: { modelId: opts.model, displayModelId: opts.model, displayName: opts.model },
    requestedModel: { modelId: opts.model },
    conversationId: randomUUID(),
  };
  if (opts.tools.length > 0) runRequest.mcpTools = { mcpTools: opts.tools };

  const headers: Record<string, string> = {
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${opts.token}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": config.clientVersion,
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
  // The only lever that removes Cursor's native tool registry from the model's view.
  if (config.allowedNativeTools.length > 0) {
    headers["x-cursor-agent-allowed-tools"] = config.allowedNativeTools.join(",");
  }

  const client = await connectH2(config.cursorBaseUrl, config.proxyUrl);
  const req = client.request(headers);

  // http2 callbacks feed this queue; the generator body drains it.
  const queue: TurnEvent[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  const push = (ev: TurnEvent): void => {
    queue.push(ev);
    const n = notify;
    notify = null;
    n?.();
  };
  const end = (ev: TurnEvent): void => {
    if (ended) return;
    ended = true;
    push(ev);
  };

  const send = (message: Record<string, unknown>): void => {
    if (req.closed || req.destroyed) return;
    req.write(connectFrame(AgentClientMessage.encode(AgentClientMessage.create(message)).finish()));
  };

  const decode = (payload: Buffer): Record<string, any> =>
    AgentServerMessage.toObject(AgentServerMessage.decode(payload), {
      defaults: false,
      longs: Number,
      enums: String,
      bytes: String, // base64 — normalised through toBytes()
    });

  req.on("response", (h) => {
    const status = Number(h[":status"] || 0);
    if (status !== 200) end({ type: "done", reason: "error", error: `upstream HTTP ${status}` });
  });

  let buffer = Buffer.alloc(0);
  req.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const flag = buffer[0]!;
      const len = buffer.readUInt32BE(1);
      if (buffer.length < 5 + len) break;
      let payload = buffer.subarray(5, 5 + len);
      buffer = buffer.subarray(5 + len);
      if (flag & FLAG_COMPRESSED) {
        try {
          payload = zlib.gunzipSync(payload);
        } catch {
          /* fall through; decode will fail and we skip the frame */
        }
      }
      if (flag & FLAG_END_STREAM) {
        end(endStreamEvent(payload));
        return;
      }
      let msg: Record<string, any>;
      try {
        msg = decode(payload);
      } catch {
        continue; // unknown frame shape — ignore rather than kill the turn
      }
      handle(msg);
    }
  });

  function endStreamEvent(payload: Buffer): TurnEvent {
    const trailer = payload.toString("utf8");
    const upstreamError = parseCursorErrorPayload(payload);
    if (upstreamError) {
      return {
        type: "done",
        reason: "error",
        error: formatCursorError(upstreamError, trailer),
        upstreamError,
      };
    }
    if (trailer.trim()) return { type: "done", reason: "error", error: trailer.slice(0, 500) };
    return { type: "done", reason: "stop" };
  }

  function handle(msg: Record<string, any>): void {
    if (msg.kvServerMessage) {
      const kv = msg.kvServerMessage;
      if (kv.getBlobArgs) {
        const id = toBytes(kv.getBlobArgs.blobId).toString("hex");
        const data = blobs.get(id);
        send({ kvClientMessage: { id: kv.id, getBlobResult: data ? { blobData: data } : {} } });
      } else if (kv.setBlobArgs) {
        blobs.set(toBytes(kv.setBlobArgs.blobId).toString("hex"), toBytes(kv.setBlobArgs.blobData));
        send({ kvClientMessage: { id: kv.id, setBlobResult: {} } });
      }
      return;
    }

    if (msg.execServerMessage) {
      const ex = msg.execServerMessage;
      if (ex.requestContextArgs) {
        // Deliberately minimal: no rules, no repo info, no project layout. The only
        // thing advertised is the caller's tool set.
        send({
          execClientMessage: {
            id: ex.id,
            ...(ex.execId !== undefined ? { execId: ex.execId } : {}),
            requestContextResult: {
              success: {
                requestContext: {
                  rules: [],
                  tools: opts.tools,
                  env: {
                    osVersion: "linux",
                    workspacePaths: [],
                    shell: "bash",
                    sandboxEnabled: false,
                    timeZone: "UTC",
                  },
                  repositoryInfo: [],
                  gitRepos: [],
                  projectLayouts: [],
                  mcpInstructions: [],
                },
              },
            },
          },
        });
        return;
      }
      if (ex.mcpArgs) {
        const a = ex.mcpArgs;
        const args: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(a.args ?? {})) args[key] = decodeArgValue(raw);
        push({
          type: "tool_call",
          id: String(a.toolCallId ?? randomUUID()),
          name: String(a.name ?? a.toolName ?? "unknown"),
          args,
        });
        // Hand control back to the caller — it owns tool execution.
        end({ type: "done", reason: "tool_calls" });
      }
      return;
    }

    if (msg.interactionUpdate) {
      const u = msg.interactionUpdate;
      if (u.textDelta?.text) push({ type: "text", delta: String(u.textDelta.text) });
      else if (u.thinkingDelta?.text) push({ type: "thinking", delta: String(u.thinkingDelta.text) });
      else if (u.tokenDelta) {
        // TokenDeltaUpdate carries a single `tokens` counter for the turn — there is
        // no prompt/completion split on the wire, so report it as output only and
        // leave prompt_tokens at 0 rather than inventing a number.
        push({ type: "usage", outputTokens: finiteOrUndefined(u.tokenDelta.tokens) });
      } else if (u.turnEnded) end({ type: "done", reason: "stop" });
    }
  }

  req.on("error", (err) => end({ type: "done", reason: "error", error: err.message }));
  req.on("end", () => end({ type: "done", reason: "stop" }));

  const timer = setTimeout(
    () => end({ type: "done", reason: "error", error: "upstream timeout" }),
    config.requestTimeoutMs,
  );
  const onAbort = (): void => end({ type: "done", reason: "error", error: "client aborted" });
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  send({ runRequest });

  try {
    for (;;) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const ev = queue.shift()!;
      if (ev.type === "text" && ev.delta === "") continue;
      yield ev;
      if (ev.type === "done") return;
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    try {
      req.close();
    } catch {
      /* already closed */
    }
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }
}

function finiteOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
