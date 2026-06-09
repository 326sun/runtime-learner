import fs from "fs";
import path from "path";
import { DEFAULT_CONFIG, readJson, writeJson, loadLearnerConfig, decoratePatterns, hanakoHome, learnerDir as resolveLearnerDir, buildSkillMdFromPatterns } from "../lib/common.js";
import { defineTool } from "../lib/hana-runtime-compat.js";
import { sanitizeAdvice } from "../lib/helpers.js";
import { runModelAdvisor } from "../lib/model-advisor.js";
import { applyProposal, listProposals, readProposal, rejectProposal } from "../lib/proposals.js";
import { previewProposalDiff } from "../lib/diff-preview.js";
import { validateProposal } from "../lib/validation-gate.js";
import { enqueueReviewForProposal, listReviews, readReview, reviewPanel, updateReviewStatus } from "../lib/review-queue.js";
import { readEvents, appendEvent, replayEventState } from "../lib/event-log.js";
import { writeSkillIfChanged } from "../lib/skill-lifecycle.js";
import { runDoctorFromDisk, formatReport } from "./doctor.js";
import { generateMemFS } from "../lib/memfs.js";
import { loadFacts } from "../lib/facts.js";
import { applyPolicyProfile, listPolicyProfiles } from "../lib/policy-profiles.js";
import { buildAuditBundle, exportAuditBundle } from "../lib/audit-bundle.js";

const MAX_SKILL_HISTORY = 20;

function paths(ctx) {
  const learnerDir = resolveLearnerDir();
  const pluginDir = ctx?.pluginDir || path.join(hanakoHome(), "plugins", "hanako-runtime-learner");
  return {
    learnerDir,
    pluginDir,
    configPath: path.join(learnerDir, "config.json"),
    patternsPath: path.join(learnerDir, "patterns.json"),
    historyDir: path.join(learnerDir, "skill_history"),
    proposalsDir: path.join(learnerDir, "proposals"),
    skillPath: path.join(pluginDir, "skills", "self-learning", "SKILL.md"),
  };
}

function loadConfig(configPath) {
  return loadLearnerConfig(configPath, { persist: true });
}

function buildSkill(patterns, config, learnerDir) {
  return buildSkillMdFromPatterns(patterns, config, { dataDir: learnerDir });
}

function regenerateSkill(pathsValue, patterns, config) {
  return writeSkillIfChanged(
    pathsValue.skillPath,
    buildSkill(patterns, config, pathsValue.learnerDir),
    pathsValue.historyDir,
    { keep: MAX_SKILL_HISTORY },
  );
}

