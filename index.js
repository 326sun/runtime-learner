/**
 * Runtime Self-Learning plugin for Hanako.
 *
 * Three layers:
 * 1. Observe: capture real Hanako runtime events per session.
 * 2. Learn: detect repeated workflows, errors, and explicit user corrections.
 * 3. Inject: update this plugin's self-learning skill with conservative hints.
 *
 * v0.6.0: Added activity log for user-visible learning timeline.
 */

import fs from "fs";
import path from "path";
import { DEFAULT_CONFIG, learnerDir, readJson, writeJson, decayedScore, patternStatus, isInjectable, describeOfficialUtilityModel, countJsonl, memoryStrength, buildSkillMdFromPatterns } from "./lib/common.js";
import { definePlugin } from "./lib/hana-runtime-compat.js";
import { readModelAdvice, runModelAdvisor } from "./lib/model-advisor.js";
import { applyProposal, buildCodePatchProposal, buildSkillPatchProposal } from "./lib/proposals.js";

const DATA_DIR = learnerDir();
const EXPERIENCE_LOG = path.join(DATA_DIR, "experience_log.jsonl");
const ERROR_LOG = path.join(DATA_DIR, "error_log.jsonl");
const USAGE_SUMMARY_FILE = path.join(DATA_DIR, "usage_summary.json");
const CAPABILITIES_FILE = path.join(DATA_DIR, "host_capabilities.json");
const PATTERNS_FILE = path.join(DATA_DIR, "patterns.json");
const TURNS_FILE = path.join(DATA_DIR, "turns.jsonl");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const ACTIVITY_LOG = path.join(DATA_DIR, "activity_log.jsonl");
const HISTORY_DIR = path.join(DATA_DIR, "skill_history");
const MAX_SESSIONS = 64;
const MAX_TEXT = 500;
const SKILL_REFRESH_MIN_MS = 10_000;
const MAX_SKILL_HISTORY = 20;
const MAX_ACTIVITY_ENTRIES = 500;
const LOG_RETENTION_DAYS = 30;
const MAX_PATTERN_COUNT = 50;
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — skip prune for small files
const CODE_PROPOSAL_MIN_COUNT = 3;

const runtimeState = {
  detector: null,
  sessions: null,
  unsub: null,
  persistPatterns: null,
  refreshSkill: null,
  statusNotifiedAt: new Map(),
  advisorSkipReasons: new Map(),
  proposalNotifiedIds: new Set(),
  sessionStart: null,
  sessionActivityCount: 0,
  pendingAdoptionChecks: new Map(), // sessionPath → { searches: [{patternId, tools}], remaining: 3 }
};

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

// Tool categories for semantic pattern detection
const TOOL_CATEGORY = {
  read: "文件探索", find: "文件探索", grep: "文件探索", ls: "文件探索",
  write: "代码编写", edit: "代码编写", bash: "代码编写", terminal: "终端操作",
  web_search: "网络研究", web_fetch: "网络研究", browser: "网络研究",
  todo_write: "任务编排", subagent: "任务编排", subagent_reply: "任务编排", subagent_close: "任务编排", workflow: "任务编排",
  pin_memory: "记忆操作", search_memory: "记忆操作",
  stage_files: "文件交付", install_skill: "技能管理",
  computer: "桌面控制", notify: "通知", current_status: "状态查询",
};

function toolCategory(name) {
  return TOOL_CATEGORY[name] || "其他";
}

const TASK_SIGS = {
  file_management: { tools: ["read", "write", "edit", "find", "grep", "ls"], min: 1 },
  coding: { tools: ["bash", "write", "edit", "grep"], min: 2 },
  document_processing: { tools: ["read", "write"], min: 1 },
  research: { tools: ["web_search", "web_fetch", "browser"], min: 1 },
  planning: { tools: ["todo_write", "subagent", "workflow"], min: 1 },
};

const ERR_PATTERNS = {
  file_not_found: [/ENOENT/i, /no such file/i, /file not found/i],
  permission_denied: [/EACCES/i, /permission denied/i, /access is denied/i],
  network_error: [/ECONNREFUSED/i, /ETIMEDOUT/i, /fetch failed/i, /network/i],
  auth_error: [/401/i, /403/i, /unauthorized/i, /invalid api key/i],
  model_error: [/context length/i, /token limit/i, /stopReason=length/i],
  tool_error: [/failed/i, /error/i],
};

const CORRECTION_PATTERNS = [
  /(?:不对|错了|不应该|不要这样|别这样|改成|纠正|按我说的|应该|以后|下次|记住)/i,
  /(?:wrong|incorrect|actually|remember|next time|do not|don't|should have)/i,
];

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "proposals"), { recursive: true });
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf-8");
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {}
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  return { ...DEFAULT_CONFIG };
}

function safeText(value, max = MAX_TEXT) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeToolName(name) {
  if (!name) return null;
  const text = String(name);
  return TOOL_SHORT[text] || text.replace(/^(hanako-runtime-learner_|runtime-learner_)/, "");
}

