// Shared utilities for the runtime self-learning plugin.
// Used by both the plugin entry (index.js) and standalone tools (tools/*.js).

import fs from "fs";
import path from "path";

export const DEFAULT_CONFIG = {
  autoInjectHighConfidence: true,
  minInjectScore: 8,
  minInjectCount: 2,
  decayHalfLifeDays: 30,
  includePendingPreferences: true,
};

export function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {}
  return fallback;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

export function ageDays(pattern) {
  const lastSeen = Date.parse(pattern?.lastSeen || pattern?.firstSeen || "");
  if (!Number.isFinite(lastSeen)) return 0;
  return Math.max(0, (Date.now() - lastSeen) / 86_400_000);
}

export function decayedScore(pattern, config) {
  const score = Number(pattern?.score || 0);
  const halfLife = Math.max(1, Number((config || DEFAULT_CONFIG).decayHalfLifeDays || DEFAULT_CONFIG.decayHalfLifeDays));
  return score * Math.pow(0.5, ageDays(pattern) / halfLife);
}

export function patternStatus(pattern) {
  return pattern?.status || "pending";
}

export function isInjectable(pattern, config) {
  if (!pattern || patternStatus(pattern) === "rejected") return false;
  if (patternStatus(pattern) === "approved") return true;
  if (pattern.type === "preference" && (config || DEFAULT_CONFIG).includePendingPreferences) return true;
  return !!(config || DEFAULT_CONFIG).autoInjectHighConfidence
    && (pattern.count || 0) >= ((config || DEFAULT_CONFIG).minInjectCount || DEFAULT_CONFIG.minInjectCount)
    && decayedScore(pattern, config) >= ((config || DEFAULT_CONFIG).minInjectScore || DEFAULT_CONFIG.minInjectScore);
}
