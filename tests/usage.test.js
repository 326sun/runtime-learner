import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { usageDedupKey, normalizeSeenIds } from "../lib/usage.js";

const summary = {
  date: "2026-06-08T10:00:00.000Z",
  requestId: null,
  status: "success",
  model: "openai/gpt-5",
  subsystem: "chat",
  operation: "completion",
  trigger: "user",
  sessionPath: "D:/sessions/a.jsonl",
  totalTokens: 1234,
  inputTokens: 1000,
  outputTokens: 234,
  reasoningTokens: 0,
  cacheHitRatio: null,
  costTotal: 0.01,
  error: null,
};

describe("usageDedupKey", () => {
  it("preserves requestId keys for compatibility with existing usage_seen.json", () => {
    assert.equal(
      usageDedupKey({ requestId: "req-123", endedAt: summary.date }, { ...summary, requestId: "req-123" }),
      "req-123",
    );
  });

  it("creates a stable fallback key for request-less entries with stable timestamps", () => {
    const entry = { endedAt: summary.date };
    const a = usageDedupKey(entry, summary);
    const b = usageDedupKey({ startedAt: summary.date }, summary);
    assert.match(a, /^usage:[a-f0-9]{16}$/);
    assert.equal(a, b);
  });

  it("changes fallback key when usage identity changes", () => {
    const entry = { endedAt: summary.date };
    const a = usageDedupKey(entry, summary);
    const b = usageDedupKey(entry, { ...summary, totalTokens: 1235 });
    assert.notEqual(a, b);
  });

  it("does not invent a fallback key without requestId or stable timestamp", () => {
    assert.equal(usageDedupKey({}, summary), null);
  });
});

describe("normalizeSeenIds", () => {
  it("treats corrupt persisted seen-id state as empty", () => {
    assert.deepEqual(normalizeSeenIds(null), []);
    assert.deepEqual(normalizeSeenIds({ requestIds: ["a"] }), []);
  });

  it("keeps only non-empty string ids within cap", () => {
    assert.deepEqual(normalizeSeenIds(["a", "", 1, "b", "c"], { cap: 2 }), ["b", "c"]);
  });
});