function classifyTask(tools) {
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

function classifyError(msg) {
  for (const [type, patterns] of Object.entries(ERR_PATTERNS)) {
    if (patterns.some((p) => p.test(msg))) return type;
  }
  return "unknown";
}

function usageModelKey(entry = {}) {
  const provider = entry.model?.provider || "unknown";
  const modelId = entry.model?.modelId || "unknown";
  return `${provider}/${modelId}`;
}

function usageTotalTokens(entry = {}) {
  const total = entry.usage?.totalTokens;
  if (Number.isFinite(total)) return total;
  const input = entry.usage?.input?.totalTokens;
  const output = entry.usage?.output?.totalTokens;
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

function stableKey(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}

function isUsageFailure(entry = {}) {
  const status = String(entry.status || "").toLowerCase();
  return !!(entry.error || (status && status !== "unknown" && !["success", "ok", "completed", "complete"].includes(status)));
}

function summarizeUsageEntry(entry = {}, sessionPath = null) {
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

function updateUsageSummary(summaryEntry) {
  const summary = readJson(USAGE_SUMMARY_FILE, {
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
  writeJson(USAGE_SUMMARY_FILE, summary);
  return summary;
}

function snapshotHostCapabilities(ctx) {
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
  writeJson(CAPABILITIES_FILE, counts);
  return counts;
}

/* ── Activity Log for user-visible learning timeline ── */

function logActivity(event) {
  const entry = {
    date: new Date().toISOString(),
    sessionPath: event.sessionPath || null,
    type: event.type || "unknown",
    summary: event.summary || "",
    detail: event.detail || null,
  };
  try {
    appendJsonl(ACTIVITY_LOG, entry);
    pruneActivityLog();
  } catch {}
}

function pruneActivityLog() {
  try {
    if (!fs.existsSync(ACTIVITY_LOG)) return;
    const lines = fs.readFileSync(ACTIVITY_LOG, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length > MAX_ACTIVITY_ENTRIES) {
      fs.writeFileSync(ACTIVITY_LOG, lines.slice(-MAX_ACTIVITY_ENTRIES).join("\n") + "\n", "utf-8");
    }
  } catch {}
}

// Prune log files on a 5-minute interval, not on every flush
let lastPruneTs = 0;
function pruneDataFiles() {
  const now = Date.now();
  if (now - lastPruneTs < 300_000) return;
  lastPruneTs = now;
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;

  // Prune JSONL files: drop lines older than retention window
  const logFiles = [EXPERIENCE_LOG, TURNS_FILE, ERROR_LOG, ACTIVITY_LOG];
  for (const file of logFiles) {
    try {
      if (!fs.existsSync(file)) continue;
      // Skip small files: prune only when > 10 MB to avoid unnecessary IO
      if (fs.statSync(file).size <= MAX_LOG_SIZE_BYTES) continue;
      const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
      const kept = [];
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (!row.date || new Date(row.date).getTime() >= cutoff) kept.push(line);
        } catch { kept.push(line); } // Keep unparseable lines
      }
      if (kept.length < lines.length) {
        fs.writeFileSync(file, kept.join("\n") + "\n", "utf-8");
      }
    } catch {}
  }

  // Clean patterns.json: forgetting-curve based retention
  try {
    if (!fs.existsSync(PATTERNS_FILE)) return;
    let all = JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf-8"));
    if (!Array.isArray(all)) return;
    const config = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const strengthThreshold = 1.5; // Below this and not approved → forget

    // Downgrade stale auto-approved preference patterns: they must earn
    // permanence through search hits or adoption. Without interaction,
    // they fall back to the forgetting curve.
    // ── Preferences: archival tier, not subject to forgetting curve ──
    // Kept permanently but capped by count (latest wins).
    const MAX_PREFERENCES = 20;
    const prefs = all.filter(p => p.type === "preference");
    const nonPrefs = all.filter(p => p.type !== "preference");
    if (prefs.length > MAX_PREFERENCES) {
      prefs.sort((a, b) => (b.firstSeen || b.date || "").localeCompare(a.firstSeen || a.date || ""));
      prefs.splice(MAX_PREFERENCES);
    }

    // ── Core patterns: forgetting-curve based retention ──
    let core = nonPrefs.filter(p => {
      if (p.status === "approved") return true;
      if (p.type === "capability" || p.type === "host_capability") return false;
      if (p.id?.startsWith("usage_large")) return false;
      const ms = memoryStrength(p, config);
      return ms >= strengthThreshold;
    });

    // Cap total count: keep top N by memory strength
    if (core.length > MAX_PATTERN_COUNT) {
      core.sort((a, b) => (memoryStrength(b, config) || 0) - (memoryStrength(a, config) || 0));
      core = core.slice(0, MAX_PATTERN_COUNT);
    }

    all = [...core, ...prefs];
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(all, null, 2), "utf-8");
  } catch {}
}

function readRecentActivity(days = 1) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = [];
  try {
    if (!fs.existsSync(ACTIVITY_LOG)) return rows;
    for (const line of fs.readFileSync(ACTIVITY_LOG, "utf-8").trim().split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (new Date(row.date).getTime() >= cutoff) rows.push(row);
      } catch {}
    }
  } catch {}
  return rows.reverse();
}

/* ── SessionTurn, PatternDetector, skill builder ── */

class SessionTurn {
  constructor(sessionPath) {
    this.sessionPath = sessionPath || "unknown";
    this.startedAt = new Date().toISOString();
    this.lastTouched = Date.now();
    this.tools = [];
    this.pendingTools = new Map();
    this.toolCallCount = 0;
    this.errors = [];
    this.userTexts = [];
    this.assistantText = "";
    this.stopReason = null;
  }

  touch() {
    this.lastTouched = Date.now();
  }

  addTool(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    this.tools.push(name);
    this.toolCallCount += 1;
    this.touch();
  }

  markToolStart(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    this.addTool(name);
    this.pendingTools.set(name, (this.pendingTools.get(name) || 0) + 1);
  }

  markToolEnd(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    const pending = this.pendingTools.get(name) || 0;
    if (pending > 0) {
      if (pending === 1) this.pendingTools.delete(name);
      else this.pendingTools.set(name, pending - 1);
      this.touch();
      return;
    }
    this.addTool(name);
  }

  addError(message) {
    const text = safeText(message);
    if (text) this.errors.push(text);
    this.touch();
  }

  addUserText(text) {
    const clean = safeText(text, 300);
    if (clean) this.userTexts.push(clean);
    this.touch();
  }
}

class PatternDetector {
  constructor(config) {
    this.config = config;
    this.patterns = new Map();
    this.seqCache = new Map();
    this.seqInsertOrder = [];
    this.turnCount = 0;
  }

  setConfig(config) {
    this.config = config;
  }

  restore(saved) {
    for (const pattern of saved || []) {
      if (!pattern?.id) continue;
      this.patterns.set(pattern.id, pattern);
      if (pattern.type === "workflow" && Array.isArray(pattern.tools)) {
        // Derive category key from stored tools for seqCache restoration
        const cats = pattern.tools.map(t => toolCategory(normalizeToolName(t)));
        const uniqueCats = [...new Set(cats)];
        if (uniqueCats.length >= 2) {
          const key = uniqueCats.join("→");
          this.seqCache.set(key, pattern.count || 1);
          if (!this.seqInsertOrder.includes(key)) this.seqInsertOrder.push(key);
        }
      }
    }
    while (this.seqInsertOrder.length > MAX_PATTERN_COUNT) {
      this.seqCache.delete(this.seqInsertOrder.shift());
    }
  }

