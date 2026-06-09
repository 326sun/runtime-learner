import fs from "fs";
import path from "path";
import {
  DEFAULT_CONFIG,
  readJson,
  loadLearnerConfig,
  decoratePatterns,
  knowledgeTier,
  ageDays,
  learnerDir as resolveLearnerDir,
  estimateTokens,
} from "../lib/common.js";
import { defineTool } from "../lib/hana-runtime-compat.js";
import { listProposals } from "../lib/proposals.js";
import { listReviews } from "../lib/review-queue.js";
import { eventSummary } from "../lib/event-log.js";
import { normalizeScope } from "../lib/scope.js";
import { factConflicts } from "../lib/temporal.js";
import { fingerprintPatterns, readMemFSIndex } from "../lib/memfs.js";

const SEVERITY_PENALTY = { critical: 20, high: 15, warning: 8, info: 3 };
const RETENTION_DAYS = 30;

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Pure health analysis. All inputs are passed in so this is fully testable
 * without touching disk. Returns a structured report; never mutates anything.
 *
 * @param {object} opts
 * @param {Array}  opts.patterns   raw patterns (will be decorated internally)
 * @param {object} opts.config
 * @param {Array}  opts.proposals  proposal records ({status,...})
 * @param {Array}  opts.facts      fact records (v1.1; default [])
 * @param {Array}  opts.logs       [{ name, oldestMs }] oldest entry per log file
 * @param {Array}  opts.reviews    review queue records
 * @param {object} opts.events     event summary
 * @param {number} opts.now
 */
