/**
 * Protobuf types for Cursor's agent.v1 wire protocol.
 *
 * proto/agent.proto is vendored from can1357/oh-my-pi
 * (packages/ai/src/providers/cursor/proto/agent.proto) — an extraction of
 * Cursor's own descriptor. Field numbers there are authoritative; a few message
 * types were flattened during extraction (see proto/value.proto for the
 * google.protobuf.Value that `McpArgs.args` values actually carry).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import protobuf from "protobufjs";

/**
 * Proto location. The default is relative to this module, which holds for both
 * `src/cursor/` and the built `dist/cursor/`. A single-file bundle collapses that
 * relationship, so deployments that bundle set CURSOR_DIRECT_PROTO_DIR explicitly.
 */
export const protoDir =
  process.env.CURSOR_DIRECT_PROTO_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../proto");

const agentRoot = protobuf.loadSync(path.join(protoDir, "agent.proto"));
const shimRoot = protobuf.loadSync(path.join(protoDir, "value.proto"));

export const AgentClientMessage = agentRoot.lookupType("agent.v1.AgentClientMessage");
export const AgentServerMessage = agentRoot.lookupType("agent.v1.AgentServerMessage");
export const ToolCall = agentRoot.lookupType("agent.v1.ToolCall");
export const ShimValue = shimRoot.lookupType("shim.Value");

/** All `ToolCall` oneof member names — the vocabulary for the tool allow-list header. */
export const NATIVE_TOOL_NAMES: string[] = (() => {
  const oneof = ToolCall.oneofs?.["tool"];
  const names = oneof ? oneof.oneof.slice() : Object.keys(ToolCall.fields);
  // protobufjs keys fields by their proto name, which is what the header expects.
  return names.filter((n) => n !== "toolCallId");
})();

/** Decode one `map<string, bytes>` arg value (a serialized google.protobuf.Value). */
export function decodeArgValue(raw: unknown): unknown {
  const bytes = toBytes(raw);
  if (bytes.length === 0) return null;
  let msg: Record<string, unknown>;
  try {
    msg = ShimValue.toObject(ShimValue.decode(bytes), {
      defaults: false,
      longs: Number,
      enums: String,
      bytes: String,
    }) as Record<string, unknown>;
  } catch {
    // Not a Value envelope — fall back to the raw text, which is what a plain
    // JSON-encoded arg map would contain.
    return bytes.toString("utf8");
  }
  return valueToJs(msg);
}

function valueToJs(v: Record<string, unknown>): unknown {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.numberValue !== undefined) return v.numberValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.nullValue !== undefined) return null;
  if (v.structValue !== undefined) {
    const fields = (v.structValue as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(fields)) out[k] = valueToJs(inner);
    return out;
  }
  if (v.listValue !== undefined) {
    const values = (v.listValue as { values?: Record<string, unknown>[] }).values ?? [];
    return values.map(valueToJs);
  }
  return null;
}

/**
 * protobufjs hands bytes fields back in several shapes depending on the
 * conversion options in play (Buffer, Uint8Array, base64 string, or an
 * index-keyed object). Normalise them all.
 */
export function toBytes(raw: unknown): Buffer {
  if (!raw) return Buffer.alloc(0);
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === "string") return Buffer.from(raw, "base64");
  if (Array.isArray(raw)) return Buffer.from(raw as number[]);
  if (typeof raw === "object") {
    const values = Object.values(raw as Record<string, unknown>);
    if (values.every((v) => typeof v === "number")) return Buffer.from(values as number[]);
  }
  return Buffer.alloc(0);
}
