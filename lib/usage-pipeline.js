/**
 * usage-pipeline — usage data collection and summarization for Runtime Self-Learning.
 * Extracted from index.js to reduce entry-point size.
 */

import { readJson, writeJson, learnerDir } from "./common.js";
import { safeText } from "./helpers.js";
import path from "path";

export const USAGE_SUMMARY_FILE = path.join(learnerDir(), "usage_summary.json");

export function usageModelKey(entry = {}) {
  const provider = entry.model?.provider || "unknown";
  const modelId = entry.model?.modelId || "unknown";
  return `${provider}/${modelId}`;
}

export function usageTotalTokens(entry = {}) {
  const total = entry.usage?.totalTokens;
  if (Number.isFinite(total)) return total;
  const input = entry.usage?.input?.totalTokens;
  const output = entry.usage?.output?.totalTokens;
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

export function summarizeUsageEntry(entry = {}, sessionPath = null) {
  return {
    date: entry.endedAt || entry.startedAt || new Date().toISOString(),
    requestId: entry.requestId || null,
    status: entry.status || "unknown",
    model: usageModelKey(entry),
    subsystem: entry.source?.subsystem || "unknown",
    operation: entry.source?.operation || "unknown",
    trigger: entry.source?.trigger || "unknown",
    sessionPath: sessionPath || entry.attribution?.sessionPath || entry.source?.actor?.sessionPath || null,
    totalTokens: usageTotalTokens(entry),
    inputTokens: entry.usage?.input?.totalTokens ?? null,
    outputTokens: entry.usage?.output?.totalTokens ?? null,
    reasoningTokens: entry.usage?.output?.reasoningTokens ?? null,
    cacheHitRatio: entry.usage?.cache?.hitRatio ?? null,
    costTotal: entry.usage?.costTotal ?? null,
    error: entry.error?.message ? safeText(entry.error.message, 200) : null,
  };
}

export function updateUsageSummary(summaryEntry, filePath = USAGE_SUMMARY_FILE) {
  const summary = readJson(filePath, {
    totalRequests: 0,
    status: {},
    byModel: {},
    bySubsystem: {},
    totalTokens: 0,
    costTotal: 0,
    lastSeenAt: null,
    recent: [],
  });

  summary.totalRequests += 1;
  summary.status[summaryEntry.status] = (summary.status[summaryEntry.status] || 0) + 1;
  summary.byModel[summaryEntry.model] = summary.byModel[summaryEntry.model] || { requests: 0, totalTokens: 0, costTotal: 0 };
  summary.byModel[summaryEntry.model].requests += 1;
  summary.byModel[summaryEntry.model].totalTokens += summaryEntry.totalTokens || 0;
  summary.byModel[summaryEntry.model].costTotal += summaryEntry.costTotal || 0;
  summary.bySubsystem[summaryEntry.subsystem] = (summary.bySubsystem[summaryEntry.subsystem] || 0) + 1;
  summary.totalTokens += summaryEntry.totalTokens || 0;
  summary.costTotal += summaryEntry.costTotal || 0;
  summary.lastSeenAt = summaryEntry.date;
  summary.recent = [summaryEntry, ...(summary.recent || [])].slice(0, 50);
  writeJson(filePath, summary);
  return summary;
}

export function snapshotHostCapabilities(ctx) {
  const capabilities = typeof ctx.bus?.listCapabilities === "function"
    ? ctx.bus.listCapabilities()
    : [];
  const rows = capabilities.map((capability) => ({
    type: capability.type,
    available: capability.available !== false,
  }));
  const counts = {
    updatedAt: new Date().toISOString(),
    count: rows.length,
    availableCount: rows.filter((item) => item.available).length,
  };
  return counts;
}