  ingest(exp) {
    this.turnCount += 1;
    const newPatterns = [];

    // Workflow detection: category-level, skip single-category chains
    if (exp.toolsUsed.length >= 2) {
      const cats = exp.toolsUsed.map(t => toolCategory(normalizeToolName(t)));
      const uniqueCats = [...new Set(cats)];
      if (uniqueCats.length >= 2) {
        const catKey = uniqueCats.join("→");
        const toolKey = exp.toolsUsed.join("->");
        const count = (this.seqCache.get(catKey) || 0) + 1;
        this.seqCache.set(catKey, count);
        if (!this.seqInsertOrder.includes(catKey)) {
          this.seqInsertOrder.push(catKey);
          while (this.seqInsertOrder.length > MAX_PATTERN_COUNT) {
            this.seqCache.delete(this.seqInsertOrder.shift());
          }
        }
        if (count >= 3) {
          const pid = `workflow:${catKey}`;
          const desc = `跨类别工作流: ${catKey}`;
          const existing = this.patterns.get(pid);
          const hint = `This ${uniqueCats.join(" → ")} sequence repeats across sessions. Consider whether these steps can be automated or consolidated.`;
          const ctx = {
            taskType: exp.taskType || "general",
            tools: [...exp.toolsUsed],
            categories: uniqueCats,
          };
          if (existing) {
            const wasBelow = existing.count < 3;
            existing.count = count;
            existing.lastSeen = exp.date;
            existing.score = Math.max(existing.score || 0, count * 3);
            existing.tools = [...new Set([...(existing.tools || []), ...exp.toolsUsed])];
            existing.context = { ...existing.context, ...ctx, taskType: [...new Set([...(existing.context?.taskType ? [existing.context.taskType] : []), ctx.taskType])].join(",") };
            if (wasBelow) newPatterns.push({ id: pid, type: "workflow", desc, count });
          } else {
            this.patterns.set(pid, {
              id: pid, type: "workflow", status: "pending",
              desc, count, context: ctx,
              firstSeen: exp.date, lastSeen: exp.date,
              score: count * 3, tools: [...exp.toolsUsed],
              fix: hint,
            });
          }
        }
      }
    }

    if (exp.correction) {
      const ck = `pref:${exp.correction.slice(0, 80)}`;
      const existing = this.patterns.get(ck);
      if (!existing) {
        newPatterns.push({ id: ck, type: "preference", desc: `User correction: ${exp.correction}` });
      }
      if (existing) {
        existing.count += 1;
        existing.lastSeen = exp.date;
        existing.score += 3;
        existing.tools = [...new Set([...(existing.tools || []), ...(exp.toolsUsed || [])])];
        if (!existing.context) existing.context = { taskType: exp.taskType || "general" };
      } else {
        this.patterns.set(ck, {
          id: ck,
          type: "preference",
          status: "pending",
          desc: `User correction: ${exp.correction}`,
          count: 1,
          firstSeen: exp.date,
          lastSeen: exp.date,
          score: 6,
          tools: exp.toolsUsed || [],
          context: { taskType: exp.taskType || "general" },
          fix: exp.correction,
        });
      }
    }

    // Build knowledge-tree relations only when new patterns emerge
    if (newPatterns.length > 0 || exp.correction) {
      this._linkRelations(exp);
    }

    return newPatterns;
  }

  _linkRelations(exp) {
    const activeCats = [...new Set((exp.toolsUsed || []).map(t => toolCategory(normalizeToolName(t))))];
    const activeTask = exp.taskType || "general";
    if (activeCats.length < 2 && activeTask === "general") return;

    // Find the IDs of patterns that were just created or updated in this ingest call
    const targets = [];
    if (activeCats.length >= 2) {
      const catKey = activeCats.join("→");
      targets.push(`workflow:${catKey}`);
    }
    if (exp.correction) {
      targets.push(`pref:${exp.correction.slice(0, 80)}`);
    }

    for (const targetId of targets) {
      const target = this.patterns.get(targetId);
      if (!target) continue;
      target.context = target.context || {};
      const rels = target.context.relations || [];

      for (const [id, stored] of this.patterns) {
        if (id === targetId) continue;
        if (stored.type === "capability" || stored.type === "host_capability") continue;

        const storedCats = new Set(stored.context?.categories || []);
        const catOverlap = activeCats.filter(c => storedCats.has(c)).length;
        const taskMatch = activeTask !== "general" && (stored.context?.taskType || "general") === activeTask;

        let type = null, weight = 0;
        if (catOverlap >= 3) { type = "strong-related"; weight = catOverlap * 1.0; }
        else if (catOverlap >= 2) { type = "shared-tools"; weight = catOverlap * 0.5; }
        else if (taskMatch) { type = "same-task"; weight = 0.3; }
        else if (catOverlap >= 1 && exp.correction) { type = "co-occurred"; weight = 0.2; }
        if (!type) continue;

        const exists = rels.find(r => r.targetId === id);
        if (exists) { exists.weight = Math.max(exists.weight, weight); }
        else { rels.push({ targetId: id, type, weight }); }
      }

      if (rels.length > 8) rels.splice(0, rels.length - 8);
      target.context.relations = rels;
    }
  }

  ingestError(err) {
    const ek = `error:${err.errorType}`;
    const existing = this.patterns.get(ek);
    const inc = Math.max(1, err.severity || 1);
    const isNew = !existing;
    if (existing) {
      existing.count += 1;
      existing.lastSeen = err.date;
      existing.score += inc;
      if (err.candidateSkill && !existing.fix) existing.fix = err.candidateSkill;
      return { pattern: existing, isNew: false };
    }
    const pattern = {
      id: ek,
      type: "error",
      status: "pending",
      desc: `Repeated error: ${err.errorType} - ${err.errorDesc}`,
      count: 1,
      firstSeen: err.date,
      lastSeen: err.date,
      score: inc,
      tools: err.tool ? [err.tool] : [],
      fix: err.candidateSkill || "Check this failure mode before retrying the same action.",
    };
    this.patterns.set(ek, pattern);
    return { pattern, isNew: true };
  }