const tool = defineTool({
  name: "self_learning_control",
  description: "Review and control the runtime self-learning engine: list patterns, approve/reject hints, update injection config, or roll back the generated skill.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "list", "approve", "reject", "set_config", "rollback", "regenerate_skill", "regenerate_memfs", "run_model_advisor", "list_proposals", "show_proposal", "apply_proposal", "reject_proposal", "review_panel", "preview_proposal", "validate_proposal", "approve_review", "reject_review", "apply_review", "list_reviews", "list_events", "event_summary", "doctor", "list_policy_profiles", "set_policy_profile", "export_audit_bundle", "diagnose_bus"],
        description: "Control action to run.",
      },
      id: { type: "string", description: "Pattern id for approve/reject." },
      proposalId: { type: "string", description: "Proposal id for show/apply/reject proposal actions." },
      reason: { type: "string", description: "Optional reason for proposal rejection." },
      status: { type: "string", description: "Optional proposal status filter: pending, applied, or rejected." },
      format: { type: "string", enum: ["text", "json"], description: "Output format for the doctor action. Default text." },
      governanceProfile: { type: "string", enum: ["conservative", "balanced", "autonomous"], description: "Governance policy profile to apply." },
      limit: { type: "number", description: "Maximum number of events/reviews to return for list actions." },
      autoInjectHighConfidence: { type: "boolean", description: "Whether high-confidence pending patterns can be injected automatically." },
      autoApproveHighConfidence: { type: "boolean", description: "Whether high-confidence pending patterns are automatically approved (no manual review needed)." },
      minInjectScore: { type: "number", description: "Minimum decayed score for automatic injection." },
      minInjectCount: { type: "number", description: "Minimum repeat count for automatic injection." },
      decayHalfLifeDays: { type: "number", description: "Score half-life in days." },
      includePendingPreferences: { type: "boolean", description: "Whether detected user corrections can be injected before manual approval." },
      learnFromUsage: { type: "boolean", description: "Whether usage metadata can influence learned hints." },
      officialMemoryBridgeEnabled: { type: "boolean", description: "Whether self_learning_search can include read-only Hanako official memory results." },
      officialMemoryBridgeMaxResults: { type: "number", description: "Maximum official memory bridge results to include in search." },
      durableMemoryMaxCount: { type: "number", description: "Maximum durable preference/settings patterns to retain." },
      largeUsageTokenThreshold: { type: "number", description: "Token threshold for large-context usage hints." },
      officialUtilityModelDisplay: { type: "string", description: "Read-only display label for the current Hanako utility model." },
      modelAdvisorEnabled: { type: "boolean", description: "Whether the private small-model advisor can run." },
      modelAdvisorSource: { type: "string", enum: ["official", "private", "off"], description: "Advisor source. official uses Hanako utility model config when possible." },
      modelAdvisorBaseUrl: { type: "string", description: "OpenAI-compatible base URL for the private advisor." },
      modelAdvisorApiKey: { type: "string", description: "API key for the private advisor." },
      modelAdvisorModel: { type: "string", description: "Model id for the private advisor." },
      modelAdvisorMaxTokens: { type: "number", description: "Maximum output tokens for advisor calls." },
      modelAdvisorMinIntervalMinutes: { type: "number", description: "Minimum interval between advisor calls." },
      workStatusEnabled: { type: "boolean", description: "Whether to send a short status message when self-learning work completes." },
      workStatusText: { type: "string", description: "Status message prefix." },
      proposalChatNotificationsEnabled: { type: "boolean", description: "Whether to send chat messages when new high-risk improvement proposals are created." },
      requireReviewForAutoApply: { type: "boolean", description: "Strict governance mode: queue auto-apply proposals until their review is approved." },
      semanticSearchEnabled: { type: "boolean", description: "Enable semantic retrieval (RRF over BM25 + embeddings). Sends memory text to your embedding endpoint when on." },
      semanticEmbeddingBaseUrl: { type: "string", description: "OpenAI-compatible base URL for the embeddings endpoint." },
      semanticEmbeddingApiKey: { type: "string", description: "API key for the embeddings endpoint." },
      semanticEmbeddingModel: { type: "string", description: "Embedding model id." },
      semanticCacheMaxEntries: { type: "number", description: "Maximum entries to keep in embeddings_cache.json." },
    },
    required: ["action"],
  },
  async execute(input = {}, ctx) {
    const p = paths(ctx);
    const config = loadConfig(p.configPath);
    const patterns = readJson(p.patternsPath, []);
    const action = input.action;

    if (action === "status") {
      const decorated = decoratePatterns(patterns, config);
      let history = [];
      try {
        history = fs.readdirSync(p.historyDir).filter((name) => name.endsWith("-SKILL.md")).sort();
      } catch {}
      // Redact secrets in the config snapshot before returning it to the caller.
      const safeConfig = { ...config };
      const SENSITIVE_KEYS = new Set(["modelAdvisorApiKey", "semanticEmbeddingApiKey"]);
      for (const k of Object.keys(safeConfig)) {
        if (SENSITIVE_KEYS.has(k) && safeConfig[k]) safeConfig[k] = "***";
      }
      return JSON.stringify({
        config: safeConfig,
        patterns: decorated.length,
        injectable: decorated.filter((x) => x.injectable).length,
        pending: decorated.filter((x) => x.status === "pending").length,
        approved: decorated.filter((x) => x.status === "approved").length,
        rejected: decorated.filter((x) => x.status === "rejected").length,
        historySnapshots: history.length,
        proposals: {
          pending: listProposals(p.learnerDir, { status: "pending" }).length,
          applied: listProposals(p.learnerDir, { status: "applied" }).length,
          rejected: listProposals(p.learnerDir, { status: "rejected" }).length,
          dir: p.proposalsDir,
        },
        reviews: {
          queued: listReviews(p.learnerDir, { status: "queued" }).length,
          blocked: listReviews(p.learnerDir, { status: "blocked" }).length,
          approved: listReviews(p.learnerDir, { status: "approved" }).length,
        },
        dataDir: p.learnerDir,
      }, null, 2);
    }

    if (action === "list") {
      return JSON.stringify(decoratePatterns(patterns, config).slice(0, 20).map((pattern) => ({
        id: pattern.id,
        type: pattern.type,
        status: pattern.status,
        count: pattern.count,
        score: pattern.score,
        decayedScore: pattern.decayedScore,
        knowledgeTier: pattern.knowledgeTier,
        injectable: pattern.injectable,
        desc: pattern.desc,
        fix: pattern.fix || null,
      })), null, 2);
    }

    if (action === "approve" || action === "reject") {
      fs.mkdirSync(p.learnerDir, { recursive: true });
      fs.mkdirSync(p.historyDir, { recursive: true });
      if (!input.id) throw new Error("id is required for approve/reject");
      const target = patterns.find((pattern) => pattern.id === input.id);
      if (!target) throw new Error(`pattern not found: ${input.id}`);
      target.status = action === "approve" ? "approved" : "rejected";
      if (action === "approve") {
        if (target.type === "preference") target.knowledgeTier = "durable";
        // A manual approval outranks a prior machine approval: clear the
        // autoApproved flag so pruneMemory treats it as user-blessed (immortal),
        // not as a still-decaying auto-approved pattern.
        delete target.autoApproved;
      }
      target.reviewedAt = new Date().toISOString();
      writeJson(p.patternsPath, patterns);
      regenerateSkill(p, patterns, config);
      return JSON.stringify({ ok: true, id: target.id, status: target.status }, null, 2);
    }

    if (action === "set_config") {
      fs.mkdirSync(p.learnerDir, { recursive: true });
      fs.mkdirSync(p.historyDir, { recursive: true });
      const next = { ...config };
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (Object.prototype.hasOwnProperty.call(input, key)) next[key] = input[key];
      }
      writeJson(p.configPath, next);
      regenerateSkill(p, patterns, next);
      return JSON.stringify({ ok: true, config: next }, null, 2);
    }

    if (action === "regenerate_skill") {
      fs.mkdirSync(p.learnerDir, { recursive: true });
      fs.mkdirSync(p.historyDir, { recursive: true });
      regenerateSkill(p, patterns, config);
      return JSON.stringify({ ok: true, skillPath: p.skillPath }, null, 2);
    }

    if (action === "list_proposals") {
      const status = input.status || null;
      return JSON.stringify(listProposals(p.learnerDir, { status, limit: 30 }).map((proposal) => ({
        id: proposal.id,
        type: proposal.type,
        title: proposal.title,
        risk: proposal.risk,
        status: proposal.status,
        autoApply: proposal.autoApply,
        reason: proposal.reason,
        updatedAt: proposal.updatedAt,
        triggerPatternIds: proposal.triggerPatternIds || [],
      })), null, 2);
    }

    if (action === "show_proposal") {
      if (!input.proposalId && !input.id) throw new Error("proposalId is required");
      const proposal = readProposal(p.learnerDir, input.proposalId || input.id);
      if (!proposal) throw new Error(`proposal not found: ${input.proposalId || input.id}`);
      return JSON.stringify(proposal, null, 2);
    }

    if (action === "preview_proposal") {
      if (!input.proposalId && !input.id) throw new Error("proposalId is required");
      const proposal = readProposal(p.learnerDir, input.proposalId || input.id);
      if (!proposal) throw new Error(`proposal not found: ${input.proposalId || input.id}`);
      const preview = previewProposalDiff(proposal, { configPath: p.configPath });
      enqueueReviewForProposal(p.learnerDir, proposal, { configPath: p.configPath, config });
      appendEvent(p.learnerDir, { type: "proposal.previewed", entityType: "proposal", entityId: proposal.id, summary: `Previewed proposal: ${proposal.id}` });
      return JSON.stringify(preview, null, 2);
    }

    if (action === "validate_proposal") {
      if (!input.proposalId && !input.id) throw new Error("proposalId is required");
      const proposal = readProposal(p.learnerDir, input.proposalId || input.id);
      if (!proposal) throw new Error(`proposal not found: ${input.proposalId || input.id}`);
      const validation = validateProposal(proposal, { config, doctorReport: runDoctorFromDisk(p.learnerDir) });
      const review = enqueueReviewForProposal(p.learnerDir, proposal, { configPath: p.configPath, config });
      if (review) updateReviewStatus(p.learnerDir, review.id, validation.ok ? "queued" : "blocked", { validation });
      appendEvent(p.learnerDir, { type: "proposal.validated", entityType: "proposal", entityId: proposal.id, summary: `Validated proposal: ${proposal.id}`, data: { ok: validation.ok } });
      return JSON.stringify(validation, null, 2);
    }

    if (action === "review_panel") {
      const report = runDoctorFromDisk(p.learnerDir);
      return JSON.stringify(reviewPanel(p.learnerDir, { proposals: listProposals(p.learnerDir, { limit: 100 }), doctorReport: report }), null, 2);
    }

    if (action === "list_reviews") {
      return JSON.stringify(listReviews(p.learnerDir, { status: input.status || null, limit: 50 }), null, 2);
    }

    if (action === "approve_review" || action === "reject_review") {
      const reviewId = input.id || (input.proposalId ? `review:${input.proposalId}` : null);
      if (!reviewId) throw new Error("id or proposalId is required");
      const review = readReview(p.learnerDir, reviewId);
      if (!review) throw new Error(`review not found: ${reviewId}`);
      const next = updateReviewStatus(p.learnerDir, reviewId, action === "approve_review" ? "approved" : "rejected", { reason: input.reason || "" });
      return JSON.stringify({ ok: true, review: next }, null, 2);
    }

    if (action === "apply_review") {
      const reviewId = input.id || (input.proposalId ? `review:${input.proposalId}` : null);
      if (!reviewId) throw new Error("id or proposalId is required");
      const review = readReview(p.learnerDir, reviewId);
      if (!review) throw new Error(`review not found: ${reviewId}`);
      if (review.status !== "approved") throw new Error(`review must be approved before apply: ${reviewId}`);
      const applied = applyProposal(p.learnerDir, review.proposalId, { configPath: p.configPath, requireReview: true });
      return JSON.stringify({ ok: true, reviewId, proposal: applied }, null, 2);
    }

    if (action === "list_events") {
      return JSON.stringify({ ok: true, events: readEvents(p.learnerDir, { limit: input.limit || 50, entityId: input.id || null }) }, null, 2);
    }

    if (action === "event_summary") {
      const events = readEvents(p.learnerDir, { limit: input.limit || 5000, entityId: input.id || null });
      return JSON.stringify({ ok: true, summary: replayEventState(events) }, null, 2);
    }

    if (action === "apply_proposal") {
      if (!input.proposalId && !input.id) throw new Error("proposalId is required");
      const applied = applyProposal(p.learnerDir, input.proposalId || input.id, { configPath: p.configPath });
      return JSON.stringify({ ok: true, proposal: applied }, null, 2);
    }

    if (action === "reject_proposal") {
      if (!input.proposalId && !input.id) throw new Error("proposalId is required");
      const rejected = rejectProposal(p.learnerDir, input.proposalId || input.id, input.reason || "");
      return JSON.stringify({ ok: true, proposal: rejected }, null, 2);
    }

    if (action === "run_model_advisor") {
      const usage = readJson(path.join(p.learnerDir, "usage_summary.json"), null);
      const capabilities = readJson(path.join(p.learnerDir, "host_capabilities.json"), null);
      const result = await runModelAdvisor({
        config: { ...config, modelAdvisorEnabled: true },
        patterns: decoratePatterns(patterns, config),
        usage,
        capabilities,
        reason: "manual",
      });
      if (result.ok) {
        // Merge distilled advice back into patterns before regenerating, so the
        // manual run actually changes SKILL.md — mirroring the plugin runtime's
        // advisor path. Without this the advice lands only in model_advice.json
        // and regenerateSkill rebuilds from unchanged patterns (a no-op).
        let merged = 0;
        for (const s of result.advice?.suggestions || []) {
          const stored = patterns.find((pattern) => pattern.id === s.patternId);
          if (!stored || stored.status === "approved") continue;
          const advice = sanitizeAdvice(s.advice);
          if (advice && advice !== stored.fix) {
            stored.fix = advice;
            stored.advisorUpdatedAt = new Date().toISOString();
            merged += 1;
          }
        }
        if (merged > 0) writeJson(p.patternsPath, patterns);
        regenerateSkill(p, patterns, config);
        return JSON.stringify({ ...result, merged }, null, 2);
      }
      return JSON.stringify(result, null, 2);
    }

    if (action === "rollback") {
      fs.mkdirSync(p.learnerDir, { recursive: true });
      fs.mkdirSync(p.historyDir, { recursive: true });
      const history = fs.readdirSync(p.historyDir).filter((name) => name.endsWith("-SKILL.md")).sort();
      const latest = history.at(-1);
      if (!latest) throw new Error("no skill history snapshot available");
      fs.mkdirSync(path.dirname(p.skillPath), { recursive: true });
      fs.copyFileSync(path.join(p.historyDir, latest), p.skillPath);
      appendEvent(p.learnerDir, { type: "skill.rolled_back", entityType: "skill", entityId: p.skillPath, summary: `Rolled back SKILL.md to ${latest}` });
      return JSON.stringify({ ok: true, restored: latest, skillPath: p.skillPath }, null, 2);
    }

    if (action === "regenerate_memfs") {
      const facts = loadFacts(p.learnerDir);
      const result = generateMemFS(p.learnerDir, { patterns, facts, config });
      return JSON.stringify({ ok: true, ...result }, null, 2);
    }

    if (action === "doctor") {
      const report = runDoctorFromDisk(p.learnerDir);
      if (input.format === "json") return JSON.stringify(report, null, 2);
      return formatReport(report);
    }

    if (action === "list_policy_profiles") {
      return JSON.stringify({ ok: true, profiles: listPolicyProfiles(), current: config.governanceProfile || "balanced" }, null, 2);
    }

    if (action === "set_policy_profile") {
      const profileName = input.governanceProfile || input.id || "balanced";
      const result = applyPolicyProfile(config, profileName);
      if (!result.ok) throw new Error(result.error);
      writeJson(p.configPath, result.config);
      appendEvent(p.learnerDir, {
        type: "policy.applied",
        entityType: "config",
        entityId: "governanceProfile",
        summary: `Applied governance profile: ${result.profile}`,
        data: { profile: result.profile, changed: result.changed },
      });
      regenerateSkill(p, patterns, result.config);
      return JSON.stringify({ ok: true, profile: result.profile, changed: result.changed, config: result.config }, null, 2);
    }

    if (action === "export_audit_bundle") {
      const proposals = listProposals(p.learnerDir, { limit: 500 });
      const reviews = listReviews(p.learnerDir, { limit: 500 });
      const events = readEvents(p.learnerDir, { limit: input.limit || 5000 });
      const facts = loadFacts(p.learnerDir);
      const doctorReport = runDoctorFromDisk(p.learnerDir);
      const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(p.pluginDir, "package.json"), "utf-8")).version; } catch { return "unknown"; } })();
      const bundle = buildAuditBundle({
        version,
        config,
        patterns,
        facts,
        proposals,
        reviews,
        events,
        eventSummary: replayEventState(events),
        doctor: doctorReport,
      });
      const written = exportAuditBundle(p.learnerDir, bundle);
      appendEvent(p.learnerDir, {
        type: "audit.exported",
        entityType: "audit",
        entityId: path.basename(written.dir),
        summary: "Exported local audit bundle",
        data: { dir: written.dir, doctorStatus: doctorReport.status },
      });
      return JSON.stringify({ ok: true, ...written, summary: bundle.summary }, null, 2);
    }

    if (action === "diagnose_bus") {
      const diag = {
        hasBus: !!ctx?.bus,
        hasRequest: typeof ctx?.bus?.request === "function",
        hasGetCapability: typeof ctx?.bus?.getCapability === "function",
        hasHasHandler: typeof ctx?.bus?.hasHandler === "function",
        sessionSendCap: null,
        sessionSendTest: null,
      };
      try {
        diag.sessionSendCap = ctx?.bus?.getCapability?.("session:send") || null;
      } catch (e) { diag.sessionSendCap = { error: e.message }; }
      try {
        if (input.sessionPath) {
          const result = await ctx.bus.request("session:send", {
            sessionPath: input.sessionPath,
            text: "[self-evolve diagnostic] session:send test",
          });
          diag.sessionSendTest = { ok: true, result };
        } else {
          diag.sessionSendTest = { skipped: "no sessionPath provided in input" };
        }
      } catch (e) {
        diag.sessionSendTest = { ok: false, error: e.message, stack: e.stack?.slice(0, 300) };
      }
      return JSON.stringify(diag, null, 2);
    }

    throw new Error(`unknown action: ${action}`);
  },
});

export const { name, description, parameters, execute } = tool;
