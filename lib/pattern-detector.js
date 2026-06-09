/**
 * PatternDetector — core pattern detection engine for Runtime Self-Learning.
 * Extracted from index.js to enable independent testing and modular reasoning.
 *
 * Detects three pattern types:
 *   - workflow: repeated tool-category sequences across turns
 *   - preference: user corrections with durability assessment
 *   - error: recurring tool/request failures
 *   - usage: large-context or failed-request patterns
 *
 * Uses Ebbinghaus forgetting curve for memory pruning (see common.js).
 */

import {
  toolCategory,
  normalizeToolName,
  safeText,
  preferencePatternId,
  stableKey,
  isUsageFailure,
} from "./helpers.js";
import {
  knowledgeTier,
  memoryStrength,
  patternStatus,
  decayedScore,
  isInjectable,
  DEFAULT_CONFIG,
} from "./common.js";
import { makeEvidence, attachEvidence } from "./evidence.js";

const MAX_PATTERN_COUNT = 50;

const DURABLE_SETTING_PATTERNS = [
  /(?:请?记住|以后都|以后默认|默认使用|长期|固定|总是|每次都|作为设定|写入记忆)/i,
  /(?:remember this|from now on|always|default to|make this a setting|pin this)/i,
];

// Build the scope stamped onto a pattern from an ingested experience/error.
// Kept lean for v0.9 (project / taskType / source); temporal fields
// (validFrom / validTo) arrive with facts in v1.1.
function scopeFrom(source) {
  const s = source?.scope || {};
  return {
    project: s.project || source?.project || "general",
    taskType: s.taskType || source?.taskType || "general",
    source: s.source || "runtime",
  };
}

function preferenceTierFromText(text, toolsUsed = []) {
  if ((toolsUsed || []).map(normalizeToolName).includes("pin_memory")) return "durable";
  const clean = safeText(text, 300);
  if (DURABLE_SETTING_PATTERNS.some((pattern) => pattern.test(clean))) return "durable";
  return "core";
}

export class PatternDetector {
  constructor(config) {
    this.config = config;
    this.patterns = new Map();
    this.seqCache = new Map();
    this.seqInsertOrder = [];
    this.turnCount = 0;
    this.catIndex = new Map();
    this._cacheDirty = true;
    this._cachedAll = null;
  }

  setConfig(config) {
    this.config = config;
    this._cacheDirty = true;
  }

  // Invalidate the decorated-pattern cache after a *side-channel* mutation —
  // i.e. any code outside the ingest*/restore/pruneMemory family that edits a
  // stored pattern's status/score/fix/etc. directly (auto-approve, score boosts,
  // advisor merge, disk-status sync, pin_memory). Without this, all() keeps
  // serving the pre-mutation snapshot until the next ingest flips the dirty bit.
  invalidate() {
    this._cacheDirty = true;
  }

  // ── Category index helpers ──

  _indexPattern(id, categories) {
    if (!categories || !categories.length) return;
    for (const cat of categories) {
      if (!this.catIndex.has(cat)) this.catIndex.set(cat, new Set());
      this.catIndex.get(cat).add(id);
    }
  }

  _unindexPattern(id) {
    for (const [, ids] of this.catIndex) {
      ids.delete(id);
    }
  }

  // Fully evict a pattern: drop it from the store, the category index, AND — for
  // workflows — the seqCache/seqInsertOrder counters keyed on its category
  // signature. Without clearing the counter, a workflow pruned for decay would
  // resurrect at its old (high) count the next time the sequence recurs, since
  // ingest resumes from `seqCache.get(catKey) + 1` — silently undoing forgetting.
  _forgetPattern(id) {
    this._cacheDirty = true;
    this._unindexPattern(id);
    this.patterns.delete(id);
    if (typeof id === "string" && id.startsWith("workflow:")) {
      const catKey = id.slice("workflow:".length);
      this.seqCache.delete(catKey);
      const idx = this.seqInsertOrder.indexOf(catKey);
      if (idx !== -1) this.seqInsertOrder.splice(idx, 1);
    }
  }

  // ── Restore ──

