import {
  cursorRateLimitMetadata,
  type CursorUpstreamError,
} from "../cursor/errors.js";

export interface OpenAIErrorResponse {
  status: number;
  payload: {
    error: Record<string, unknown>;
  };
}

/** Convert a structured Cursor error into the closest OpenAI-compatible HTTP error. */
export function openAIErrorResponse(
  fallbackMessage: string,
  upstream?: CursorUpstreamError,
): OpenAIErrorResponse {
  const code = upstream?.code?.trim().toLowerCase();
  const rateLimit =
    code === "resource_exhausted" && upstream ? cursorRateLimitMetadata(upstream) : {};
  const status = code === "resource_exhausted" ? 429 : 502;
  const type = code === "resource_exhausted" ? "rate_limit_error" : "upstream_error";
  const message = rateLimit.detail ?? upstream?.message ?? fallbackMessage;
  const error: Record<string, unknown> = {
    message,
    type,
    ...(code ? { code } : {}),
    ...(upstream?.details ? { details: upstream.details } : {}),
    ...(rateLimit.cursorError ? { cursor_error: rateLimit.cursorError } : {}),
    ...(rateLimit.retryable !== undefined ? { retryable: rateLimit.retryable } : {}),
    ...(rateLimit.resetDate ? { reset_date: rateLimit.resetDate } : {}),
  };
  return { status, payload: { error } };
}
