// Shared helpers extracted from index.js for module use.

const MAX_TEXT = 500;

const TOOL_SHORT = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  grep: "grep",
  find: "find",
  ls: "ls",
  web_search: "web_search",
  web_fetch: "web_fetch",
  browser: "browser",
  todo_write: "todo_write",
  pin_memory: "pin_memory",
  search_memory: "search_memory",
  subagent: "subagent",
  subagent_reply: "subagent_reply",
  subagent_close: "subagent_close",
  workflow: "workflow",
  notify: "notify",
  cron: "cron",
  stage_files: "stage_files",
  install_skill: "install_skill",
  computer: "computer",
  terminal: "terminal",
  current_status: "current_status",
};

const TOOL_CATEGORY = {
  read: "文件探索", find: "文件探索", grep: "文件探索", ls: "文件探索",
  write: "代码编写", edit: "代码编写", bash: "代码编写", terminal: "终端操作",
  web_search: "网络研究", web_fetch: "网络研究", browser: "网络研究",
  todo_write: "任务编排", subagent: "任务编排", subagent_reply: "任务编排", subagent_close: "任务编排", workflow: "任务编排",
  pin_memory: "记忆操作", search_memory: "记忆操作",
  stage_files: "文件交付", install_skill: "技能管理",
  computer: "桌面控制", notify: "通知", current_status: "状态查询",
};

export function toolCategory(name) {
  return TOOL_CATEGORY[name] || "其他";
}

export function safeText(value, max = MAX_TEXT) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeToolName(name) {
  if (!name) return null;
  const text = String(name);
  return TOOL_SHORT[text] || text.replace(/^(hanako-runtime-learner_|runtime-learner_)/, "");
}

import crypto from "crypto";

export function shortHash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 8);
}

export function preferencePatternId(text) {
  return `pref:${String(text || "").slice(0, 80)}:${shortHash(text)}`;
}

export function stableKey(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}

// A usage entry is a failure only when it carries an error, or its status is an
// explicit failure word. The previous whitelist approach (anything not in
// {success, ok, completed, complete}) misclassified benign statuses like
// "succeeded", "stopped" or "finished" as failures and spawned phantom
// usage:failed_request patterns.
const FAILURE_STATUSES = new Set([
  "error", "failed", "failure", "cancelled", "canceled",
  "timeout", "timed_out", "aborted", "rejected", "incomplete",
]);

export function isUsageFailure(entry = {}) {
  if (entry.error) return true;
  const status = String(entry.status || "").toLowerCase();
  return FAILURE_STATUSES.has(status);
}

// ── Task & error classification constants ──

export const TASK_SIGS = {
  file_management: { tools: ["read", "write", "edit", "find", "grep", "ls"], min: 1 },
  coding: { tools: ["bash", "write", "edit", "grep"], min: 2 },
  document_processing: { tools: ["read", "write"], min: 1 },
  research: { tools: ["web_search", "web_fetch", "browser"], min: 1 },
  planning: { tools: ["todo_write", "subagent", "workflow"], min: 1 },
};

export const ERR_PATTERNS = {
  file_not_found: [/ENOENT/i, /no such file/i, /file not found/i, /cannot find/i],
  permission_denied: [/EACCES/i, /permission denied/i, /access is denied/i, /not permitted/i],
  network_error: [/ECONNREFUSED/i, /ETIMEDOUT/i, /fetch failed/i, /network/i, /timed out/i],
  auth_error: [/401/i, /403/i, /unauthorized/i, /invalid api key/i],
  model_error: [/context length/i, /token limit/i, /stopReason=length/i],
  command_not_found: [/command not found/i, /not recognized/i, /is not recognized/i, /cmdlet/i],
  syntax_error: [/syntax error/i, /unexpected token/i, /unexpected EOF/i, /parse error/i],
  path_error: [/cannot find the path/i, /path does not exist/i, /no such file or directory/i],
  tool_error: [/failed/i, /error/i, /exit code [1-9]/i, /exited with code/i],
};

// Tier 1: strong signals — single match is enough
export const CORRECTION_STRONG = [
  /(?:不对|错了|不应该|不要这样|别这样|纠正|按我说的)/i,
  /(?:wrong|incorrect|should have|should not have)/i,
];
// Tier 2: weak signals — need ≥2 co-occurring to count as correction
export const CORRECTION_WEAK = [
  /改成/i, /以后/i, /下次/i, /记住/i, /应该/i, /默认/i,
  /actually/i, /remember/i, /next time/i, /don't/i, /do not/i, /instead/i,
];

// ── Classification functions ──

export function classifyTask(tools) {
  let best = "general";
  let bestScore = 0;
  for (const [type, sig] of Object.entries(TASK_SIGS)) {
    const matches = tools.filter((tool) => sig.tools.includes(tool)).length;
    if (matches >= sig.min && matches > bestScore) {
      best = type;
      bestScore = matches;
    }
  }
  return best;
}

export function classifyError(msg) {
  for (const [type, patterns] of Object.entries(ERR_PATTERNS)) {
    if (patterns.some((p) => p.test(msg))) return type;
  }
  return "unknown";
}

// Sanitize a snippet returned by the external advisor model before it is stored
// in a pattern's `fix` and injected into SKILL.md. Strips code fences, markdown
// headings and obvious role/prompt markers, collapses whitespace, and caps
// length, so a hijacked endpoint cannot smuggle instructions into the agent's
// context. Shared by the plugin runtime (index.js) and the manual control tool.
export function sanitizeAdvice(text, max = 200) {
  let s = String(text || "");
  if (!s) return "";
  s = s.replace(/```[\s\S]*?```/g, " ")              // fenced code blocks
       .replace(/^\s*#{1,6}\s+/gm, "")                // markdown headings
       .replace(/^\s*(system|assistant|user)\s*:/gim, "") // role markers
       .replace(/[`*_>#]/g, "")                       // markdown control chars
       .replace(/\s+/g, " ")
       .trim();
  return s.slice(0, max);
}

// Interrogative cues — a sentence asking a question is not a correction even if
// it happens to contain weak cue words (e.g. "应该用默认配置吗?"). Strong signals
// still win regardless, since "为什么不对?" is a genuine correction.
// Match anywhere in the text, not just at the end, to catch trailing explanatory
// clauses (e.g. "为什么不对呢，你解释一下").
const QUESTION_CUES = [/[?？]/, /(?:吗|呢|吧)[?？]?\s*(?:[，,。.])/];

export function extractCorrectionFromUserText(text) {
  // Detection scans a wider window (1000 chars) so weak signals spread across
  // several concatenated user messages are still seen together — the 300-char
  // cap used to truncate the join and silently drop later signals. The stored
  // correction itself is kept to 300 chars to bound the persisted preference.
  const scan = safeText(text, 1000);
  if (!scan) return "";
  const stored = scan.slice(0, 300);
  // Tier 1: any strong signal is sufficient
  if (CORRECTION_STRONG.some((p) => p.test(scan))) return stored;
  // Tier 2: need ≥2 weak signals co-occurring — but skip pure questions, which
  // are a common false-positive source and shouldn't be stored as preferences.
  const weakHits = CORRECTION_WEAK.filter((p) => p.test(scan)).length;
  if (weakHits >= 2 && !QUESTION_CUES.some((p) => p.test(scan))) return stored;
  return "";
}