export function diagnose({ patterns = [], config = DEFAULT_CONFIG, proposals = [], facts = [], logs = [], reviews = [], events = null, memfsIndex = null, now = Date.now(), retentionDays = RETENTION_DAYS } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const decorated = decoratePatterns(patterns, cfg);
  const issues = [];
  const add = (severity, type, message, suggestion, extra = {}) =>
    issues.push({ severity, type, message, suggestion, ...extra });

  // 1) duplicate_patterns — same desc+fix surviving as separate records.
  const dupGroups = new Map();
  for (const p of decorated) {
    if (p.status === "rejected") continue;
    const key = `${norm(p.desc)}||${norm(p.fix)}`;
    if (!key.replace(/\|/g, "")) continue;
    if (!dupGroups.has(key)) dupGroups.set(key, []);
    dupGroups.get(key).push(p.id);
  }
  const dups = [...dupGroups.values()].filter((ids) => ids.length > 1);
  if (dups.length) {
    add("warning", "duplicate_patterns",
      `${dups.length} group(s) of patterns share identical desc/fix.`,
      "Review and reject/merge the redundant copies via self_learning_control.",
      { groups: dups.map((ids) => ids.slice(0, 6)) });
  }

  // 2) conflicting_facts — same subject+predicate (per project) with >1 active
  //    object. Reuses the temporal layer so the rule matches retrieval.
  const conflicts = factConflicts(facts, now);
  if (conflicts.length) {
    add("high", "conflicting_facts",
      `${conflicts.length} subject/predicate(s) have multiple active conflicting values.`,
      "Add validTo/supersedes to retire the stale fact so only one stays active.",
      { keys: conflicts.map((c) => c.key).slice(0, 6) });
  }

  // 3) stale_auto_approved — machine-approved but never adopted and well aged.
  const halfLife = Math.max(1, Number(cfg.decayHalfLifeDays || 30));
  const stale = decorated.filter((p) =>
    p.autoApproved && !p.lastAdoptedAt && ageDays(p) > 2 * halfLife);
  if (stale.length) {
    add("warning", "stale_auto_approved",
      `${stale.length} auto-approved pattern(s) aged past ${2 * halfLife}d without ever being adopted.`,
      "Approve the ones worth keeping (immortalizes them) or let decay prune them.",
      { ids: stale.map((p) => p.id).slice(0, 8) });
  }

  // 4) pending_preferences — unreviewed corrections, dangerous when opted-in.
  const pendingPrefs = decorated.filter((p) => p.type === "preference" && p.status === "pending");
  if (cfg.includePendingPreferences && pendingPrefs.length) {
    add("high", "pending_preference_injection",
      `includePendingPreferences is ON with ${pendingPrefs.length} unreviewed preference(s) — they can inject without approval.`,
      "self_learning_control set_config includePendingPreferences=false, or approve/reject them.",
      { ids: pendingPrefs.map((p) => p.id).slice(0, 8) });
  } else if (pendingPrefs.length >= 10) {
    add("info", "pending_preference_backlog",
      `${pendingPrefs.length} unreviewed preference(s) accumulating (not injected — opt-in is off).`,
      "Periodically approve/reject via self_learning_control list type=preference status=pending.");
  }

  // 5) proposal_backlog
  const pendingProposals = proposals.filter((pr) => pr.status === "pending");
  if (pendingProposals.length >= 25) {
    add("critical", "proposal_backlog",
      `${pendingProposals.length} pending proposals — the queue has become a dumping ground.`,
      "Triage with self_learning_control list_proposals; apply or reject in bulk.");
  } else if (pendingProposals.length >= 10) {
    add("warning", "proposal_backlog",
      `${pendingProposals.length} pending proposals awaiting review.`,
      "Triage with self_learning_control list_proposals.");
  }

  // 6) skill_budget — untrimmed injectable hints exceed the SKILL.md budget,
  //    meaning low-value hints are being dropped each refresh.
  const injectable = decorated.filter((p) => p.injectable);
  const hintText = injectable.map((p) => `- ${p.desc} ${p.fix || ""}`).join("\n");
  const hintTokens = estimateTokens(hintText);
  const maxTokens = Math.max(200, Number(cfg.maxSkillTokens || DEFAULT_CONFIG.maxSkillTokens));
  if (hintTokens > maxTokens) {
    add("info", "skill_budget",
      `Injectable hints (~${hintTokens} tok) exceed maxSkillTokens (${maxTokens}); lowest-value hints are trimmed from SKILL.md.`,
      "Approve/reject to consolidate, or raise maxSkillTokens if you want a larger skill.",
      { injectable: injectable.length });
  }

  // 7) privacy_retention — log entries older than the retention promise.
  const cutoff = now - retentionDays * 86_400_000;
  const overdue = logs.filter((l) => Number.isFinite(l.oldestMs) && l.oldestMs < cutoff);
  if (overdue.length) {
    add("warning", "privacy_retention",
      `${overdue.length} log file(s) contain entries older than ${retentionDays} days.`,
      "Retention runs on a timer; if this persists, ensure the plugin is loaded so pruneDataFiles can run.",
      { files: overdue.map((l) => l.name) });
  }

  // 8) scope_leakage — injectable patterns spanning multiple concrete projects.
  const concrete = injectable
    .map((p) => normalizeScope(p.scope || p.context).project)
    .filter((proj) => proj && proj !== "general");
  const projectSet = new Set(concrete);
  if (projectSet.size >= 2) {
    add("info", "scope_leakage",
      `Injectable patterns span ${projectSet.size} concrete projects; verify cross-project recall is intended.`,
      "Use self_learning_search with a project filter to confirm isolation.",
      { projects: [...projectSet].slice(0, 8) });
  }

  // 9) orphan_relations — relation edges pointing at non-existent patterns.
  const ids = new Set(decorated.map((p) => p.id));
  const orphans = [];
  for (const p of decorated) {
    for (const rel of p.context?.relations || []) {
      if (rel?.targetId && !ids.has(rel.targetId)) orphans.push({ from: p.id, target: rel.targetId });
    }
  }
  if (orphans.length) {
    add("warning", "orphan_relations",
      `${orphans.length} relation edge(s) point to patterns that no longer exist.`,
      "These are dead links left by pruning; they get cleaned as patterns re-link, or you can rebuild.",
      { edges: orphans.slice(0, 8) });
  }

  // 10) evidence_missing — only meaningful once any pattern carries evidence
  //     (the evidence field lands in v1.1; skip entirely before then).
  const evidenceInUse = decorated.some((p) => Array.isArray(p.evidence) && p.evidence.length);
  if (evidenceInUse) {
    const highNoEv = decorated.filter((p) =>
      (Number(p.score) >= 12 || Number(p.decayedScore) >= 12) &&
      !(Array.isArray(p.evidence) && p.evidence.length));
    if (highNoEv.length) {
      add("info", "evidence_missing",
        `${highNoEv.length} high-score pattern(s) have no evidence to justify them.`,
        "Prefer patterns with traceable evidence; consider rejecting unsupported high-score hints.",
        { ids: highNoEv.map((p) => p.id).slice(0, 8) });
    }
  }

  // 11) memfs_stale — the human-readable view no longer matches live memory.
  //     Only meaningful once MemFS has been generated (index present).
  if (memfsIndex && memfsIndex.fingerprint && memfsIndex.fingerprint !== fingerprintPatterns(patterns, facts)) {
    add("info", "memfs_stale",
      "The MemFS Markdown view is out of date with patterns/facts.",
      "self_learning_control action=regenerate_memfs");
  }


  // 12) review_queue — learning changes should be triaged through review.
  const activeReviews = reviews.filter((r) => ["queued", "blocked", "approved"].includes(r.status));
  const blockedReviews = reviews.filter((r) => r.status === "blocked");
  if (activeReviews.length >= 20) {
    add("warning", "review_backlog",
      `${activeReviews.length} review item(s) are waiting or blocked.`,
      "Use self_learning_control action=review_panel, then preview/validate/apply or reject items.");
  }
  if (blockedReviews.length) {
    add("high", "validation_blocked_reviews",
      `${blockedReviews.length} review item(s) are blocked by validation failures.`,
      "Run self_learning_control action=validate_proposal for details, then fix or reject the proposal.",
      { ids: blockedReviews.map((r) => r.id).slice(0, 8) });
  }

  // 13) event_log_missing — v1.4 governance expects an append-only audit trail.
  if (events && events.count === 0 && (proposals.length || reviews.length || decorated.length)) {
    add("info", "event_log_missing",
      "No append-only governance events were found yet.",
      "Events will be written as new proposals/reviews/skill changes occur.");
  }

  // ── Score & status ──
  let score = 100;
  for (const i of issues) score -= SEVERITY_PENALTY[i.severity] ?? 3;
  score = Math.max(0, score);

  let status, label;
  if (issues.some((i) => i.severity === "critical") || score < 50) { status = "critical"; label = "Critical"; }
  else if (issues.some((i) => i.severity === "high" || i.severity === "warning") || score < 80) { status = "warning"; label = "Warning"; }
  else { status = "good"; label = "Good"; }

  const suggestedActions = [...new Set(issues.map((i) => i.suggestion).filter(Boolean))];

  return {
    status,
    label,
    score,
    summary: {
      patterns: decorated.length,
      injectable: injectable.length,
      pendingPreferences: pendingPrefs.length,
      pendingProposals: pendingProposals.length,
      pendingReviews: activeReviews.length,
      blockedReviews: blockedReviews.length,
      concreteProjects: projectSet.size,
    },
    issues,
    suggestedActions,
    generatedAt: new Date(now).toISOString(),
  };
}

