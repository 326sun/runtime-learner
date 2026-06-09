// Shared utilities for the runtime self-learning plugin.
// Used by both the plugin entry (index.js) and standalone tools (tools/*.js).

import fs from "fs";
import path from "path";
import os from "os";

export const DEFAULT_CONFIG = {
  governanceProfile: "balanced",
  autoInjectHighConfidence: true,
  autoApproveHighConfidence: true,
  minInjectScore: 8,
  minInjectCount: 2,
  decayHalfLifeDays: 30,
  // Off by default: unreviewed user corrections (pending preferences) stay
  // searchable but are not injected into SKILL.md until approved or reinforced
  // past the confidence bar. Advanced single-user setups can opt in (see README).
  includePendingPreferences: false,
  learnFromUsage: true,
  officialMemoryBridgeEnabled: true,
  officialMemoryBridgeMaxResults: 3,
  durableMemoryMaxCount: 50,
  largeUsageTokenThreshold: 120000,
  officialUtilityModelDisplay: "跟随 Hanako 用户设置的小模型",
  // Off by default: enabling this sends distilled patterns to an external
  // OpenAI-compatible endpoint. Require explicit opt-in (see README · 隐私).
  modelAdvisorEnabled: false,
  modelAdvisorSource: "official",
  modelAdvisorBaseUrl: "",
  modelAdvisorApiKey: "",
  modelAdvisorModel: "",
  modelAdvisorMaxTokens: 500,
  modelAdvisorMinIntervalMinutes: 60,
  // Off by default: these push unsolicited messages into the user's chat. Opt in
  // if you want in-conversation status / proposal notifications.
  workStatusEnabled: false,
  workStatusText: "正在自我整理学习",
  proposalChatNotificationsEnabled: false,
  // Strict governance mode (v1.5). When enabled, low-risk autoApply proposals
  // are queued for review and will not be applied until the review is approved.
  requireReviewForAutoApply: false,
  maxSkillTokens: 800,
  minAdvisorNewPatterns: 3,
  // Retrieval tuning (v0.9). Advanced-only — intentionally not surfaced in the
  // settings UI, mirroring maxSkillTokens / minAdvisorNewPatterns.
  retrievalCandidateLimit: 20,   // BM25 top-K fed into the gate
  minRetrievalRelative: 0.15,    // drop candidates below this fraction of the top BM25 score
  crossTaskPenalty: 1.0,         // rerank penalty for cross-taskType (still-admitted) recall
  minRetrievalConfidence: 0,     // hard floor on a candidate's explicit confidence (0 = off)
  // Semantic retrieval (v1.3). Off by default; enabling it sends memory text to
  // your configured embedding endpoint (see README · 隐私). When on, results are
  // ranked by RRF over BM25 + semantic + relation + memoryStrength. When off,
  // retrieval is the same dependency-free weighted BM25 as before.
  semanticSearchEnabled: false,
  semanticEmbeddingBaseUrl: "",
  semanticEmbeddingApiKey: "",
  semanticEmbeddingModel: "",
  semanticTopK: 50,              // advanced-only: candidates to embed/fuse
  rrfK: 60,                      // advanced-only: RRF damping constant
  semanticCacheMaxEntries: 1000,  // cap embeddings_cache.json growth; oldest entries are pruned
};

export function hanakoHome() {
  return process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
}

export function hanakoPreferencesPath() {
  const home = hanakoHome();
  const candidates = [
    process.env.HANAKO_PREFERENCES_FILE,
    path.join(home, "user", "preferences.json"),
    path.join(home, "preferences.json"),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || path.join(home, "user", "preferences.json");
}

export function readHanakoPreferences() {
  return readJson(hanakoPreferencesPath(), {});
}

export function describeOfficialUtilityModel(prefs = readHanakoPreferences()) {
  const raw = prefs?.utility_model;
  const id = typeof raw === "object" ? raw?.id : raw;
  const provider = typeof raw === "object" ? raw?.provider : prefs?.utility_api_provider;
  if (!id) {
    return {
      id: "",
      provider: provider || "",
      source: "Hanako 用户设置",
      display: "跟随 Hanako 用户设置的小模型（当前未读取到具体名称）",
    };
  }
  const providerText = provider ? `${provider} / ` : "";
  return {
    id: String(id),
    provider: provider ? String(provider) : "",
    source: "Hanako 用户设置",
    display: `${providerText}${id}（跟随 Hanako 用户设置）`,
  };
}

export function learnerDir() {
  return path.join(hanakoHome(), "self-learning");
}

export function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {}
  return fallback;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write: serialize to a temp file then rename, so a concurrent reader
  // (another tool invocation or Hanako instance) never observes a half-written
  // file. rename(2) is atomic on the same volume.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

// Clean up orphan .tmp files left behind by a crashed writeJson. Safe to call at
// startup — only removes files that end with `.tmp` and whose prefix matches a
// known config/data file name pattern.
export function cleanupTempFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".tmp")) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  } catch {}
}

