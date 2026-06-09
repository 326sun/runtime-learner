import fs from "fs";
import path from "path";
import { DEFAULT_CONFIG, readJson, writeJson, loadLearnerConfig, decoratePatterns, hanakoHome, learnerDir as resolveLearnerDir, buildSkillMdFromPatterns } from "../lib/common.js";
import { defineTool } from "../lib/hana-runtime-compat.js";
import { sanitizeAdvice } from "../lib/helpers.js";
import { runModelAdvisor } from "../lib/model-advisor.js";
import { applyProposal, listProposals, readProposal, rejectProposal } from "../lib/proposals.js";
import { writeSkillIfChanged } from "../lib/skill-lifecycle.js";
import { runDoctorFromDisk, formatReport } from "./doctor.js";
import { generateMemFS } from "../lib/memfs.js";
import { loadFacts } from "../lib/facts.js";

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
        enum: ["status", "list", "approve", "reject", "set_config", "rollback", "regenerate_skill", "regenerate_memfs", "run_model_advisor", "list_proposals", "show_proposal", "apply_proposal", "reject_proposal", "doctor", "diagnose_bus"],
        description: "Control action to run.",
      },
      id: { type: "string", description: "Pattern id for approve/reject." },
      proposalId: { type: "string", description: "Proposal id for show/apply/reject proposal actions." },
      reason: { type: "string", description: "Optional reason for proposal rejection." },
      status: { type: "string", description: "Optional proposal status filter: pending, applied, or rejected." },
      format: { type: "string", enum: ["text", "json"], description: "Output format for the doctor action. Default text." },
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
      semanticSearchEnabled: { type: "boolean", description: "Enable semantic retrieval (RRF over BM25 + embeddings). Sends memory text to your embedding endpoint when on." },
      semanticEmbeddingBaseUrl: { type: "string", description: "OpenAI-compatible base URL for the embeddings endpoint." },
      semanticEmbeddingApiKey: { type: "string", description: "API key for the embeddings endpoint." },
      semanticEmbeddingModel: { type: "string", description: "Embedding model id." },
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
      return JSON.stringify({
        config,
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