// Oldest entry timestamp (ms) in a JSONL log, by scanning the head (entries are
// appended chronologically, so the earliest valid date sits near the top).
function oldestLogMs(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(0, 200);
    let oldest = Infinity;
    for (const line of lines) {
      try {
        const t = Date.parse(JSON.parse(line).date);
        if (Number.isFinite(t) && t < oldest) oldest = t;
      } catch {}
    }
    return Number.isFinite(oldest) ? oldest : null;
  } catch {
    return null;
  }
}

// Gather the on-disk inputs and run diagnose. Shared by the tool and by
// self_learning_control's `doctor` action.
export function runDoctorFromDisk(learnerDir = resolveLearnerDir()) {
  const config = loadLearnerConfig(path.join(learnerDir, "config.json"));
  const patterns = readJson(path.join(learnerDir, "patterns.json"), []) || [];
  const facts = readJson(path.join(learnerDir, "facts.json"), []) || [];
  const proposals = listProposals(learnerDir, { limit: 500 });
  const logs = [
    ["experience_log.jsonl"], ["error_log.jsonl"], ["turns.jsonl"], ["activity_log.jsonl"],
  ].map(([name]) => ({ name, oldestMs: oldestLogMs(path.join(learnerDir, name)) }));
  const reviews = listReviews(learnerDir, { limit: 500 });
  const events = eventSummary(learnerDir);
  const memfsIndex = readMemFSIndex(learnerDir);
  return diagnose({ patterns, config, proposals, facts, logs, reviews, events, memfsIndex });
}

export function formatReport(report) {
  const icon = report.status === "good" ? "✅" : report.status === "warning" ? "⚠️" : "🛑";
  const lines = [
    `# Self-Learning Doctor — ${icon} ${report.label} (score ${report.score}/100)`,
    "",
    `patterns=${report.summary.patterns} · injectable=${report.summary.injectable} · pendingPrefs=${report.summary.pendingPreferences} · pendingProposals=${report.summary.pendingProposals} · pendingReviews=${report.summary.pendingReviews || 0}`,
    "",
  ];
  if (!report.issues.length) {
    lines.push("No issues detected. Memory system is healthy.");
  } else {
    lines.push("## Issues");
    for (const i of report.issues) {
      lines.push(`- [${i.severity}] ${i.type}: ${i.message}`);
      if (i.suggestion) lines.push(`  → ${i.suggestion}`);
    }
    if (report.suggestedActions.length) {
      lines.push("", "## Suggested actions");
      for (const a of report.suggestedActions) lines.push(`- ${a}`);
    }
  }
  lines.push("", "> Read-only diagnostic — no files were modified.");
  return lines.join("\n");
}

const tool = defineTool({
  name: "self_learning_doctor",
  description: "Read-only health check of the self-learning memory: duplicate/conflicting/expired memories, unreviewed preferences, proposal backlog, SKILL.md budget, scope leakage, orphan relations, missing evidence. Reports Good/Warning/Critical with fixes. Modifies nothing.",
  parameters: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["text", "json"], description: "Output format. Default text." },
    },
    required: [],
  },
  async execute(input = {}) {
    const report = runDoctorFromDisk();
    if (input.format === "json") return JSON.stringify(report, null, 2);
    return formatReport(report);
  },
});

export const { name, description, parameters, execute } = tool;
