/**
 * Configuration. Every knob is an env var, so the same image works from a bare
 * `node dist/index.cjs`, a docker-compose file, or a systemd unit with an
 * EnvironmentFile.
 */
import { readFileSync } from "node:fs";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Native Cursor tools the model may use. Cursor's server injects its own agent
 * prompt plus a 41-entry native tool registry no matter what we send; the
 * `x-cursor-agent-allowed-tools` header is the only lever that removes them.
 *
 * Default: allow ONLY `mcp_tool_call`, i.e. the model sees exactly the tools the
 * OpenAI caller declared and nothing else. Verified against api2.cursor.sh:
 * asking the model to list its tools returns only the caller's tool names.
 *
 * Set CURSOR_ALLOWED_NATIVE_TOOLS to a comma-separated list of ToolCall oneof
 * proto names (e.g. `mcp_tool_call,web_search_tool_call`) to let some natives
 * back in, or to `*` to disable the header entirely.
 */
export const DEFAULT_ALLOWED_TOOLS = ["mcp_tool_call"];

export interface Config {
  host: string;
  port: number;
  apiKey: string | undefined;
  /** Upstream Cursor Connect-RPC host. */
  cursorBaseUrl: string;
  /**
   * SOCKS5 proxy for ALL upstream traffic (RPC + token refresh), e.g.
   * socks5://127.0.0.1:1080.
   *
   * Tunnelling happens in-process on purpose. Wrapping the whole service in a
   * namespace-based redirector (nsproxy and friends) puts the process in its own
   * network namespace, which makes the HTTP listener unreachable from the host.
   */
  proxyUrl: string | undefined;
  /** Value for x-cursor-client-version; must look like a current CLI release. */
  clientVersion: string;
  /** Tool allow-list sent as x-cursor-agent-allowed-tools; empty = header omitted. */
  allowedNativeTools: string[];
  /** Client-visible model prefix. CPA exposes these names verbatim. */
  modelPrefix: string;
  /** Path to the JSON token store (array of accounts). */
  authFile: string;
  requestTimeoutMs: number;
  /** How a caller's `system` message is delivered (Cursor drops real system roles). */
  systemAsHistory: boolean;
  /**
   * Sent as the user turn when the caller's request ends on a tool result.
   *
   * Cursor's `resumeAction` resumes a conversation the server is already holding;
   * an OpenAI caller is stateless and replays its whole history each time, so there
   * is nothing server-side to resume and the turn comes back empty. The history
   * already carries the assistant tool-call and its result, so a short neutral
   * continuation turn is enough to get the follow-up answer.
   */
  continuationPrompt: string;
  logRequests: boolean;
}

export function loadConfig(): Config {
  return {
    host: str("CURSOR_DIRECT_HOST", "127.0.0.1"),
    port: num("CURSOR_DIRECT_PORT", 8790),
    apiKey: process.env.CURSOR_DIRECT_API_KEY || undefined,
    cursorBaseUrl: str("CURSOR_DIRECT_BASE_URL", "https://api2.cursor.sh"),
    proxyUrl: process.env.CURSOR_DIRECT_PROXY_URL || undefined,
    clientVersion: str("CURSOR_DIRECT_CLIENT_VERSION", "cli-2026.08.11-e8db854"),
    allowedNativeTools:
      str("CURSOR_ALLOWED_NATIVE_TOOLS", "").trim() === "*"
        ? []
        : list("CURSOR_ALLOWED_NATIVE_TOOLS", DEFAULT_ALLOWED_TOOLS),
    modelPrefix: str("CURSOR_DIRECT_MODEL_PREFIX", "cursor-"),
    authFile: str("CURSOR_DIRECT_AUTH_FILE", "./accounts.json"),
    requestTimeoutMs: num("CURSOR_DIRECT_TIMEOUT_MS", 300_000),
    systemAsHistory: bool("CURSOR_DIRECT_SYSTEM_AS_HISTORY", true),
    continuationPrompt: str(
      "CURSOR_DIRECT_CONTINUATION_PROMPT",
      "Continue, using the tool results above.",
    ),
    logRequests: bool("CURSOR_DIRECT_LOG_REQUESTS", true),
  };
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
