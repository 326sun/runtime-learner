import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { DEFAULT_CONFIG, decoratePatterns, readJson, writeJson } from "../lib/common.js";
import { applyPolicyProfile } from "../lib/policy-profiles.js";
import { readEvents } from "../lib/event-log.js";
import { listProposals } from "../lib/proposals.js";
import { listReviews } from "../lib/review-queue.js";
import { runSearch } from "../tools/search.js";
import { execute as executeControl } from "../tools/control.js";
import {
  FakeEventBus,
  createFakeRuntimeContext,
  emitCorrectionTurn,
  emitErrorTurn,
  emitSuccessfulTurn,
} from "./fixtures/fake-hanako-runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-runtime-e2e-"));
const homeDir = path.join(tempRoot, "hana-home");
const pluginDir = path.join(tempRoot, "plugin");
const dataDir = path.join(homeDir, "self-learning");
const configPath = path.join(dataDir, "config.json");
const patternsPath = path.join(dataDir, "patterns.json");
const skillPath = path.join(pluginDir, "skills", "self-learning", "SKILL.md");

let RuntimePlugin;
let previousHome;

// The plugin fire-and-forgets pruneActivityLog() (index.js), so a background
// async write to activity_log.jsonl can still hold the file when we tear down.
// On Linux that's fine (open files unlink freely); on Windows it's an EPERM/
// ENOTEMPTY lock. We must use the *async* fs.promises.rm here: its retryDelay
// yields to the event loop so the pending prune can finish and release the
// handle. Synchronous fs.rmSync would block the loop during its retry sleep,
// so the prune never completes — which is why this only failed on Win 18/20.
const RM_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

async function resetDisk(config = null) {
  await fs.promises.rm(homeDir, RM_OPTS);
  await fs.promises.rm(pluginDir, RM_OPTS);
  fs.mkdirSync(pluginDir, { recursive: true });
  if (config) writeJson(configPath, config);
}

async function startRuntime({ config = null } = {}) {
  await resetDisk(config);
  const bus = new FakeEventBus();
  const ctx = createFakeRuntimeContext({ pluginDir, bus });
  const plugin = new RuntimePlugin();
  plugin.ctx = ctx;
  await plugin.onload();
  return { bus, ctx, plugin };
}

function readPatterns() {
  return readJson(patternsPath, []);
}