export function loadLearnerConfig(configPath, { persist = false } = {}) {
  const config = { ...DEFAULT_CONFIG, ...readJson(configPath, {}) };
  if (persist) writeJson(configPath, config);
  return config;
}

export function countJsonl(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    const text = fs.readFileSync(file, "utf-8").trim();
    return text ? text.split("\n").filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

export function readRecentJsonl(file, cutoff) {
  const rows = [];
  try {
    if (!fs.existsSync(file)) return rows;
    for (const line of fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (new Date(row.date).getTime() >= cutoff) rows.push(row);
      } catch {}
    }
  } catch {}
  return rows;
}

export function countBy(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key] || "unknown"] = (counts[row[key] || "unknown"] || 0) + 1;
  return counts;
}

// CJK-aware token estimation: Chinese/Japanese/Korean chars ~1.8 tokens,
// ASCII/alphanumeric ~0.25 tokens (≈4 chars per token). Shared by
// buildSkillMdFromPatterns, validation-gate, and doctor.
export function estimateTokens(text) {
  let cjk = 0, other = 0;
  for (const ch of String(text || "")) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
        (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
        (cp >= 0x20000 && cp <= 0x2A6DF) || // CJK Extension B
        (cp >= 0x3040 && cp <= 0x309F) ||   // Hiragana
        (cp >= 0x30A0 && cp <= 0x30FF) ||   // Katakana
        (cp >= 0xAC00 && cp <= 0xD7AF)) {   // Hangul
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.8 + other * 0.25);
}

export function ageDays(pattern) {
  const lastSeen = Date.parse(pattern?.lastSeen || pattern?.firstSeen || "");
  if (!Number.isFinite(lastSeen)) return 0;
  return Math.max(0, (Date.now() - lastSeen) / 86_400_000);
}

/**
 * Ebbinghaus decayed score. Halves every `decayHalfLifeDays` days.
 * Durable knowledge is immune to decay (returns raw score).
 *
 * @param {object} pattern — { score, lastSeen, firstSeen, knowledgeTier }
 * @param {object} [config] — { decayHalfLifeDays }
 * @returns {number}
 */
export function decayedScore(pattern, config) {
  const score = Number(pattern?.score || 0);
  if (knowledgeTier(pattern) === "durable") return score;
  const halfLife = Math.max(1, Number((config || DEFAULT_CONFIG).decayHalfLifeDays || DEFAULT_CONFIG.decayHalfLifeDays));
  return score * Math.pow(0.5, ageDays(pattern) / halfLife);
}

export function knowledgeTier(pattern) {
  if (!pattern) return "core";
  if (pattern.knowledgeTier) return pattern.knowledgeTier;
  if (pattern.type === "preference") return "durable";
  if (pattern.type === "capability" || pattern.type === "host_capability") return "ephemeral";
  if (pattern.id?.startsWith?.("usage:large_context")) return "core";
  return "core";
}

/**
 * Memory strength under the Ebbinghaus forgetting curve.
 * Higher-count patterns decay more slowly: λ = ln(2) / (halfLife × √count).
 * Durable knowledge returns raw score unchanged.
 *
 * @param {object} pattern
 * @param {object} [config]
 * @returns {number}
 */
export function memoryStrength(pattern, config) {
  const score = Number(pattern?.score || 0);
  if (knowledgeTier(pattern) === "durable") return score;
  const count = Math.max(1, pattern?.count || 1);
  const days = ageDays(pattern);
  const halfLife = Math.max(1, (config || DEFAULT_CONFIG).decayHalfLifeDays || DEFAULT_CONFIG.decayHalfLifeDays);
  const lambda = Math.log(2) / (halfLife * Math.sqrt(count));
  return score * Math.exp(-lambda * days);
}

export function patternStatus(pattern) {
  return pattern?.status || "pending";
}

