import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorRateLimitMetadata,
  parseCursorErrorPayload,
} from "../src/cursor/errors.js";
import { openAIErrorResponse } from "../src/openai/errors.js";

const quotaPayload = Buffer.from(
  JSON.stringify({
    error: {
      code: "resource_exhausted",
      message: "Error",
      details: [
        {
          type: "aiserver.v1.ErrorDetails",
          debug: {
            error: "ERROR_RATE_LIMITED_CHANGEABLE",
            details: {
              title: "You've hit your usage limit",
              detail:
                "Switch models or set a spend limit. Your usage limits will reset when your monthly cycle ends on 8/27/2026.",
              isRetryable: false,
            },
            isExpected: true,
          },
        },
      ],
    },
  }),
);

test("preserves Cursor Connect error details and extracts the advertised reset date", () => {
  const error = parseCursorErrorPayload(quotaPayload);
  assert.ok(error);
  assert.equal(error.code, "resource_exhausted");
  assert.equal(error.details?.length, 1);
  assert.deepEqual(cursorRateLimitMetadata(error), {
    cursorError: "ERROR_RATE_LIMITED_CHANGEABLE",
    title: "You've hit your usage limit",
    detail:
      "Switch models or set a spend limit. Your usage limits will reset when your monthly cycle ends on 8/27/2026.",
    retryable: false,
    resetDate: "2026-08-27",
  });
});

test("maps resource_exhausted to an OpenAI-compatible 429 without inventing Retry-After", () => {
  const error = parseCursorErrorPayload(quotaPayload);
  assert.ok(error);
  const mapped = openAIErrorResponse("resource_exhausted: Error", error);
  assert.equal(mapped.status, 429);
  assert.equal(mapped.payload.error.type, "rate_limit_error");
  assert.equal(mapped.payload.error.code, "resource_exhausted");
  assert.equal(mapped.payload.error.cursor_error, "ERROR_RATE_LIMITED_CHANGEABLE");
  assert.equal(mapped.payload.error.retryable, false);
  assert.equal(mapped.payload.error.reset_date, "2026-08-27");
  assert.equal("retry_after" in mapped.payload.error, false);
});

test("keeps non-quota Cursor failures as generic upstream errors", () => {
  const error = parseCursorErrorPayload(
    Buffer.from(JSON.stringify({ error: { code: "unavailable", message: "Error" } })),
  );
  assert.ok(error);
  const mapped = openAIErrorResponse("unavailable: Error", error);
  assert.equal(mapped.status, 502);
  assert.deepEqual(mapped.payload, {
    error: {
      message: "Error",
      type: "upstream_error",
      code: "unavailable",
    },
  });
});

test("does not expose an invalid calendar date as reset_date", () => {
  const error = parseCursorErrorPayload(
    Buffer.from(
      JSON.stringify({
        error: {
          code: "resource_exhausted",
          message: "Error",
          details: [{ debug: { details: { detail: "cycle ends on 2/30/2026" } } }],
        },
      }),
    ),
  );
  assert.ok(error);
  assert.equal(cursorRateLimitMetadata(error).resetDate, undefined);
});