  ingestUsage(entry = {}) {
    const patterns = [];
    const now = entry.date || new Date().toISOString();
    const model = stableKey(entry.model);
    const operation = stableKey(entry.operation || entry.subsystem);
    const totalTokens = Number(entry.totalTokens || 0);
    const threshold = Number(this.config?.largeUsageTokenThreshold || DEFAULT_CONFIG.largeUsageTokenThreshold);

    if (totalTokens >= threshold) {
      patterns.push({
        id: `usage:large_context:${model}`,
        type: "usage",
        desc: `Large context usage on ${entry.model}: ${totalTokens} tokens`,
        fix: `Before using ${entry.model} for similar work, search prior context and compact inputs; split large jobs when possible.`,
        score: Math.max(4, Math.min(20, Math.round(totalTokens / Math.max(1, threshold)) * 4)),
        context: { taskType: "usage", model: entry.model, operation: entry.operation, subsystem: entry.subsystem },
      });
    }

    if (isUsageFailure(entry)) {
      patterns.push({
        id: `usage:failed_request:${model}:${operation}`,
        type: "usage",
        desc: `Model request failure on ${entry.model}/${entry.operation || entry.subsystem || "unknown"}`,
        fix: entry.error
          ? `This request path has failed before: ${entry.error}. Check provider health, auth, and request size before retrying.`
          : "This request path has failed before. Check provider health, auth, and request size before retrying.",
        score: 3,
        context: { taskType: "usage", model: entry.model, operation: entry.operation, subsystem: entry.subsystem },
      });
    }

    const changed = [];
    for (const pattern of patterns) {
      const existing = this.patterns.get(pattern.id);
      if (existing) {
        existing.count += 1;
        existing.lastSeen = now;
        existing.score = Math.max(existing.score || 0, 0) + pattern.score;
        existing.desc = pattern.desc;
        existing.fix = pattern.fix;
        existing.context = { ...(existing.context || {}), ...(pattern.context || {}) };
        changed.push({ pattern: existing, isNew: false });
      } else {
        const next = {
          ...pattern,
          status: "pending",
          count: 1,
          firstSeen: now,
          lastSeen: now,
        };
        this.patterns.set(pattern.id, next);
        changed.push({ pattern: next, isNew: true });
      }
    }
    return changed;
  }
  ingestCapabilitySnapshot() {}

  all() {
    return [...this.patterns.values()]
      .filter(pattern => {
        // Skip old single-tool workflow chains (pre-category migration)
        if (pattern.type === "workflow" && Array.isArray(pattern.tools) && pattern.tools.length >= 2) {
          if (new Set(pattern.tools).size === 1) return false;
        }
        // Skip generic noise
        if (pattern.type === "capability" || pattern.type === "host_capability") return false;
        if (pattern.id?.startsWith("usage_large")) return false;
        return true;
      })
      .map((pattern) => ({
        ...pattern,
        status: patternStatus(pattern),
        decayedScore: Number(decayedScore(pattern, this.config).toFixed(2)),
        injectable: isInjectable(pattern, this.config),
      }))
      .sort((a, b) => (b.decayedScore || 0) - (a.decayedScore || 0));
  }

  highConfidence() {
    return this.all().filter((p) => p.injectable).slice(0, 8);
  }

  prefs() {
    return this.all().filter((p) => p.type === "preference" && p.fix && p.injectable).slice(0, 8);
  }
}

function buildSkillMd(detector, config) {
  return buildSkillMdFromPatterns(detector.all(), config, {
    turnCount: detector.turnCount,
    dataDir: DATA_DIR,
  });
}

/* ── Plugin lifecycle ── */