export function isInjectable(pattern, config) {
  if (!pattern || patternStatus(pattern) === "rejected") return false;
  const cfg = config || DEFAULT_CONFIG;
  // Durable patterns: always injectable when approved. Pending durable
  // patterns are gated by includePendingPreferences.
  if (knowledgeTier(pattern) === "durable") {
    if (patternStatus(pattern) === "approved") return true;
    return !!cfg.includePendingPreferences;
  }
  // Approved patterns of any tier inject directly.
  if (patternStatus(pattern) === "approved") return true;
  const meetsConfidence = (pattern.count || 0) >= (cfg.minInjectCount || DEFAULT_CONFIG.minInjectCount)
    && decayedScore(pattern, config) >= (cfg.minInjectScore || DEFAULT_CONFIG.minInjectScore);
  // Core-tier (non-durable) preferences: opt-in via includePendingPreferences,
  // and only once the correction has been reinforced enough to clear the same
  // confidence bar as other auto-injected patterns. Without the opt-in they stay
  // local (searchable) until approved or promoted to durable. This is what makes
  // includePendingPreferences govern a non-empty set — most pending preferences
  // are core-tier, not durable.
  if (pattern.type === "preference") {
    return !!cfg.includePendingPreferences && meetsConfidence;
  }
  return !!cfg.autoInjectHighConfidence && meetsConfidence;
}

export function decoratePatterns(patterns, config) {
  return (patterns || []).map((pattern) => ({
    ...pattern,
    knowledgeTier: knowledgeTier(pattern),
    status: patternStatus(pattern),
    decayedScore: Number(decayedScore(pattern, config).toFixed(2)),
    injectable: isInjectable(pattern, config),
  })).sort((a, b) => (b.decayedScore || 0) - (a.decayedScore || 0));
}

