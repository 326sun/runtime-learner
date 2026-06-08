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
import { DEFAULT_CONFIG, learnerDir, readJson, writeJson, describeOfficialUtilityModel, countJsonl, buildSkillMdFromPatterns } from "./lib/common.js";
import { definePlugin } from "./lib/hana-runtime-compat.js";
import { readModelAdvice, runModelAdvisor } from "./lib/model-advisor.js";
import { applyProposal, buildCodePatchProposal, buildSkillPatchProposal } from "./lib/proposals.js";
import { normalizeToolName, safeText, toolCategory, shortHash, preferencePatternId, stableKey, isUsageFailure, TASK_SIGS, ERR_PATTERNS, CORRECTION_STRONG, CORRECTION_WEAK, classifyTask, classifyError, extractCorrectionFromUserText } from "./lib/helpers.js";
import { SessionTurn } from "./lib/session-turn.js";
import { PatternDetector } from "./lib/pattern-detector.js";
import { createObserver } from "./lib/observer.js";

const DATA_DIR = learnerDir();
const EXPERIENCE_LOG = path.join(DATA_DIR, "experience_log.jsonl");
const ERROR_LOG = path.join(DATA_DIR, "error_log.jsonl");
const USAGE_SUMMARY_FILE = path.join(DATA_DIR, "usage_summary.json");
const USAGE_SEEN_FILE = path.join(DATA_DIR, "usage_seen.json");
const CAPABILITIES_FILE = path.join(DATA_DIR, "host_capabilities.json");
const PATTERNS_FILE = path.join(DATA_DIR, "patterns.json");
const TURNS_FILE = path.join(DATA_DIR, "turns.jsonl");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const ACTIVITY_LOG = path.join(DATA_DIR, "activity_log.jsonl");
const HISTORY_DIR = path.join(DATA_DIR, "skill_history");
const MAX_SESSIONS = 64;
const SKILL_REFRESH_MIN_MS = 10_000;
const MAX_SKILL_HISTORY = 20;
const MAX_ACTIVITY_ENTRIES = 500;
const LOG_RETENTION_DAYS = 30;
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — skip prune for small files
const CODE_PROPOSAL_MIN_COUNT = 3;

const runtimeState = {
  detector: null,
  sessions: null,
  unsub: null,
  persistPatterns: null,
  persistSeenIds: null,
  refreshSkill: null,
  statusNotifiedAt: new Map(),
  advisorSkipReasons: new Set(),
  proposalNotifiedIds: new Map(), // proposalId → lastNotifiedAt timestamp
  sessionStart: null,
  sessionActivityCount: 0,
  pendingAdoptionChecks: new Map(),
};

const CORRECTION_PATTERNS = CORRECTION_STRONG;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "proposals"), { recursive: true });
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf-8");
}