describe("runtime E2E with fake Hanako EventBus", () => {
  before(async () => {
    previousHome = process.env.HANA_HOME;
    process.env.HANA_HOME = homeDir;
    RuntimePlugin = (await import(`${pathToFileURL(path.join(root, "index.js")).href}?runtime_e2e=${Date.now()}`)).default;
  });

  beforeEach(async () => {
    await resetDisk();
  });

  after(async () => {
    if (previousHome == null) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
    await fs.promises.rm(tempRoot, RM_OPTS);
  });

  it("learns a repeated workflow and refreshes the generated skill", async () => {
    const { bus, plugin } = await startRuntime();
    const sessionPath = path.join(tempRoot, "sessions", "workflow-project", "turn.jsonl");

    for (let i = 0; i < 3; i++) {
      emitSuccessfulTurn(bus, sessionPath, {
        userText: "read the target file and edit the implementation",
        tools: ["read", "edit"],
      });
    }

    await plugin.onunload();

    const patterns = readPatterns();
    const workflow = patterns.find((pattern) => pattern.type === "workflow");
    assert.ok(workflow, "workflow pattern should be created");
    assert.equal(workflow.count >= 3, true);
    assert.equal(workflow.status, "approved");

    const decorated = decoratePatterns(patterns, DEFAULT_CONFIG);
    assert.equal(decorated.find((pattern) => pattern.id === workflow.id)?.injectable, true);
    assert.match(fs.readFileSync(skillPath, "utf-8"), /跨类别工作流/);
  });

  it("captures a user correction as pending searchable preference without injecting it", async () => {
    const { bus, plugin } = await startRuntime();
    const sessionPath = path.join(tempRoot, "sessions", "paper-project", "turn.jsonl");

    emitCorrectionTurn(bus, sessionPath, "下次记住，我写论文时 mAP50 是主指标，不是 mAP50-95。");

    await plugin.onunload();

    const patterns = readPatterns();
    const preference = patterns.find((pattern) => pattern.type === "preference");
    assert.ok(preference, "preference pattern should be created");
    assert.equal(preference.status, "pending");
    assert.equal(decoratePatterns(patterns, DEFAULT_CONFIG).find((pattern) => pattern.id === preference.id)?.injectable, false);

    const skill = fs.readFileSync(skillPath, "utf-8");
    assert.equal(skill.includes("mAP50 是主指标"), false);

    const search = runSearch(patterns, "论文 mAP50 主指标", { config: DEFAULT_CONFIG, type: "preference", limit: 5 });
    assert.ok(search.results.some((result) => result.id === preference.id));
  });

  it("turns repeated tool errors into a reviewable non-auto-applicable code proposal", async () => {
    const { bus, plugin } = await startRuntime();
    const sessionPath = path.join(tempRoot, "sessions", "error-project", "turn.jsonl");

    for (let i = 0; i < 3; i++) {
      emitErrorTurn(bus, sessionPath, {
        toolName: "read",
        error: "ENOENT: no such file or directory, open missing.txt",
      });
    }

    await plugin.onunload();

    const errorPattern = readPatterns().find((pattern) => pattern.type === "error" && pattern.id === "error:file_not_found");
    assert.ok(errorPattern, "file_not_found error pattern should be created");
    assert.equal(errorPattern.count, 3);
    assert.equal(Array.isArray(errorPattern.repairPlan?.repairPlan), true);

    const proposal = listProposals(dataDir, { status: "pending" }).find((item) => item.type === "code_patch");
    assert.ok(proposal, "code_patch proposal should be created");
    assert.ok(listReviews(dataDir).some((review) => review.proposalId === proposal.id));

    await assert.rejects(
      () => executeControl({ action: "apply_proposal", proposalId: proposal.id }, { pluginDir }),
      /code_patch proposals cannot be auto-applied/
    );
  });

  it("does not create code_patch proposals from unknown error buckets", async () => {
    const { bus, plugin } = await startRuntime();
    const sessionPath = path.join(tempRoot, "sessions", "unknown-error-project", "turn.jsonl");

    for (let i = 0; i < 3; i++) {
      emitErrorTurn(bus, sessionPath, {
        toolName: "bash",
        error: "opaque failure without classifier keywords",
      });
    }

    await plugin.onunload();

    const unknownPattern = readPatterns().find((pattern) => pattern.type === "error" && pattern.id === "error:unknown");
    assert.ok(unknownPattern, "unknown error pattern should still be tracked for diagnostics");
    assert.equal(unknownPattern.count, 3);
    assert.equal(listProposals(dataDir, { status: "pending" }).some((item) => item.type === "code_patch"), false);
  });

  it("does not create code_patch proposals from large-context usage patterns", async () => {
    const { bus, plugin } = await startRuntime({ config: { ...DEFAULT_CONFIG, largeUsageTokenThreshold: 100 } });
    const sessionPath = path.join(tempRoot, "sessions", "large-context-project", "turn.jsonl");

    for (let i = 0; i < 3; i++) {
      bus.emit({
        type: "llm_usage",
        entry: {
          requestId: `large-context-${i}`,
          status: "success",
          model: { provider: "pixel api", modelId: "gpt-5.5" },
          source: { subsystem: "chat", operation: "completion" },
          usage: { totalTokens: 500 },
          endedAt: new Date().toISOString(),
        },
      }, sessionPath);
    }

    await plugin.onunload();

    const largeContextPattern = readPatterns().find((pattern) => pattern.id === "usage:large_context:pixel_api_gpt-5.5");
    assert.ok(largeContextPattern, "large-context usage pattern should still be tracked as an advisory");
    assert.equal(listProposals(dataDir, { status: "pending" }).some((item) => item.type === "code_patch"), false);
  });

  it("keeps conservative skill proposals review-first and records the audit trail", async () => {
    const conservative = applyPolicyProfile(DEFAULT_CONFIG, "conservative").config;
    const { plugin } = await startRuntime({ config: conservative });

    await plugin.onunload();

    const proposal = listProposals(dataDir, { status: "pending" }).find((item) => item.type === "skill_patch");
    assert.ok(proposal, "strict mode should queue a skill_patch proposal");

    await assert.rejects(
      () => executeControl({ action: "apply_proposal", proposalId: proposal.id }, { pluginDir }),
      /conservative profile requires review-first/
    );
    await assert.rejects(
      () => executeControl({ action: "apply_review", proposalId: proposal.id }, { pluginDir }),
      /review must be approved/
    );

    const approved = JSON.parse(await executeControl({ action: "approve_review", proposalId: proposal.id }, { pluginDir }));
    assert.equal(approved.review.status, "approved");
    const applied = JSON.parse(await executeControl({ action: "apply_review", proposalId: proposal.id }, { pluginDir }));
    assert.equal(applied.proposal.status, "applied");

    const eventTypes = readEvents(dataDir, { limit: 100 }).map((event) => event.type);
    assert.ok(eventTypes.includes("proposal.created"));
    assert.ok(eventTypes.includes("review.approved"));
    assert.ok(eventTypes.includes("proposal.applied"));
  });
});