  restore(saved) {
    this._cacheDirty = true;
    for (const pattern of saved || []) {
      if (!pattern?.id) continue;
      this.patterns.set(pattern.id, pattern);
      // Rebuild category index
      if (pattern.context?.categories) {
        this._indexPattern(pattern.id, pattern.context.categories);
      }
      if (pattern.type === "workflow" && Array.isArray(pattern.tools)) {
        // Derive category key from stored tools for seqCache restoration
        const cats = pattern.tools.map(t => toolCategory(normalizeToolName(t)));
        const uniqueCats = [...new Set(cats)].sort();
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
    this._cacheDirty = true;
    this.turnCount += 1;
    const newPatterns = [];

    // Workflow detection: category-level, skip single-category chains
    if (exp.toolsUsed.length >= 2) {
      const cats = exp.toolsUsed.map(t => toolCategory(normalizeToolName(t)));
      const uniqueCats = [...new Set(cats)].sort();
      if (uniqueCats.length >= 2) {
        const catKey = uniqueCats.join("→");
        const toolKey = exp.toolsUsed.join("->");
        const count = (this.seqCache.get(catKey) || 0) + 1;
        this.seqCache.set(catKey, count);
        if (count >= 3) {
          // Only track category keys that have crossed the pattern threshold.
          // Keys that never reach 3 occurrences are transient and shouldn't
          // consume seqInsertOrder slots.
          if (!this.seqInsertOrder.includes(catKey)) {
            this.seqInsertOrder.push(catKey);
            while (this.seqInsertOrder.length > MAX_PATTERN_COUNT) {
              this.seqCache.delete(this.seqInsertOrder.shift());
            }
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
            // Base score tracks occurrence count; `bonus` carries durable rewards
            // from positive feedback / adoption. The old Math.max(score, count*3)
            // silently swallowed those rewards once count*3 caught up to them.
            existing.score = count * 3 + (existing.bonus || 0);
            existing.tools = [...new Set([...(existing.tools || []), ...exp.toolsUsed])];
            // Merge task types as a deduped set. The existing value is already a
            // comma-joined string, so it must be split before deduping — wrapping
            // it as a single opaque token let duplicates accumulate
            // ("coding,research" + "coding" → "coding,research,coding").
            const mergedTaskTypes = [...new Set([
              ...String(existing.context?.taskType || "").split(",").map((t) => t.trim()).filter(Boolean),
              ctx.taskType,
            ])].join(",");
            existing.context = { ...existing.context, ...ctx, taskType: mergedTaskTypes };
            // Keep the original project binding; refresh taskType to the merged set.
            existing.scope = { ...scopeFrom(exp), ...(existing.scope || {}), taskType: mergedTaskTypes };
            attachEvidence(existing, makeEvidence({ type: "turn", file: "experience_log.jsonl", date: exp.date, quote: exp.taskSummary || exp.userIntent }));
            this._indexPattern(pid, uniqueCats);
            // Track tool-level sub-signatures for actionable hints
            const subs = existing.subSignatures = existing.subSignatures || {};
            subs[toolKey] = (subs[toolKey] || 0) + 1;
            // Prune: keep top 10 sub-signatures
            const subEntries = Object.entries(subs).sort((a, b) => b[1] - a[1]);
            if (subEntries.length > 10) {
              existing.subSignatures = Object.fromEntries(subEntries.slice(0, 10));
            }
            // Upgrade hint when a specific sub-signature dominates
            const topSub = subEntries[0];
            if (topSub && topSub[1] >= 3) {
              existing.fix = `Common sequence: ${topSub[0].replace(/->/g, " → ")} (seen ${topSub[1]}×). Consider automating or templating this flow.`;
            }
            if (wasBelow) newPatterns.push({ id: pid, type: "workflow", desc, count });
          } else {
            const subSigs = {};
            subSigs[toolKey] = 1;
            const wf = {
              id: pid, type: "workflow", status: "pending",
              desc, count, context: ctx, scope: scopeFrom(exp),
              firstSeen: exp.date, lastSeen: exp.date,
              score: count * 3, tools: [...exp.toolsUsed],
              fix: hint, subSignatures: subSigs,
            };
            attachEvidence(wf, makeEvidence({ type: "turn", file: "experience_log.jsonl", date: exp.date, quote: exp.taskSummary || exp.userIntent }));
            this.patterns.set(pid, wf);
            this._indexPattern(pid, uniqueCats);
            newPatterns.push({ id: pid, type: "workflow", desc, count });
          }
        }
      }
    }

    if (exp.correction) {
      const ck = preferencePatternId(exp.correction);
      const existing = this.patterns.get(ck);
      const tier = preferenceTierFromText(exp.correction, exp.toolsUsed);
      if (!existing) {
        newPatterns.push({ id: ck, type: "preference", desc: `User correction: ${exp.correction}` });
      }
      if (existing) {
        existing.count += 1;
        existing.lastSeen = exp.date;
        existing.score += 3;
        if (tier === "durable") existing.knowledgeTier = "durable";
        else if (!existing.knowledgeTier) existing.knowledgeTier = "core";
        existing.tools = [...new Set([...(existing.tools || []), ...(exp.toolsUsed || [])])];
        if (!existing.context) existing.context = { taskType: exp.taskType || "general" };
        if (!existing.scope) existing.scope = scopeFrom(exp);
        attachEvidence(existing, makeEvidence({ type: "correction", file: "experience_log.jsonl", date: exp.date, quote: exp.correction }));
      } else {
        this.patterns.set(ck, {
          id: ck,
          type: "preference",
          knowledgeTier: tier,
          status: "pending",
          desc: `User correction: ${exp.correction}`,
          count: 1,
          firstSeen: exp.date,
          lastSeen: exp.date,
          score: 6,
          tools: exp.toolsUsed || [],
          context: { taskType: exp.taskType || "general" },
          scope: scopeFrom(exp),
          fix: exp.correction,
          evidence: [makeEvidence({ type: "correction", file: "experience_log.jsonl", date: exp.date, quote: exp.correction })],
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
    const activeCats = [...new Set((exp.toolsUsed || []).map(t => toolCategory(normalizeToolName(t))))].sort();
    const activeTask = exp.taskType || "general";
    if (activeCats.length < 2 && activeTask === "general") return;

    // Find the IDs of patterns that were just created or updated in this ingest call
    const targets = [];
    if (activeCats.length >= 2) {
      const catKey = activeCats.join("→");
      targets.push(`workflow:${catKey}`);
    }
    if (exp.correction) {
      targets.push(preferencePatternId(exp.correction));
    }

    // Use category index to avoid O(n²): only check patterns that share ≥1 category
    const candidateIds = new Set();
    for (const cat of activeCats) {
      for (const id of (this.catIndex.get(cat) || [])) {
        candidateIds.add(id);
      }
    }

    for (const targetId of targets) {
      const target = this.patterns.get(targetId);
      if (!target) continue;
      target.context = target.context || {};
      const rels = target.context.relations || [];

      for (const id of candidateIds) {
        if (id === targetId) continue;
        const stored = this.patterns.get(id);
        if (!stored) continue;
        if (stored.type === "capability" || stored.type === "host_capability") continue;

        const storedCats = new Set(stored.context?.categories || []);
        const catOverlap = activeCats.filter(c => storedCats.has(c)).length;
        const storedTasks = String(stored.context?.taskType || "general").split(",").map((item) => item.trim());
        const taskMatch = activeTask !== "general" && storedTasks.includes(activeTask);

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
    this._cacheDirty = true;
    const ek = `error:${err.errorType}`;
    const existing = this.patterns.get(ek);
    const inc = Math.max(1, err.severity || 1);
    const isNew = !existing;
    if (existing) {
      existing.count += 1;
      existing.lastSeen = err.date;
      existing.score += inc;
      if (err.candidateSkill && !existing.fix) existing.fix = err.candidateSkill;
      attachEvidence(existing, makeEvidence({ type: "error", file: "error_log.jsonl", date: err.date, quote: err.errorDesc }));
      return { pattern: existing, isNew: false };
    }
    // Classify into retry-safe vs. non-retryable categories
    const NON_RETRYABLE = new Set([
      "permission_denied",
      "command_not_found",
      "syntax_error",
      "path_error",
      "auth_error",
      "file_not_found",
    ]);
    const RETRY_ADVISORY = {
      permission_denied: "Do NOT retry the same command. Check file/folder permissions or ask the user for access.",
      command_not_found: "Do NOT retry the same command. The command is not available in this environment; use an alternative tool or approach.",
      syntax_error: "Do NOT retry the same command. Fix the syntax (quoting, escaping, path format) before re-running.",
      path_error: "Do NOT retry the same command. Verify the target path exists before re-running.",
      auth_error: "Do NOT retry without fixing credentials. Check API key validity and provider configuration.",
      file_not_found: "Do NOT retry the same read. Verify the file path, or use find/grep to locate it.",
      network_error: "Retry after a brief wait. If persistent, check connectivity, proxy, or provider status.",
      model_error: "Reduce input size or split the request before retrying.",
      tool_error: "Inspect the error message for root cause before retrying. Fix the underlying issue rather than re-running the identical command.",
    };
    const fix = err.candidateSkill
      || RETRY_ADVISORY[err.errorType]
      || "Check this failure mode before retrying the same action.";
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
      scope: scopeFrom(err),
      fix,
      retryable: !NON_RETRYABLE.has(err.errorType),
      evidence: [makeEvidence({ type: "error", file: "error_log.jsonl", date: err.date, quote: err.errorDesc })],
    };
    this.patterns.set(ek, pattern);
    return { pattern, isNew: true };
  }

  ingestUsage(entry = {}) {
    this._cacheDirty = true;
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

  pruneMemory() {
    let pruned = 0;
    // ── Durable cap (always enforced) ──────────────────────────────────────
    // Durable patterns (user preferences / pinned memory) never decay, so they
    // are not bounded by the strength-based prune below. Cap them by count,
    // latest-wins, mirroring the previous (ineffective) disk-side pruning in
    // index.js so this is now the single source of truth for retention.
    const durableMax = Math.max(1, Number(this.config?.durableMemoryMaxCount || DEFAULT_CONFIG.durableMemoryMaxCount));
    const durable = [...this.patterns.entries()]
      .filter(([, p]) => knowledgeTier(p) === "durable" && p.status !== "rejected");
    if (durable.length > durableMax) {
      durable.sort((a, b) =>
        String(b[1].lastSeen || b[1].firstSeen || b[1].date || "")
          .localeCompare(String(a[1].lastSeen || a[1].firstSeen || a[1].date || "")));
      for (const [id] of durable.slice(durableMax)) {
        this._forgetPattern(id);
        pruned += 1;
      }
    }

    // ── Score-floor prune: drop non-durable patterns that have decayed to
    // near-zero, even when the total pool hasn't hit the strength cap.
    // This prevents immortal core-tier preferences and stale low-score
    // patterns from accumulating indefinitely.
    for (const [id, p] of this.patterns.entries()) {
      // Durable and *manually* approved patterns are immune to decay. Auto-approved
      // patterns (p.autoApproved) are NOT — they still ride the forgetting curve,
      // otherwise any pattern that briefly cleared the confidence bar would live
      // forever and the decay model would never apply to the common case.
      if (knowledgeTier(p) === "durable" || (p.status === "approved" && !p.autoApproved)) continue;
      if (decayedScore(p, this.config) < 1) {
        this._forgetPattern(id);
        pruned += 1;
      }
    }

    // ── Strength-based cap for the rest ────────────────────────────────────
    if (this.patterns.size <= MAX_PATTERN_COUNT * 2) return pruned;
    // Keep approved, durable, and high-strength patterns; drop weakest
    const entries = [...this.patterns.entries()].map(([id, p]) => ({
      id,
      // Same rule as the score-floor prune: auto-approved patterns are not
      // unconditionally kept, so the weakest of them can be evicted under the cap.
      keep: (p.status === "approved" && !p.autoApproved) || knowledgeTier(p) === "durable",
      strength: memoryStrength(p, this.config),
    }));
    entries.sort((a, b) => {
      if (a.keep !== b.keep) return a.keep ? -1 : 1;
      return b.strength - a.strength;
    });
    const limit = MAX_PATTERN_COUNT * 2;
    for (let i = limit; i < entries.length; i++) {
      if (!entries[i].keep) {
        this._forgetPattern(entries[i].id);
        pruned += 1;
      }
    }
    return pruned;
  }

  all() {
    if (!this._cacheDirty && this._cachedAll) return this._cachedAll;

    this._cachedAll = [...this.patterns.values()]
      .filter(pattern => {
        // Skip old single-tool workflow chains (pre-category migration)
        if (pattern.type === "workflow" && Array.isArray(pattern.tools) && pattern.tools.length >= 2) {
          if (new Set(pattern.tools).size === 1) return false;
        }
        // Skip generic noise
        if (knowledgeTier(pattern) === "ephemeral") return false;
        return true;
      })
      .map((pattern) => ({
        ...pattern,
        knowledgeTier: knowledgeTier(pattern),
        status: patternStatus(pattern),
        decayedScore: Number(decayedScore(pattern, this.config).toFixed(2)),
        injectable: isInjectable(pattern, this.config),
      }))
      .sort((a, b) => (b.decayedScore || 0) - (a.decayedScore || 0));

    this._cacheDirty = false;
    return this._cachedAll;
  }

  highConfidence() {
    return this.all().filter((p) => p.injectable).slice(0, 8);
  }

  prefs() {
    return this.all().filter((p) => p.type === "preference" && p.fix && p.injectable).slice(0, 8);
  }
}
