/**
 * OpenAI chat-completions <-> Cursor agent translation.
 *
 * Cursor's server builds the model prompt itself and only accepts conversation
 * history from the client, so a caller's `system` message is mapped onto a history
 * exchange (an instruction turn plus a short assistant acknowledgement) rather than
 * a `system` role entry. Set CURSOR_DIRECT_SYSTEM_AS_HISTORY=false to send the
 * system role verbatim instead.
 */
import type { McpToolDefinition } from "../cursor/session.js";
import type { Config } from "../config.js";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>;
  tool_choice?: unknown;
}

export interface TurnInput {
  rootMessages: unknown[];
  userText: string;
  tools: McpToolDefinition[];
}

/**
 * Cursor's API accepts no client system role, so a caller's `system` message is
 * delivered as the opening exchange of the conversation. It is labelled for what it
 * is — configuration from the operator of this gateway — rather than dressed up to
 * look like a platform system prompt. The model may still decline parts of it; that
 * is passed back to the caller as-is.
 */
const SYSTEM_LEAD_IN =
  "Configuration for this session, set by the operator of this API gateway:";
const SYSTEM_ACK = "Understood. I will follow that configuration for the rest of this conversation.";

export function textOf(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function buildTurnInput(body: OpenAIChatRequest, config: Config): TurnInput {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const rootMessages: unknown[] = [];

  // The active user message is the trailing user turn, if the caller ended on one.
  // Mid-agent-loop requests end on a tool result and get a resume action instead.
  let activeIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user" || role === "developer") {
      activeIndex = i;
      break;
    }
    if (role === "tool" || role === "assistant") break;
  }

  for (let i = 0; i < messages.length; i++) {
    if (i === activeIndex) continue;
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === "system" || msg.role === "developer") {
      const text = textOf(msg.content);
      if (!text) continue;
      if (config.systemAsHistory) {
        rootMessages.push({
          role: "user",
          content: [{ type: "text", text: `${SYSTEM_LEAD_IN}\n\n${text}` }],
        });
        rootMessages.push({ role: "assistant", content: [{ type: "text", text: SYSTEM_ACK }] });
      } else {
        rootMessages.push({ role: "system", content: text });
      }
      continue;
    }

    if (msg.role === "user") {
      const text = textOf(msg.content);
      if (text) rootMessages.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: unknown[] = [];
      const text = textOf(msg.content);
      if (text) parts.push({ type: "text", text });
      for (const call of msg.tool_calls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.function?.name ?? "",
          args: parseArgs(call.function?.arguments),
        });
      }
      if (parts.length > 0) rootMessages.push({ role: "assistant", content: parts });
      continue;
    }

    if (msg.role === "tool") {
      // Emit even when empty: the matching assistant `tool-call` is already in
      // history, and dropping the pair would replay an orphaned call.
      rootMessages.push({
        role: "tool",
        id: msg.tool_call_id ?? "",
        content: [
          {
            type: "tool-result",
            toolName: msg.name ?? "",
            toolCallId: msg.tool_call_id ?? "",
            result: textOf(msg.content),
          },
        ],
      });
    }
  }

  // A stateless caller mid-agent-loop ends on a tool result. There is no server-side
  // conversation to resume, so drive the follow-up with a continuation turn instead;
  // everything the model needs is already in `rootMessages`.
  const endsOnToolResult = messages.length > 0 && messages[messages.length - 1]?.role === "tool";
  const userText =
    activeIndex >= 0
      ? textOf(messages[activeIndex]?.content)
      : endsOnToolResult
        ? config.continuationPrompt
        : "";

  return { rootMessages, userText, tools: buildTools(body.tools) };
}

function parseArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export function buildTools(tools: OpenAIChatRequest["tools"]): McpToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  const out: McpToolDefinition[] = [];
  for (const tool of tools) {
    const fn = tool?.function;
    const name = fn?.name;
    if (!name) continue;
    out.push({
      name,
      toolName: name,
      providerIdentifier: "openai",
      description: fn?.description ?? "",
      inputSchemaJson: JSON.stringify(fn?.parameters ?? { type: "object", properties: {} }),
    });
  }
  return out;
}