// Shared skill builder
export function buildSkillMdFromPatterns(patterns, config, { turnCount = 0, dataDir = "" } = {}) {
  const decorated = decoratePatterns(patterns, config);
  const injectable = decorated.filter(p => p.injectable);
  // Surface injectable preferences. Durable ones stay strict (only approved or
  // advisor-distilled, never raw pending corrections); core-tier ones qualify on
  // injectability alone, which already requires includePendingPreferences plus a
  // reinforced confidence score.
  const allPrefs = decorated.filter(p => p.type === "preference" && p.injectable && (
    knowledgeTier(p) !== "durable" || p.status === "approved" || p.advisorUpdatedAt
  ));
  const prefs = allPrefs.slice(0, 5);
  const workflows = decorated.filter(p => p.type === "workflow" && p.injectable).slice(0, 3);
  const risks = decorated.filter(p => (p.type === "error" || p.type === "usage") && p.injectable).slice(0, 3);

  const lines = [
    "# Runtime Self-Learning",
    "",
    turnCount
      ? `Observed ${turnCount} turns, ${patterns.length} patterns (${injectable.length} active).`
      : `${patterns.length} patterns, ${injectable.length} active.`,
    "",
    "## How to use",
    "- Use `self_learning_search <query>` to find relevant patterns before making decisions.",
    "- Example: before coding, search 'coding workflow' for past patterns.",
    "- Example: before replying, search user preferences.",
    "",
  ];

  if (prefs.length) {
    lines.push("## Verified User Preferences");
    for (const pref of prefs) {
      const text = (pref.fix && !pref.fix.startsWith("User correction:")) ? pref.fix
        : pref.desc.replace(/^User correction: /, "");
      lines.push(`- ${text}`);
    }
    if (allPrefs.length > 5) lines.push("- ... more via self_learning_search");
    lines.push("");
  }

  if (workflows.length) {
    lines.push("## Recent Workflows");
    for (const wf of workflows) lines.push(`- ${wf.desc}`);
    lines.push("");
  }

  if (risks.length) {
    lines.push("## Active Runtime Hints");
    for (const risk of risks) {
      const fix = risk.fix ? ` -> ${risk.fix}` : "";
      lines.push(`- ${risk.desc}${fix}`);
    }
    lines.push("");
  }

  const maxTokens = Math.max(200, Number((config || DEFAULT_CONFIG).maxSkillTokens || DEFAULT_CONFIG.maxSkillTokens));
  // CJK-aware token estimation: see also shared estimateTokens() above.
  // rawTokens returns the pre-rounding float for incremental subtraction.
  const rawTokens = (text) => {
    let cjk = 0, other = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
          (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
          (cp >= 0x20000 && cp <= 0x2A6DF) || // CJK Extension B
          (cp >= 0x3040 && cp <= 0x309F) ||   // Hiragana
          (cp >= 0x30A0 && cp <= 0x30FF) ||   // Katakana
          (cp >= 0xAC00 && cp <= 0xD7AF)) {   // Hangul
        cjk++;
      } else {
        other++;
      }
    }
    return cjk * 1.8 + other * 0.25;
  };
  const NEWLINE_RAW = rawTokens("\n");
  let currentRaw = rawTokens(lines.join("\n"));
  let currentTokens = Math.ceil(currentRaw);
  if (currentTokens > maxTokens) {
    // Per-entry trimming: remove the lowest-value entries first, within each section.
    // Priority order: Runtime Hints (trim first) → Workflows → Preferences (trim last).
    // Within each section, entries with lower decayedScore are trimmed first.
    const sectionHeaders = ["## Active Runtime Hints", "## Recent Workflows", "## Verified User Preferences"];
    for (const header of sectionHeaders) {
      if (currentTokens <= maxTokens) break;
      const idx = lines.indexOf(header);
      if (idx === -1) continue;
      // Find the section body: lines between header and next "## " header
      let end = idx + 1;
      while (end < lines.length && !lines[end].startsWith("## ")) end++;
      const bodyStart = idx + 1;
      const bodyEnd = end;
      // Collect entry lines (each "- ..." line is one entry)
      const entryLines = [];
      for (let i = bodyStart; i < bodyEnd; i++) {
        if (lines[i].startsWith("- ")) entryLines.push(i);
      }
      // Trim entries from the bottom (lowest-value, since entries are added in descending score order)
      while (entryLines.length > 0 && currentTokens > maxTokens) {
        const lastIdx = entryLines.pop();
        const removed = lines[lastIdx];
        lines.splice(lastIdx, 1);
        // Removing one line drops its content plus exactly one join separator.
        currentRaw -= rawTokens(removed) + NEWLINE_RAW;
        currentTokens = Math.ceil(currentRaw);
        // Adjust remaining entry line indices
        for (let j = 0; j < entryLines.length; j++) {
          if (entryLines[j] > lastIdx) entryLines[j] -= 1;
        }
      }
      // If section is now empty (only header remains), remove the entire section
      const nextIdx = lines.indexOf(header);
      if (nextIdx !== -1) {
        let nextEnd = nextIdx + 1;
        while (nextEnd < lines.length && !lines[nextEnd].startsWith("## ")) nextEnd++;
        if (nextEnd === nextIdx + 1) {
          // Section empty — remove header
          const removedHeader = lines[nextIdx];
          lines.splice(nextIdx, 1);
          currentRaw -= rawTokens(removedHeader) + NEWLINE_RAW;
          currentTokens = Math.ceil(currentRaw);
        }
      }
    }
  }

  lines.push(
    "## Tools",
    "- `self_learning_search <query>`: search learned patterns.",
    "- `self_learning_search` may include `officialMemory` results from Hanako's built-in memory bridge when enabled.",
    "- `self_learning_activity`: recent learning activity.",
    "- `self_learning_report`: learning report, including pending improvement proposals.",
    "- `self_learning_control`: use `list_proposals`, `show_proposal`, `apply_proposal`, or `reject_proposal` when the user replies to a proposal notification.",
    "- `self_learning_open_dir`: open data folder.",
    "",
    "## Proposal Notifications",
    "- If the chat contains a Runtime Self-Learning proposal notification and the user asks to view it, call `self_learning_control` with `action=show_proposal`.",
    "- If the user says to apply a proposal, call `self_learning_control` with `action=apply_proposal` for supported proposal types. For `code_patch`, implement the proposal manually, run verification, and install if appropriate.",
    "- If the user rejects a proposal, call `self_learning_control` with `action=reject_proposal` and include the user's reason when available.",
    "",
    "## Safety",
    "- Treat learned hints as suggestions.",
    "- Prefer current user instructions.",
    "- When a bash or edit tool fails: classify the error before deciding to retry.",
    "  * Non-retryable (permission denied, command not found, syntax error, path not found, auth error, file not found): do NOT retry the same command. Fix the root cause or use an alternative approach.",
    "  * Retryable (network error, timeout): wait briefly then retry. If persistent, check connectivity or provider status.",
    "  * Unknown tool error: inspect exit codes, stderr, and specific failure reasons. Fix the underlying issue rather than blindly retrying.",
    "",
  );
  return lines.join("\n");
}
