export interface CursorUpstreamError {
  code?: string;
  message?: string;
  details?: unknown[];
}

export interface CursorRateLimitMetadata {
  cursorError?: string;
  title?: string;
  detail?: string;
  retryable?: boolean;
  resetDate?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Parse the JSON error carried by a Connect end-stream frame. */
export function parseCursorErrorPayload(payload: Buffer): CursorUpstreamError | undefined {
  try {
    const envelope = record(JSON.parse(payload.toString("utf8")));
    const error = record(envelope?.error);
    if (!error) return undefined;
    return {
      ...(text(error.code) ? { code: text(error.code) } : {}),
      ...(text(error.message) ? { message: text(error.message) } : {}),
      ...(Array.isArray(error.details) ? { details: error.details } : {}),
    };
  } catch {
    return undefined;
  }
}

export function formatCursorError(error: CursorUpstreamError, fallback: string): string {
  return `${error.code ?? "error"}: ${error.message ?? fallback}`;
}

function normalizeResetDate(value: string): string | undefined {
  const match = value.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!match) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

/** Extract stable, useful fields from Cursor's aiserver.v1.ErrorDetails debug envelope. */
export function cursorRateLimitMetadata(error: CursorUpstreamError): CursorRateLimitMetadata {
  for (const item of error.details ?? []) {
    const debug = record(record(item)?.debug);
    const details = record(debug?.details);
    if (!debug || !details) continue;
    const detail = text(details.detail) ?? text(record(details.additionalInfo)?.chatMessage);
    const resetDate = detail ? normalizeResetDate(detail) : undefined;
    return {
      ...(text(debug.error) ? { cursorError: text(debug.error) } : {}),
      ...(text(details.title) ? { title: text(details.title) } : {}),
      ...(detail ? { detail } : {}),
      ...(typeof details.isRetryable === "boolean" ? { retryable: details.isRetryable } : {}),
      ...(resetDate ? { resetDate } : {}),
    };
  }
  return {};
}
