import crypto from "node:crypto";

function shortDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function usageDedupKey(entry = {}, summaryEntry = {}) {
  const requestId = summaryEntry.requestId || entry.requestId;
  if (requestId) return requestId;

  const stableDate = entry.endedAt || entry.startedAt;
  if (!stableDate) return null;

  const payload = {
    date: stableDate,
    status: summaryEntry.status,
    model: summaryEntry.model,
    subsystem: summaryEntry.subsystem,
    operation: summaryEntry.operation,
    trigger: summaryEntry.trigger,
    sessionPath: summaryEntry.sessionPath,
    totalTokens: summaryEntry.totalTokens,
    inputTokens: summaryEntry.inputTokens,
    outputTokens: summaryEntry.outputTokens,
    reasoningTokens: summaryEntry.reasoningTokens,
    cacheHitRatio: summaryEntry.cacheHitRatio,
    costTotal: summaryEntry.costTotal,
    error: summaryEntry.error,
  };
  return `usage:${shortDigest(JSON.stringify(payload))}`;
}

export function normalizeSeenIds(value, { cap = 5000 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item)
    .slice(-Math.max(0, cap));
}
