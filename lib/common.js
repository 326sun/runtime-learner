// Shared utilities for the runtime self-learning plugin.
// Used by both the plugin entry (index.js) and standalone tools (tools/*.js).

import fs from "fs";
import path from "path";
import os from "os";

export const DEFAULT_CONFIG = {
  autoInjectHighConfidence: true,
  autoApproveHighConfidence: true,
  minInjectScore: 8,
  minInjectCount: 2,
  decayHalfLifeDays: 30,
  includePendingPreferences: true,
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
  modelAdvisorMinIntervalMinutes: 180,
  // Off by default: these push unsolicited messages into the user's chat. Opt in
  // if you want in-conversation status / proposal notifications.
  workStatusEnabled: false,
  workStatusText: "正在自我整理学习",
  proposalChatNotificationsEnabled: false,
  maxSkillTokens: 800,
  minAdvisorNewPatterns: 3,
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

export function ageDays(pattern) {
  const lastSeen = Date.parse(pattern?.lastSeen || pattern?.firstSeen || "");
  if (!Number.isFinite(lastSeen)) return 0;
  return Math.max(0, (Date.now() - lastSeen) / 86_400_000);
}

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
  if (pattern.id?.startsWith?.("usage:large_context")) return "ephemeral";
  return "core";
}

// Ebbinghaus forgetting curve: memory strength decays over time
// Fast-decay for low-count, slow-decay for high-count (frequently reinforced)
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
  if (knowledgeTier(pattern) === "durable") {
    if (patternStatus(pattern) === "approved") return true;
    return !!(config || DEFAULT_CONFIG).includePendingPreferences;
  }
  if (pattern.type === "preference") return false;
  if (patternStatus(pattern) === "approved") return true;
  return !!(config || DEFAULT_CONFIG).autoInjectHighConfidence
    && (pattern.count || 0) >= ((config || DEFAULT_CONFIG).minInjectCount || DEFAULT_CONFIG.minInjectCount)
    && decayedScore(pattern, config) >= ((config || DEFAULT_CONFIG).minInjectScore || DEFAULT_CONFIG.minInjectScore);
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
  const prefs = decorated.filter(p => knowledgeTier(p) === "durable" && p.injectable && (
    p.status === "approved" || p.advisorUpdatedAt
  )).slice(0, 5);
  const workflows = decorated.filter(p => p.type === "workflow" && p.injectable).slice(0, 3);
  const risks = decorated.filter(p => (p.type === "error" || p.type === "usage") && p.injectable).slice(0, 3);

  const lines = [
    "# Runtime Self-Learning",
    "",
    `Observed ${turnCount || patterns.length} patterns, ${injectable.length} active.`,
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
    if (decorated.filter(p => knowledgeTier(p) === "durable" && p.injectable && (p.status === "approved" || p.advisorUpdatedAt)).length > 5) lines.push("- ... more via self_learning_search");
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
  // CJK-aware token estimation: Chinese/Japanese/Korean chars ~1.8 tokens,
  // ASCII/alphanumeric ~0.25 tokens (≈4 chars per token).
  // This is ~30% more accurate than the naive length/3 for mixed CN/EN text.
  // rawTokens is purely additive per character (no rounding), which lets the
  // trim loop below update the running total by subtracting a removed line's
  // cost instead of re-scanning the whole document each time (O(n) vs O(n²)).
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
    `Updated: ${new Date().toISOString()}`,
    "",
  );
  return lines.join("\n");
}