// Sanitize a snippet returned by the external advisor model before it is stored
// in a pattern's `fix` and injected into SKILL.md. Strips code fences, markdown
// headings and obvious role/prompt markers, collapses whitespace, and caps
// length, so a hijacked endpoint cannot smuggle instructions into the agent's
// context.
function sanitizeAdvice(text, max = 200) {
  let s = String(text || "");
  if (!s) return "";
  s = s.replace(/```[\s\S]*?```/g, " ")       // fenced code blocks
       .replace(/^\s*#{1,6}\s+/gm, "")          // markdown headings
       .replace(/^\s*(system|assistant|user)\s*:/gim, "") // role markers
       .replace(/[`*_>#]/g, "")                 // markdown control chars
       .replace(/\s+/g, " ")
       .trim();
  return s.slice(0, max);
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
    pruneActivityLog().catch(() => {});
  } catch {}
}

async function pruneActivityLog() {
  try {
    if (!fs.existsSync(ACTIVITY_LOG)) return;
    const text = await fs.promises.readFile(ACTIVITY_LOG, "utf-8");
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length > MAX_ACTIVITY_ENTRIES) {
      await fs.promises.writeFile(ACTIVITY_LOG, lines.slice(-MAX_ACTIVITY_ENTRIES).join("\n") + "\n", "utf-8");
    }
  } catch {}
}

// Prune log files on a 5-minute interval, not on every flush
let lastPruneTs = 0;
async function pruneDataFiles() {
  const now = Date.now();
  if (now - lastPruneTs < 300_000) return;
  lastPruneTs = now;
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;

  // Prune JSONL files: drop lines older than retention window
  const logFiles = [EXPERIENCE_LOG, TURNS_FILE, ERROR_LOG, ACTIVITY_LOG];
  for (const file of logFiles) {
    try {
      if (!fs.existsSync(file)) continue;
      const stat = await fs.promises.stat(file);
      if (stat.size <= MAX_LOG_SIZE_BYTES) continue;
      const text = await fs.promises.readFile(file, "utf-8");
      const lines = text.trim().split("\n").filter(Boolean);
      const kept = [];
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (!row.date || new Date(row.date).getTime() >= cutoff) kept.push(line);
        } catch { kept.push(line); } // Keep unparseable lines
      }
      if (kept.length < lines.length) {
        await fs.promises.writeFile(file, kept.join("\n") + "\n", "utf-8");
      }
    } catch {}
  }

  // NOTE: patterns.json retention is intentionally NOT handled here. It used to
  // read+rewrite the file on disk, but the in-memory detector re-persists its
  // full set on the next flush, so this disk-side pruning was immediately
  // overwritten (dead work + disk churn + memory/disk disagreement). Retention
  // is now centralised in PatternDetector.pruneMemory(), the single source of
  // truth, invoked from the flush path before persistPatterns().
}

function readRecentActivity(days = 1) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    if (!fs.existsSync(ACTIVITY_LOG)) return [];
    // Read only tail of file: scan backwards from EOF to find recent entries
    const TAIL_BYTES = 64 * 1024; // 64KB tail covers ~500+ entries
    const stat = fs.statSync(ACTIVITY_LOG);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    const fd = fs.openSync(ACTIVITY_LOG, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString("utf-8");
    // If we started mid-file, skip the first (possibly partial) line
    const lines = text.split("\n").filter(Boolean);
    if (start > 0 && lines.length > 0) lines.shift();
    const rows = [];
    // Reverse iterate: collect recent entries (no break — timestamps may be non-monotonic)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (new Date(row.date).getTime() >= cutoff) rows.push(row);
      } catch {}
    }
    return rows; // already newest-first from reverse iteration
  } catch {}
  return [];
}

/* ── Plugin lifecycle ── */

export default definePlugin({
  async onload(ctx, { register }) {
    try {
    ensureDir();

    let config = loadConfig();
    // Capped dedup set — evicts oldest entries when full. Persisted to disk so
    // that the startup usage bootstrap (which re-fetches the last 7 days) does
    // not re-count requests already summed into usage_summary.json on a prior
    // run — otherwise totalRequests/totalTokens inflate on every restart.
    const SEEN_IDS_CAP = 5000;
    const seenRequestIds = new Set(readJson(USAGE_SEEN_FILE, []).slice(-SEEN_IDS_CAP));
    const _seenIdsEvict = () => {
      if (seenRequestIds.size <= SEEN_IDS_CAP) return;
      const iter = seenRequestIds.values();
      // Delete oldest 20% to amortise eviction cost
      const toRemove = Math.ceil(SEEN_IDS_CAP * 0.2);
      for (let i = 0; i < toRemove; i++) seenRequestIds.delete(iter.next().value);
    };
    let _seenIdsDirty = false;
    let _seenIdsFlushedAt = 0;
    const persistSeenIds = (force = false) => {
      if (!_seenIdsDirty) return;
      // Throttle: at most once per 10s during a session; force on unload.
      if (!force && Date.now() - _seenIdsFlushedAt < 10_000) return;
      try {
        writeJson(USAGE_SEEN_FILE, [...seenRequestIds]);
        _seenIdsDirty = false;
        _seenIdsFlushedAt = Date.now();
      } catch {}
    };
    runtimeState.persistSeenIds = () => persistSeenIds(true);
    const detector = new PatternDetector(config);

    // One-time migration: mark legacy preferences as durable knowledge.
    try {
      const patterns = readJson(PATTERNS_FILE, []);
      let migrated = 0;
      for (const p of patterns) {
        if (p.type === "preference" && !p.knowledgeTier) {
          p.knowledgeTier = "durable";
          migrated += 1;
        }
      }
      if (migrated > 0) {
        writeJson(PATTERNS_FILE, patterns);
        ctx.log.info(`runtime-learner: migrated ${migrated} preferences to durable tier`);
      }
    } catch {}

    const sessions = new Map();
    let lastSkillRefresh = 0;
    runtimeState.sessionStart = new Date().toISOString();
    runtimeState.sessionActivityCount = 0;

    // Sync disk status into in-memory detector (control.js may approve/reject)
    // Called once per flush cycle instead of on every persist.
    // Uses mtime cache: only re-reads patterns.json when it was modified by control.js.
    let _patternsMtime = 0;
    const syncDiskStatus = () => {
      try {
        if (!fs.existsSync(PATTERNS_FILE)) return;
        const mtime = fs.statSync(PATTERNS_FILE).mtimeMs;
        if (mtime === _patternsMtime) return; // no change, skip
        _patternsMtime = mtime;
        const disk = readJson(PATTERNS_FILE, []);
        if (!disk.length) return;
        for (const p of disk) {
          if (!p.id) continue;
          if (p.status !== "approved" && p.status !== "rejected") continue;
          const stored = detector.patterns.get(p.id);
          if (stored && stored.status !== p.status) {
            stored.status = p.status;
            if (p.reviewedAt) stored.reviewedAt = p.reviewedAt;
          }
        }
      } catch {}
    };

    const persistPatternsNow = () => {
      // Absorb any review status written by control.js (a separate process)
      // before we overwrite the file, so a fresh approve/reject is never lost.
      // mtime-guarded, so this is a no-op when nothing changed.
      syncDiskStatus();
      const mem = [...detector.patterns.values()].map(p => ({ ...p }));
      // Atomic write via temp file + rename
      const tmpFile = `${PATTERNS_FILE}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmpFile, JSON.stringify(mem, null, 2), "utf-8");
        fs.renameSync(tmpFile, PATTERNS_FILE);
        // Record our own write's mtime so syncDiskStatus doesn't re-read it back.
        try { _patternsMtime = fs.statSync(PATTERNS_FILE).mtimeMs; } catch {}
      } catch (err) {
        try { fs.rmSync(tmpFile, { force: true }); } catch {}
        throw err;
      }
    };

    // Debounced persist: coalesce the many flush/usage writes in a busy session
    // into at most one disk write per ~1.5s. onunload force-flushes via
    // runtimeState.persistPatterns so nothing is lost on shutdown.
    let _persistTimer = null;
    const persistPatterns = () => {
      if (_persistTimer) return;
      _persistTimer = setTimeout(() => {
        _persistTimer = null;
        try { persistPatternsNow(); }
        catch (err) { ctx.log.warn(`runtime-learner: persist failed: ${err.message}`); }
      }, 1500);
      _persistTimer.unref?.();
    };
    const flushPersist = () => {
      if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
      persistPatternsNow();
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

    const sendSessionMessage = async (sessionPath, text, retries = 3) => {
      if (!sessionPath || !text || !canSendSessionMessage()) return false;
      for (let i = 0; i < retries; i++) {
        try {
          await ctx.bus.request("session:send", { sessionPath, text });
          return true;
        } catch (err) {
          if (err.message === "session_busy" && i < retries - 1) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          ctx.log.warn?.(`runtime-learner: session message failed: ${err.message}`);
          return false;
        }
      }
      return false;
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

    const notifyProposalReview = async (sessionPath, proposals = [], { cooldownMs = 2 * 60 * 60_000 } = {}) => {
      if (!config.proposalChatNotificationsEnabled || !sessionPath || proposals.length === 0) return;
      const now = Date.now();
      for (const proposal of proposals) {
        if (!proposal?.id) continue;
        const lastNotified = runtimeState.proposalNotifiedIds.get(proposal.id) || 0;
        if (now - lastNotified < cooldownMs) continue;
        const sent = await sendSessionMessage(sessionPath, formatProposalNotification(proposal));
        if (sent) {
          runtimeState.proposalNotifiedIds.set(proposal.id, now);
        } else {
          ctx.log.warn(`runtime-learner: proposal notification NOT sent for ${proposal.id} (sessionPath=${sessionPath}, canSend=${canSendSessionMessage()})`);
        }
      }
    };

    const maybeProposeCodeImprovements = (patterns, sessionPath = null) => {
      if (!patterns) patterns = detector.all();
      let created = 0;
      const toNotify = [];
      for (const pattern of patterns) {
        if (!["error", "usage"].includes(pattern.type)) continue;
        if ((pattern.count || 0) < CODE_PROPOSAL_MIN_COUNT) continue;
        // Skip patterns that are inherently non-code issues:
        // - usage:failed_request → always a network/provider problem
        // - approved patterns → already acknowledged by user, don't re-propose
        if (pattern.id && pattern.id.startsWith("usage:failed_request")) continue;
        if (pattern.status === "approved") continue;
        const proposal = buildCodePatchProposal({ learnerDir: DATA_DIR, pattern });
        if (proposal.status === "pending") {
          if (proposal.createdAt === proposal.updatedAt) created += 1;
          toNotify.push(proposal);
        }
      }
      if (toNotify.length > 0) {
        if (created > 0) {
          logActivity({
            type: "proposal_created",
            summary: `Created ${created} high-risk code improvement proposal(s) for review`,
            sessionPath,
          });
        }
        void notifyProposalReview(sessionPath, toNotify);
      }
      return created;
    };

    const refreshSkill = (force = false, sessionPath = null, cachedAll = null) => {
      const now = Date.now();
      if (!force && now - lastSkillRefresh < SKILL_REFRESH_MIN_MS) return;
      const allPatterns = cachedAll || detector.all();
      const skillDir = path.join(ctx.pluginDir, "skills", "self-learning");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      snapshotSkill(skillPath);
      const content = buildSkillMdFromPatterns(allPatterns, config, {
        turnCount: detector.turnCount,
        dataDir: DATA_DIR,
      });
      const triggerPatternIds = allPatterns.filter(p => p.injectable).slice(0, 8).map(p => p.id);
      const proposal = buildSkillPatchProposal({
        learnerDir: DATA_DIR,
        skillPath,
        content,
        triggerPatternIds,
      });
      if (proposal.autoApply && proposal.status !== "applied") {
        applyProposal(DATA_DIR, proposal.id, { configPath: CONFIG_FILE });
      }
      maybeProposeCodeImprovements(allPatterns, sessionPath);
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
      if (runtimeState.advisorSkipReasons.has(key)) return true;
      runtimeState.advisorSkipReasons.add(key);
      return false;
    };

    const maybeRunModelAdvisor = async (reason, sessionPath = null, cachedAll = null) => {
      if (!config.modelAdvisorEnabled) return;
      try {
        const result = await runModelAdvisor({
          config,
          patterns: cachedAll || detector.all(),
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
            // Merge advisor insights back into patterns — replaces raw user
            // text with distilled knowledge. The advice comes from an external
            // model and is injected into SKILL.md, so sanitize it and never let
            // it override a fix the user explicitly approved.
            let merged = 0;
            for (const s of result.advice.suggestions) {
              const stored = detector.patterns.get(s.patternId);
              if (!stored || stored.status === "approved") continue;
              const advice = sanitizeAdvice(s.advice);
              if (advice && advice !== stored.fix) {
                stored.fix = advice;
                stored.advisorUpdatedAt = new Date().toISOString();
                merged += 1;
              }
            }
            if (merged > 0) {
              ctx.log.info(`runtime-learner: merged ${merged} advisor insights into patterns`);
              refreshSkill(true, sessionPath);
            }

            // Convert high-risk advisor suggestions into reviewable code_patch proposals.
            // Low/medium risk suggestions are already handled by the merge loop above
            // (injected into pattern.fix => flows into next SKILL.md regeneration).
            // High-risk items need human review, so they become code_patch proposals.
            const highRiskSuggestions = result.advice.suggestions.filter((s) => s.risk === "high" && detector.patterns.has(s.patternId));
            if (highRiskSuggestions.length > 0) {
              const toNotify = [];
              let created = 0;
              for (const s of highRiskSuggestions) {
                const pattern = detector.patterns.get(s.patternId);
                const proposal = buildCodePatchProposal({
                  learnerDir: DATA_DIR,
                  pattern: {
                    ...pattern,
                    fix: sanitizeAdvice(s.advice),
                  },
                });
                if (proposal.status === "pending") {
                  if (proposal.createdAt === proposal.updatedAt) created += 1;
                  toNotify.push(proposal);
                }
              }
              if (created > 0) {
                logActivity({
                  type: "proposal_created",
                  summary: `Model advisor flagged ${created} high-risk pattern(s) for review`,
                  sessionPath,
                });
                runtimeState.sessionActivityCount += 1;
              }
              void notifyProposalReview(sessionPath, toNotify);
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
    // Data directory display in settings (set once at startup)
    const updateDataDirDisplay = () => {
      try { ctx.config?.update?.({ dataDirPath: DATA_DIR }); } catch {}
    };

    // ── Auto-approve: shared logic for all three call sites ──

    const autoApprovePatterns = (sessionPath = null, cachedAll = null) => {
      if (!config.autoApproveHighConfidence) return { count: 0, allPatterns: cachedAll || detector.all() };
      const allPatterns = cachedAll || detector.all();
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
        // Invalidate cache since statuses changed
        return { count, allPatterns: count > 0 ? detector.all() : allPatterns };
      }
      return { count, allPatterns };
    };

    const recordUsage = (entry, sessionPath = null) => {
      if (!config.learnFromUsage) return;
      const summaryEntry = summarizeUsageEntry(entry, sessionPath);
      const dedupKey = summaryEntry.requestId;
      if (dedupKey && seenRequestIds.has(dedupKey)) return;
      if (dedupKey) { seenRequestIds.add(dedupKey); _seenIdsEvict(); _seenIdsDirty = true; }
      try {
        updateUsageSummary(summaryEntry);
        persistSeenIds();
        updateDataDirDisplay();
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
        const { allPatterns } = autoApprovePatterns(sessionPath);
        persistPatterns();
        pruneDataFiles().catch(() => {});
        refreshSkill(false, sessionPath, allPatterns);
        maybeRunModelAdvisor("usage", sessionPath, allPatterns).catch(() => {});
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
        persistSeenIds(true); // flush now so a hard kill won't re-count on next start
        ctx.log.info(`runtime-learner: bootstrapped ${result?.entries?.length || 0} usage records`);
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: usage bootstrap skipped: ${err.message}`);
    }

    // ── Observer setup (extracted to lib/observer.js) ──

    const configRef = { current: config };

    const observer = createObserver({
      detector,
      sessions,
      runtimeState,
      persistPatterns,
      refreshSkill,
      autoApprovePatterns,
      syncDiskStatus,
      pruneDataFiles,
      maybeRunModelAdvisor,
      appendJsonl,
      logActivity,
      recordUsage,
      configRef,
      ctx,
      paths: { TURNS_FILE, EXPERIENCE_LOG, ERROR_LOG, CONFIG_FILE },
      MAX_SESSIONS,
    });

    observer.subscribe(ctx.bus, config);

    runtimeState.detector = detector;
    runtimeState.sessions = sessions;
    runtimeState.unsub = () => observer.unsubscribe();
    runtimeState.persistPatterns = flushPersist;
    runtimeState.refreshSkill = refreshSkill;

    // Session startup activity entry
    logActivity({
      type: "session_start",
      summary: `Self-learning runtime started with ${detector.all().length} existing patterns`,
    });

    try {
      syncDiskStatus();
      const { allPatterns } = autoApprovePatterns();
      flushPersist();
      pruneDataFiles().catch(() => {});
      refreshSkill(true, null, allPatterns);
      maybeRunModelAdvisor("startup", null, allPatterns).catch(() => {});
    } catch (err) {
      ctx.log.warn(`runtime-learner: initial refresh failed: ${err.message}`);
    }

    ctx.log.info("runtime-learner: started three-layer self-learning runtime");

    updateDataDirDisplay();
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
    if (runtimeState.persistSeenIds) {
      try { runtimeState.persistSeenIds(); } catch {}
    }
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
    runtimeState.persistSeenIds = null;
    runtimeState.refreshSkill = null;
    runtimeState.statusNotifiedAt.clear();
    runtimeState.advisorSkipReasons.clear();
    runtimeState.pendingAdoptionChecks.clear();
    runtimeState.proposalNotifiedIds.clear();
  },
});
