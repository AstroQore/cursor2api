/**
 * Unary Connect-RPC helper for the non-streaming AgentService methods
 * (GetUsableModels, GetDefaultModelForCli, NameAgent, ...).
 *
 * Connect's unary wire format differs from the streaming one: content-type is
 * `application/proto`, the body is the bare serialized message with no 5-byte
 * envelope, and the response body is likewise a bare message. Errors arrive as a
 * JSON object with a non-2xx status. Sending the streaming content-type here gets
 * a bodyless `415` back.
 */
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { h2Request } from "./h2.js";

export interface UnaryResult {
  status: number;
  /** Bare response message bytes on success. */
  payload: Buffer | null;
  /** Error text when the server rejected the call. */
  error: string | null;
}

export async function unaryCall(
  path: string,
  body: Uint8Array,
  token: string,
  config: Config,
  timeoutMs = 20_000,
): Promise<UnaryResult> {
  const res = await h2Request({
    baseUrl: config.cursorBaseUrl,
    path,
    proxyUrl: config.proxyUrl,
    timeoutMs,
    body,
    headers: {
      ":method": "POST",
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": config.clientVersion,
      "x-cursor-client-type": "cli",
      "x-request-id": randomUUID(),
    },
  });

  if (res.status !== 200) {
    let error = `HTTP ${res.status}`;
    if (String(res.headers["content-type"] ?? "").includes("json")) {
      try {
        const parsed = JSON.parse(res.body.toString("utf8")) as { code?: string; message?: string };
        error = `${parsed.code ?? "error"}: ${parsed.message ?? error}`;
      } catch {
        /* keep the status-only message */
      }
    }
    return { status: res.status, payload: null, error };
  }
  return { status: res.status, payload: res.body, error: null };
}