export default definePlugin({
  async onload(ctx, { register }) {
    try {
    ensureDir();

    let config = loadConfig();
    const seenRequestIds = new Set();
    const detector = new PatternDetector(config);

    // One-time migration: any previously auto-approved preferences are
    // now archival-only. Downgrade them to pending so the label matches
    // the new three-tier semantics.
    try {
      const patterns = readJson(PATTERNS_FILE, []);
      let migrated = 0;
      for (const p of patterns) {
        if (p.type === "preference" && p.status === "approved") {
          p.status = "pending";
          p.reviewedAt = null;
          migrated += 1;
        }
      }
      if (migrated > 0) {
        writeJson(PATTERNS_FILE, patterns);
        ctx.log.info(`runtime-learner: migrated ${migrated} approved preferences to pending`);
      }
    } catch {}

    const sessions = new Map();
    let lastSkillRefresh = 0;
    runtimeState.sessionStart = new Date().toISOString();
    runtimeState.sessionActivityCount = 0;

    const persistPatterns = () => {
      // Merge disk status before writing: control.js may have approved/rejected patterns
      const mem = detector.all();
      const disk = readJson(PATTERNS_FILE, []);
      if (disk.length > 0) {
        const diskStatus = new Map(disk.filter(p => p.id).map(p => [p.id, p.status]));
        for (const m of mem) {
          const ds = diskStatus.get(m.id);
          if (ds === "approved" || ds === "rejected") m.status = ds;
        }
      }
      fs.writeFileSync(PATTERNS_FILE, JSON.stringify(mem, null, 2), "utf-8");
    };

    const snapshotSkill = (skillPath) => {
      if (!fs.existsSync(skillPath)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(skillPath, path.join(HISTORY_DIR, `${stamp}-SKILL.md`));
      const entries = fs.readdirSync(HISTORY_DIR)
        .filter((name) => name.endsWith("-SKILL.md"))
        .sort();
      for (const old of entries.slice(0, Math.max(0, entries.length - MAX_SKILL_HISTORY))) {
        fs.rmSync(path.join(HISTORY_DIR, old), { force: true });
      }
    };

    const canSendSessionMessage = () => {
      if (!ctx.bus?.request) return false;
      const capability = ctx.bus.getCapability?.("session:send");
      if (capability && capability.available === false) return false;
      if (!capability && !ctx.bus.hasHandler?.("session:send")) return false;
      return true;
    };

    const sendSessionMessage = async (sessionPath, text) => {
      if (!sessionPath || !text || !canSendSessionMessage()) return false;
      try {
        await ctx.bus.request("session:send", { sessionPath, text });
        return true;
      } catch (err) {
        ctx.log.debug?.(`runtime-learner: session message skipped: ${err.message}`);
        return false;
      }
    };

    const formatProposalNotification = (proposal) => [
      "Runtime Self-Learning 发现一个可改进点，需要你决定是否应用：",
      "",
      `提案 ID: ${proposal.id}`,
      `风险: ${proposal.risk || "unknown"}`,
      `类型: ${proposal.type || "unknown"}`,
      `标题: ${proposal.title || proposal.reason || "Untitled proposal"}`,
      "",
      "回复“查看提案 <ID>”可以看详情；回复“应用提案 <ID>”或“拒绝提案 <ID>”让我处理。",
      "说明：code_patch 不会由插件自动写入代码，应用它表示让我按提案修改文件、测试并安装。",
    ].join("\n");

    const notifyProposalReview = async (sessionPath, proposals = []) => {
      if (!config.proposalChatNotificationsEnabled || !sessionPath || proposals.length === 0) return;
      for (const proposal of proposals) {
        if (!proposal?.id || runtimeState.proposalNotifiedIds.has(proposal.id)) continue;
        const sent = await sendSessionMessage(sessionPath, formatProposalNotification(proposal));
        if (sent) runtimeState.proposalNotifiedIds.add(proposal.id);
      }
    };

    const maybeProposeCodeImprovements = (patterns = detector.all(), sessionPath = null) => {
      let created = 0;
      const createdProposals = [];
      for (const pattern of patterns) {
        if (!["error", "usage"].includes(pattern.type)) continue;
        if ((pattern.count || 0) < CODE_PROPOSAL_MIN_COUNT) continue;
        const proposal = buildCodePatchProposal({ learnerDir: DATA_DIR, pattern });
        if (proposal.status === "pending" && proposal.createdAt === proposal.updatedAt) {
          created += 1;
          createdProposals.push(proposal);
        }
      }
      if (created > 0) {
        logActivity({
          type: "proposal_created",
          summary: `Created ${created} high-risk code improvement proposal(s) for review`,
          sessionPath,
        });
        void notifyProposalReview(sessionPath, createdProposals);
      }
      return created;
    };

    const refreshSkill = (force = false, sessionPath = null) => {
      const now = Date.now();
      if (!force && now - lastSkillRefresh < SKILL_REFRESH_MIN_MS) return;
      const skillDir = path.join(ctx.pluginDir, "skills", "self-learning");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      snapshotSkill(skillPath);
      const content = buildSkillMd(detector, config);
      const triggerPatternIds = detector.highConfidence().map((pattern) => pattern.id);
      const proposal = buildSkillPatchProposal({
        learnerDir: DATA_DIR,
        skillPath,
        content,
        triggerPatternIds,
      });
      if (proposal.autoApply && proposal.status !== "applied") {
        applyProposal(DATA_DIR, proposal.id, { configPath: CONFIG_FILE });
      }
      maybeProposeCodeImprovements(undefined, sessionPath);
      lastSkillRefresh = now;
    };

    const notifyWorkStatus = async (sessionPath, detail = "") => {
      if (!config.workStatusEnabled || !sessionPath) return;
      const now = Date.now();
      const last = runtimeState.statusNotifiedAt.get(sessionPath) || 0;
      if (now - last < 30 * 60_000) return;
      if (!ctx.bus?.request) return;
      const capability = ctx.bus.getCapability?.("session:send");
      if (capability && capability.available === false) return;
      if (!capability && !ctx.bus.hasHandler?.("session:send")) return;
      const text = `${config.workStatusText || "正在自我整理学习"}${detail ? `：${detail}` : ""}`;
      try {
        await ctx.bus.request("session:send", { sessionPath, text });
        runtimeState.statusNotifiedAt.set(sessionPath, now);
      } catch (err) {
        ctx.log.debug?.(`runtime-learner: work status skipped: ${err.message}`);
      }
    };

    const _cachedAdvisorSkip = (reason) => {
      const key = reason || "unknown";
      if (runtimeState.advisorSkipReasons.get(key) === reason) return true;
      runtimeState.advisorSkipReasons.set(key, reason);
      return false;
    };

    const maybeRunModelAdvisor = async (reason, sessionPath = null) => {
      if (!config.modelAdvisorEnabled) return;
      try {
        const result = await runModelAdvisor({
          config,
          patterns: detector.all(),
          usage: readJson(USAGE_SUMMARY_FILE, null),
          capabilities: readJson(CAPABILITIES_FILE, null),
          reason,
        });
        if (result.ok) {
          refreshSkill(true, sessionPath);
          const count = result.advice?.suggestions?.length || 0;
          if (count > 0) {
            logActivity({
              type: "model_advisor",
              summary: `Model advisor generated ${count} suggestions (source: ${result.advice?.source || "unknown"})`,
              detail: result.advice?.suggestions?.slice(0, 3).map((s) => s.title).join(", ") || null,
              sessionPath,
            });
            runtimeState.sessionActivityCount += 1;
            ctx.log.info(`runtime-learner: model advisor generated ${count} suggestions`);
            // Merge advisor insights back into patterns — replaces raw user text with distilled knowledge
            let merged = 0;
            for (const s of result.advice.suggestions) {
              const stored = detector.patterns.get(s.patternId);
              if (stored && s.advice && s.advice !== stored.fix) {
                stored.fix = s.advice;
                stored.advisorUpdatedAt = new Date().toISOString();
                merged += 1;
              }
            }
            if (merged > 0) {
              ctx.log.info(`runtime-learner: merged ${merged} advisor insights into patterns`);
              refreshSkill(true, sessionPath);
            }
          }
          await notifyWorkStatus(sessionPath, count > 0 ? `已生成 ${count} 条候选建议` : "已完成");
        } else if (!_cachedAdvisorSkip(result.reason)) {
          ctx.log.info(`runtime-learner: model advisor skipped: ${result.reason}`);
        }
      } catch (err) {
        const key = err.message || "unknown";
        if (!_cachedAdvisorSkip(key)) {
          ctx.log.warn(`runtime-learner: model advisor skipped: ${err.message}`);
        }
      }
    };

    try {
      if (fs.existsSync(PATTERNS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf-8"));
        detector.restore(saved);
        ctx.log.info(`runtime-learner: restored ${saved.length} patterns`);
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: load failed: ${err.message}`);
    }

    try {
      const capabilities = snapshotHostCapabilities(ctx);
      detector.ingestCapabilitySnapshot?.(capabilities);
    } catch (err) {
      ctx.log.warn(`runtime-learner: capability snapshot skipped: ${err.message}`);
    }

    // Update token display in settings (called at startup and after each usage record)
    const updateTokenDisplay = () => {
      try {
        const patterns = detector.all();
        const injectable = patterns.filter((p) => p.injectable).length;
        const pending = patterns.filter((p) => p.status === "pending").length;
        const approved = patterns.filter((p) => p.status === "approved").length;

        // Runtime stats
        const expCount = countJsonl(EXPERIENCE_LOG);
        const errCount = countJsonl(ERROR_LOG);
        const actCount = countJsonl(ACTIVITY_LOG);
        const runtime = `跟踪 ${expCount} 轮对话 · ${patterns.length} 个模式 (${injectable} 可注入) · ${errCount} 个错误 · ${actCount} 条活动记录`;

        // Pattern details
        const byType = {};
        for (const p of patterns) byType[p.type] = (byType[p.type] || 0) + 1;
        const typeLines = Object.entries(byType).map(([t, c]) => `${t}: ${c}`).join('  |  ');
        const detail = `模式分布: ${typeLines || '无'}  |  待审核: ${pending}  |  已批准: ${approved}  |  本轮新增: ${runtimeState.sessionActivityCount}`;

        // Recently learned: show distilled knowledge (fix), not raw corrections
        let recentLearn = '暂无';
        try {
          const meaningful = patterns
            .filter(p => p.status !== 'rejected')
            .sort((a, b) => (b.decayedScore || 0) - (a.decayedScore || 0))
            .slice(0, 5);
          if (meaningful.length) {
            recentLearn = meaningful.map(p => {
              const icon = p.type === 'preference' ? '💬' : p.type === 'error' ? '⚠️' : '🔄';
          // Prefer advisor-distilled fix over raw desc; strip "User correction:" prefix from bare fixes
            const text = (p.fix && !p.fix.startsWith('User correction:')) ? p.fix
              : p.desc.replace(/^User correction: /, '');
              return `${icon} ${text.slice(0, 80)}`;
            }).join('\n');
          }
        } catch {}

        // Model advisor status
        const advice = readModelAdvice();
        const adviceState = readJson(path.join(DATA_DIR, "model_advice_state.json"), {});
        let advisorText = '未运行过';
        if (config.modelAdvisorSource === 'off') {
          advisorText = '已关闭';
        } else if (advice?.updatedAt) {
          const lastRun = new Date(advice.updatedAt).toLocaleString('zh-CN');
          const sCount = advice.suggestions?.length || 0;
          advisorText = `上次: ${lastRun}  ·  模型: ${advice.model || config.modelAdvisorModel || 'deepseek-v4-flash'}  ·  建议: ${sCount} 条`;
        } else if (adviceState?.lastRunAt) {
          const lastRun = new Date(adviceState.lastRunAt).toLocaleString('zh-CN');
          advisorText = `上次: ${lastRun}  ·  无新建议（模式暂无需整理）`;
        } else if (config.modelAdvisorEnabled) {
          advisorText = '已就绪，等待首次运行';
        }

        const updates = { tokenUsageSummary: runtime, learningStatsDetail: detail, modelAdvisorUsage: advisorText, recentLearnings: recentLearn, dataDirPath: DATA_DIR };
        try { ctx.config?.update?.(updates); } catch { try { for (const [k, v] of Object.entries(updates)) { try { ctx.config?.set?.(k, v); } catch {} } } catch {} }
      } catch {}
    };

    // ── Auto-approve: shared logic for all three call sites ──

    const autoApprovePatterns = (sessionPath = null) => {
      if (!config.autoApproveHighConfidence) return 0;
      const allPatterns = detector.all();
      let count = 0;
      for (const p of allPatterns) {
        // Preference patterns (user corrections, transient feedback) are
        // NOT auto-approved — they must earn permanence through manual
        // approval or repeated search/adoption. The forgetting curve
        // naturally prunes obsolete bug-fix corrections.
        if (p.status === "pending" && p.injectable && p.type !== "preference") {
          const stored = detector.patterns.get(p.id);
          if (stored && stored.status === "pending") {
            stored.status = "approved";
            stored.reviewedAt = new Date().toISOString();
            count += 1;
          }
        }
      }
      if (count > 0) {
        logActivity({
          type: "auto_approved",
          summary: `Auto-approved ${count} high-confidence pattern(s)`,
          sessionPath,
        });
        ctx.log.info(`runtime-learner: auto-approved ${count} pattern(s)`);
      }
      return count;
    };

    const recordUsage = (entry, sessionPath = null) => {
      if (!config.learnFromUsage) return;
      const summaryEntry = summarizeUsageEntry(entry, sessionPath);
      const dedupKey = summaryEntry.requestId;
      if (dedupKey && seenRequestIds.has(dedupKey)) return;
      if (dedupKey) seenRequestIds.add(dedupKey);
      try {
        updateUsageSummary(summaryEntry);
        updateTokenDisplay();
        const usageChanges = detector.ingestUsage?.(summaryEntry) || [];
        for (const change of usageChanges) {
          if (!change.isNew) continue;
          logActivity({
            type: "usage_pattern_discovered",
            summary: `New usage pattern: ${change.pattern.desc}`,
            sessionPath,
          });
          runtimeState.sessionActivityCount += 1;
        }
        autoApprovePatterns(sessionPath);
        persistPatterns();
        pruneDataFiles();
        refreshSkill(false, sessionPath);
        maybeRunModelAdvisor("usage", sessionPath);
      } catch (err) {
        ctx.log.warn(`runtime-learner: usage record skipped: ${err.message}`);
      }
    };

    try {
      const usageCapability = ctx.bus.getCapability?.("usage:list");
      if (config.learnFromUsage && (usageCapability?.available || ctx.bus.hasHandler?.("usage:list"))) {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const result = await ctx.bus.request("usage:list", { since, limit: 50 });
        for (const entry of result?.entries || []) recordUsage(entry, entry.attribution?.sessionPath || null);
        ctx.log.info(`runtime-learner: bootstrapped ${result?.entries?.length || 0} usage records`);
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: usage bootstrap skipped: ${err.message}`);
    }

    // ── Turn helpers (defined before flushTurn which references them) ──

    const resultStatus = (turn, stopReason) => {
      if (turn.errors.length > 0) return "partial";
      if (stopReason && stopReason !== "stop") return "partial";
      return "success";
    };

    const extractToolError = (event) => {
      const raw = event?.error || event?.result?.error || event?.result?.message || event?.message;
      const msg = typeof raw === "string" ? raw : raw?.message || "";
      const tool = normalizeToolName(event?.toolName || event?.name) || "tool";
      return msg ? `${tool}: ${safeText(msg)}` : `${tool}: failed`;
    };

    const messageText = (message) => {
      if (!message) return "";
      if (typeof message.content === "string") return safeText(message.content, 1000);
      if (typeof message.text === "string") return safeText(message.text, 1000);
      if (Array.isArray(message.content)) {
        return safeText(message.content.map((part) => part?.text || part?.content || "").join(" "), 1000);
      }
      return "";
    };

    const extractAssistantText = (event) => {
      return messageText(event?.message);
    };

    const extractCorrectionFromUserText = (text) => {
      const clean = safeText(text, 300);
      if (!clean) return "";
      return CORRECTION_PATTERNS.some((pattern) => pattern.test(clean)) ? clean : "";
    };

    // ── Turn lifecycle ──

    const getTurn = (sessionPath) => {
      const key = sessionPath || "unknown";
      let turn = sessions.get(key);
      if (!turn) {
        turn = new SessionTurn(key);
        sessions.set(key, turn);
      }
      if (sessions.size > MAX_SESSIONS) {
        const oldest = [...sessions.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched)[0];
        if (oldest) sessions.delete(oldest[0]);
      }
      return turn;
    };

    const flushTurn = (sessionPath, event = {}) => {
      const key = sessionPath || "unknown";
      const turn = sessions.get(key);
      if (!turn) return;

      const stopReason = event?.message?.stopReason ?? turn.stopReason ?? null;
      const finalError = safeText(event?.message?.errorMessage || event?.message?.error?.message || event?.error);
      if (finalError) turn.addError(finalError);
      turn.assistantText = extractAssistantText(event) || turn.assistantText;
      turn.stopReason = stopReason;

      if (turn.tools.length === 0 && turn.errors.length === 0 && !turn.assistantText) {
        sessions.delete(key);
        return;
      }

      const correction = turn.userTexts.map(extractCorrectionFromUserText).find(Boolean) || "";
      const tools = [...turn.tools];
      const date = new Date().toISOString();
      const taskId = `${path.basename(key)}:${Date.now()}`;
      const exp = {
        date,
        taskId,
        sessionPath: key,
        taskType: classifyTask(tools),
        project: "general",
        userIntent: turn.userTexts.at(-1) || "",
        taskSummary: tools.length ? `tools: ${tools.join(" -> ")}` : "assistant turn without tool use",
        toolsUsed: tools,
        toolCallCount: turn.toolCallCount,
        resultStatus: resultStatus(turn, stopReason),
        stopReason,
        userFeedback: correction ? "correction" : "unknown",
        userExplicitCorrection: !!correction,
        errorType: turn.errors.length ? classifyError(turn.errors[0]) : "none",
        failurePoint: turn.errors.length ? turn.errors[0] : "none",
        correction,
        impactLevel: turn.errors.length ? 2 : 1,
        repeatability: tools.length >= 2 ? "medium" : "low",
        oneOff: false,
        skillCandidate: false,
        suggestedSkill: null,
        notes: "",
      };

      try {
        appendJsonl(TURNS_FILE, { date, sessionPath: key, tools, errors: turn.errors, stopReason, correction });
        appendJsonl(EXPERIENCE_LOG, exp);
      } catch (err) {
        ctx.log.warn(`runtime-learner: write experience failed: ${err.message}`);
      }

      for (const errMsg of turn.errors) {
        const ee = {
          date,
          taskId,
          sessionPath: key,
          taskType: exp.taskType,
          errorType: classifyError(errMsg),
          errorDesc: safeText(errMsg, 200),
          severity: stopReason === "error" ? 4 : 2,
          tool: tools.at(-1) || null,
        };
        try {
          appendJsonl(ERROR_LOG, ee);
          const { isNew } = detector.ingestError(ee);
          if (isNew) {
            logActivity({
              type: "error_discovered",
              summary: `New error pattern: ${ee.errorType} — ${ee.errorDesc}`,
              sessionPath: key,
            });
            runtimeState.sessionActivityCount += 1;
          }
        } catch (err) {
          ctx.log.warn(`runtime-learner: write error failed: ${err.message}`);
        }
      }

      const newPatterns = detector.ingest(exp);
      for (const np of newPatterns) {
        logActivity({
          type: "pattern_discovered",
          summary: `New ${np.type} pattern: ${np.desc}`,
          sessionPath: key,
        });
        runtimeState.sessionActivityCount += 1;
        ctx.log.info(`runtime-learner: discovered ${np.type} pattern: ${np.desc}`);
      }

      // Record session-end activity summary when turning
      if (newPatterns.length > 0 || correction) {
        const parts = [];
        if (newPatterns.length > 0) parts.push(`${newPatterns.length} new pattern(s) detected`);
        if (correction) parts.push(`user correction captured`);
        logActivity({
          type: "turn_complete",
          summary: `Turn completed: ${tools.join(" -> ") || "no tools"}${parts.length ? ` — ${parts.join(", ")}` : ""}`,
          sessionPath: key,
          detail: newPatterns.map((p) => p.desc).join("; ") || null,
        });
      }

      try {
        // Refresh config from disk: control.js set_config may have updated it
        config = { ...config, ...readJson(CONFIG_FILE, {}) };
        detector.setConfig(config);
        autoApprovePatterns(key);
        persistPatterns();
        pruneDataFiles();
        refreshSkill(false, key);
        maybeRunModelAdvisor("turn", key);
      } catch (err) {
        ctx.log.warn(`runtime-learner: refresh failed: ${err.message}`);
      }

      // ── Adoption check: did the Agent use a searched workflow? ──
      const pending = runtimeState.pendingAdoptionChecks.get(key);
      if (pending) {
        pending.remaining -= 1;
        let adopted = 0;
        for (const s of pending.searches) {
          if (s.tools.length === 0) continue;
          const matchCount = s.tools.filter(t => tools.includes(t)).length;
          if (matchCount >= Math.ceil(s.tools.length * 0.5)) {
            const stored = detector.patterns.get(s.patternId);
            if (stored) {
              stored.score = (stored.score || 0) + 3;
              stored.lastAdoptedAt = new Date().toISOString();
              adopted += 1;
              ctx.log.info(`runtime-learner: adopted workflow ${s.patternId}, score +3`);
            }
          }
        }
        if (adopted > 0) {
          persistPatterns();
          refreshSkill(true, key);
        }
        if (pending.remaining <= 0) runtimeState.pendingAdoptionChecks.delete(key);
      }

      sessions.delete(key);
    };

    // ── Tool-end semantic handlers: registered by tool name ──
    const toolEndHandlers = new Map();

    // Feed official pin_memory into self-learning patterns
    toolEndHandlers.set("pin_memory", (event, sessionPath) => {
      try {
        const args = event.args || event.input || {};
        const content = typeof args.content === "string" ? args.content : JSON.stringify(args);
        if (content && content.length < 500) {
          const pexp = {
            date: new Date().toISOString(),
            taskType: "general",
            toolsUsed: ["pin_memory"],
            toolCallCount: 1,
            correction: content,
            resultStatus: "success",
            stopReason: null,
            errors: [],
          };
          detector.ingest(pexp);
          persistPatterns();
          refreshSkill(false, sessionPath);
          ctx.log.info("runtime-learner: ingested pin_memory as preference pattern");
        }
      } catch (err) {
        ctx.log.warn(`runtime-learner: pin_memory ingestion skipped: ${err.message}`);
      }
    });

    // Feedback loop: track self_learning_search results for adoption scoring
    toolEndHandlers.set("self_learning_search", (event, sessionPath) => {
      try {
        const raw = event.result;
        if (typeof raw !== "string") return;
        const parsed = JSON.parse(raw);
        const results = parsed.results || [];
        const ids = results.map(r => r.id).filter(Boolean);

        // Immediate feedback: record exposure only. Score changes require later adoption.
        if (ids.length > 0) {
          let touched = 0;
          for (const id of ids) {
            const stored = detector.patterns.get(id);
            if (stored) {
              stored.lastSearchedAt = new Date().toISOString();
              touched += 1;
            }
          }
          if (touched > 0) {
            persistPatterns();
            ctx.log.info(`runtime-learner: search exposed ${touched} pattern(s)`);
          }
        }

        // Deferred: track workflow patterns for adoption check (next 3 turns)
        const wfResults = results.filter(r => r.type === "workflow" && r.id);
        if (wfResults.length > 0 && sessionPath) {
          const searches = wfResults.map(r => {
            const stored = detector.patterns.get(r.id);
            return { patternId: r.id, tools: stored?.tools || [] };
          }).filter(s => s.tools.length > 0);
          if (searches.length > 0) {
            runtimeState.pendingAdoptionChecks.set(sessionPath, { searches, remaining: 3 });
          }
        }
      } catch (err) {
        ctx.log.warn(`runtime-learner: feedback loop skipped: ${err.message}`);
      }
    });

    const unsubs = [];
    try {
      unsubs.push(ctx.bus.subscribe((event, sessionPath) => {
        if (!event?.type) return;
        const turn = getTurn(sessionPath);

        if (event.type === "session_user_message") {
          turn.addUserText(messageText(event.message));
          return;
        }

        if (event.type === "user_message" || event.type === "message_start") {
          if (event.message?.role === "user") turn.addUserText(messageText(event.message));
          return;
        }

        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            turn.assistantText = safeText(`${turn.assistantText} ${sub.delta || ""}`, 1000);
          }
          return;
        }

        if (event.type === "tool_execution_start") {
          turn.markToolStart(event.toolName || event.name);
          return;
        }

        if (event.type === "tool_execution_end") {
          turn.markToolEnd(event.toolName || event.name);
          if (event.isError) { turn.addError(extractToolError(event)); return; }

          const handler = toolEndHandlers.get(normalizeToolName(event.toolName || event.name));
          if (handler) handler(event, sessionPath);
          return;
        }

        if (event.type === "message_end" && event.message?.role === "assistant") {
          flushTurn(sessionPath, event);
          return;
        }

        if (event.type === "assistantMessageEvent") {
          const ame = event.assistantMessageEvent || {};
          if (ame.toolName) turn.addTool(ame.toolName);
          if (ame.toolError) turn.addError(ame.toolError);
          if (ame.type === "done" || ame.type === "complete") flushTurn(sessionPath, event);
        }
      }));
    } catch (err) {
      ctx.log.warn(`runtime-learner: EventBus subscribe failed: ${err.message}`);
    }

    try {
      if (config.learnFromUsage && ctx.bus.subscribe) {
        unsubs.push(ctx.bus.subscribe((event, sessionPath) => {
          if (event?.type === "llm_usage" && event.entry) recordUsage(event.entry, sessionPath);
        }, { types: ["llm_usage"] }));
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: usage subscribe failed: ${err.message}`);
    }

    runtimeState.detector = detector;
    runtimeState.sessions = sessions;
    runtimeState.unsub = () => {
      for (const unsub of unsubs) {
        try { unsub?.(); } catch {}
      }
    };
    runtimeState.persistPatterns = persistPatterns;
    runtimeState.refreshSkill = refreshSkill;

    // Session startup activity entry
    logActivity({
      type: "session_start",
      summary: `Self-learning runtime started with ${detector.all().length} existing patterns`,
    });

    try {
      autoApprovePatterns();
      persistPatterns();
      pruneDataFiles();
      refreshSkill(true);
      maybeRunModelAdvisor("startup");
    } catch (err) {
      ctx.log.warn(`runtime-learner: initial refresh failed: ${err.message}`);
    }

    ctx.log.info("runtime-learner: started three-layer self-learning runtime");

    updateTokenDisplay();
    } catch (err) {
      try { ctx.log.error(`runtime-learner: onload failed: ${err.message}`); } catch {}
    }
  },

  async onunload() {
    // Session end activity entry
    logActivity({
      type: "session_end",
      summary: `Self-learning session ended. ${runtimeState.sessionActivityCount} activities this session. ${runtimeState.detector?.all()?.length || 0} total patterns.`,
    });

    if (runtimeState.unsub) runtimeState.unsub();
    if (runtimeState.detector && runtimeState.persistPatterns) {
      try { runtimeState.persistPatterns(); } catch {}
    }
    if (runtimeState.refreshSkill) {
      try { runtimeState.refreshSkill(true); } catch {}
    }
    runtimeState.detector = null;
    runtimeState.sessions = null;
    runtimeState.unsub = null;
    runtimeState.persistPatterns = null;
    runtimeState.refreshSkill = null;
    runtimeState.statusNotifiedAt.clear();
    runtimeState.advisorSkipReasons.clear();
    runtimeState.pendingAdoptionChecks.clear();
  },
});
