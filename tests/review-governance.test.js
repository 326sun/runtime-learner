import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { buildCodePatchProposal, buildSkillPatchProposal, applyProposal, rejectProposal } from "../lib/proposals.js";
import { previewProposalDiff } from "../lib/proposals.js";
import { validateProposal } from "../lib/validation-gate.js";
import { listReviews, reviewIdForProposal, updateReviewStatus, reviewPanel } from "../lib/review-queue.js";
import { readEvents, replayEventState } from "../lib/event-log.js";
import { loadSkillRegistry } from "../lib/skill-lifecycle.js";
import { DEFAULT_CONFIG, writeJson } from "../lib/common.js";
import { execute as executeControl } from "../tools/control.js";

const tmpDir = path.join(os.tmpdir(), `learner-review-test-${Date.now()}`);
const savedHanaHome = process.env.HANA_HOME;

describe("review governance", () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    delete process.env.HANA_HOME;
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedHanaHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = savedHanaHome;
  });

  it("creates a review item and diff preview for skill_patch proposals", () => {
    const skillPath = path.join(tmpDir, "plugin", "skills", "self-learning", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "# Runtime Self-Learning\n\nold\n", "utf-8");
    const proposal = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content: "# Runtime Self-Learning\n\nnew\n" });
    const reviews = listReviews(tmpDir);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].proposalId, proposal.id);
    assert.equal(reviews[0].validation.ok, true);
    assert.ok(reviews[0].diffPreview.diff.some((line) => line.startsWith("+ new")));

    const preview = previewProposalDiff(proposal);
    assert.equal(preview.ok, true);
    assert.equal(preview.addedLines >= 1, true);
  });

  it("validation gate blocks invalid skill patches", () => {
    const bad = { id: "skill_patch:bad", type: "skill_patch", patch: { content: "no header" }, target: { skillPath: "SKILL.md" } };
    const result = validateProposal(bad);
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((c) => c.name === "skill_header" && c.status === "fail"));
  });

  it("apply records events and skill registry state", () => {
    const skillPath = path.join(tmpDir, "plugin", "skills", "self-learning", "SKILL.md");
    const content = "# Runtime Self-Learning\n\nUpdated governance hint.\n";
    const proposal = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content, triggerPatternIds: ["workflow:test"] });
    updateReviewStatus(tmpDir, reviewIdForProposal(proposal), "approved");
    const applied = applyProposal(tmpDir, proposal.id);
    assert.equal(applied.status, "applied");
    assert.equal(fs.readFileSync(skillPath, "utf-8"), content);
    const registry = loadSkillRegistry(tmpDir);
    assert.equal(registry[skillPath].status, "active");
    assert.equal(registry[skillPath].sourceProposalId, proposal.id);
    assert.ok(readEvents(tmpDir, { limit: 20 }).some((evt) => evt.type === "proposal.applied"));
  });

  it("rejected proposals update review and event log", () => {
    const skillPath = path.join(tmpDir, "SKILL.md");
    const proposal = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content: "# Runtime Self-Learning\n" });
    const rejected = rejectProposal(tmpDir, proposal.id, "not needed");
    assert.equal(rejected.status, "rejected");
    const reviews = listReviews(tmpDir, { status: "rejected" });
    assert.equal(reviews.length, 1);
    assert.ok(readEvents(tmpDir, { limit: 20 }).some((evt) => evt.type === "proposal.rejected"));
  });


  it("strict review mode blocks apply until the proposal review is approved", () => {
    const skillPath = path.join(tmpDir, "strict", "SKILL.md");
    const content = "# Runtime Self-Learning\n\nStrict review gated content.\n";
    const proposal = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content });

    assert.throws(
      () => applyProposal(tmpDir, proposal.id, { requireReview: true }),
      /review approval required/
    );

    updateReviewStatus(tmpDir, reviewIdForProposal(proposal), "approved");
    const applied = applyProposal(tmpDir, proposal.id, { requireReview: true });
    assert.equal(applied.status, "applied");
    assert.equal(fs.readFileSync(skillPath, "utf-8"), content);
  });

  it("event replay reconstructs proposal and review state", () => {
    const skillPath = path.join(tmpDir, "events", "SKILL.md");
    const proposal = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content: "# Runtime Self-Learning\n\nEvent replay.\n" });
    updateReviewStatus(tmpDir, reviewIdForProposal(proposal), "approved");
    applyProposal(tmpDir, proposal.id, { requireReview: true });

    const replay = replayEventState(readEvents(tmpDir, { limit: 100 }));
    assert.equal(replay.byType["proposal.applied"] >= 1, true);
    assert.equal(replay.entities[`proposal:${proposal.id}`].status, "applied");
    assert.equal(replay.entities[`review:${reviewIdForProposal(proposal)}`].status, "applied");
  });

  it("reviewPanel summarizes queued and blocked items", () => {
    const skillPath = path.join(tmpDir, "SKILL.md");
    const proposal = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content: "# Runtime Self-Learning\n" });
    const panel = reviewPanel(tmpDir, { proposals: [proposal], doctorReport: { status: "good", suggestedActions: [] } });
    assert.equal(panel.ok, true);
    assert.equal(panel.counts.pendingReviews >= 1, true);
  });

  it("control apply_proposal respects strict review settings", async () => {
    const home = path.join(tmpDir, "home");
    process.env.HANA_HOME = home;
    const learnerDir = path.join(home, "self-learning");
    const skillPath = path.join(tmpDir, "plugin", "skills", "self-learning", "SKILL.md");
    writeJson(path.join(learnerDir, "config.json"), { ...DEFAULT_CONFIG, governanceProfile: "balanced", requireReviewForAutoApply: true });
    const proposal = buildSkillPatchProposal({
      learnerDir,
      skillPath,
      content: "# Runtime Self-Learning\n\nStrict control apply.\n",
    });

    await assert.rejects(
      () => executeControl({ action: "apply_proposal", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }),
      /review approval required/
    );

    updateReviewStatus(learnerDir, reviewIdForProposal(proposal), "approved");
    const result = JSON.parse(await executeControl({ action: "apply_proposal", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }));
    assert.equal(result.proposal.status, "applied");
    assert.equal(fs.readFileSync(skillPath, "utf-8"), "# Runtime Self-Learning\n\nStrict control apply.\n");
  });

  it("control apply_proposal allows balanced low-risk proposals when strict review is off", async () => {
    const home = path.join(tmpDir, "home");
    process.env.HANA_HOME = home;
    const learnerDir = path.join(home, "self-learning");
    const skillPath = path.join(tmpDir, "plugin", "skills", "self-learning", "SKILL.md");
    writeJson(path.join(learnerDir, "config.json"), { ...DEFAULT_CONFIG, governanceProfile: "balanced", requireReviewForAutoApply: false });
    const proposal = buildSkillPatchProposal({
      learnerDir,
      skillPath,
      content: "# Runtime Self-Learning\n\nBalanced control apply.\n",
    });

    const result = JSON.parse(await executeControl({ action: "apply_proposal", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }));
    assert.equal(result.proposal.status, "applied");
    assert.equal(fs.readFileSync(skillPath, "utf-8"), "# Runtime Self-Learning\n\nBalanced control apply.\n");
  });

  it("control apply_proposal is blocked in conservative profile even after approval", async () => {
    const home = path.join(tmpDir, "home");
    process.env.HANA_HOME = home;
    const learnerDir = path.join(home, "self-learning");
    const skillPath = path.join(tmpDir, "plugin", "skills", "self-learning", "SKILL.md");
    writeJson(path.join(learnerDir, "config.json"), { ...DEFAULT_CONFIG, governanceProfile: "conservative", requireReviewForAutoApply: true });
    const proposal = buildSkillPatchProposal({
      learnerDir,
      skillPath,
      content: "# Runtime Self-Learning\n\nConservative control apply.\n",
    });
    updateReviewStatus(learnerDir, reviewIdForProposal(proposal), "approved");

    await assert.rejects(
      () => executeControl({ action: "apply_proposal", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }),
      /conservative profile requires review-first/
    );

    const result = JSON.parse(await executeControl({ action: "apply_review", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }));
    assert.equal(result.proposal.status, "applied");
    assert.equal(fs.readFileSync(skillPath, "utf-8"), "# Runtime Self-Learning\n\nConservative control apply.\n");
  });

  it("control apply_proposal still blocks code_patch proposals", async () => {
    const home = path.join(tmpDir, "home");
    process.env.HANA_HOME = home;
    const learnerDir = path.join(home, "self-learning");
    writeJson(path.join(learnerDir, "config.json"), { ...DEFAULT_CONFIG, governanceProfile: "balanced", requireReviewForAutoApply: false });
    const proposal = buildCodePatchProposal({
      learnerDir,
      pattern: { id: "error:control_code_patch", type: "error", count: 3, desc: "Repeated failure.", fix: "Inspect manually." },
    });

    await assert.rejects(
      () => executeControl({ action: "apply_proposal", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }),
      /code_patch proposals cannot be auto-applied/
    );
  });

  it("control proposal review actions include actionable next steps", async () => {
    const home = path.join(tmpDir, "home");
    process.env.HANA_HOME = home;
    const learnerDir = path.join(home, "self-learning");
    const skillPath = path.join(tmpDir, "plugin", "skills", "self-learning", "SKILL.md");
    writeJson(path.join(learnerDir, "config.json"), { ...DEFAULT_CONFIG, governanceProfile: "balanced", requireReviewForAutoApply: true });
    const proposal = buildSkillPatchProposal({
      learnerDir,
      skillPath,
      content: "# Runtime Self-Learning\n\nNext action hint.\n",
    });

    const preview = JSON.parse(await executeControl({ action: "preview_proposal", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }));
    assert.equal(preview.nextAction, "validate_proposal, then approve_review or reject_review");

    const validation = JSON.parse(await executeControl({ action: "validate_proposal", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }));
    assert.equal(validation.ok, true);
    assert.equal(validation.nextAction, "approve_review then apply_review");

    const panel = JSON.parse(await executeControl({ action: "review_panel" }, { pluginDir: path.join(tmpDir, "plugin") }));
    assert.ok(panel.recommendedNextActions.some((action) => action.includes("preview queued reviews")));

    const approved = JSON.parse(await executeControl({ action: "approve_review", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }));
    assert.equal(approved.nextAction, "apply_review");

    const applied = JSON.parse(await executeControl({ action: "apply_review", proposalId: proposal.id }, { pluginDir: path.join(tmpDir, "plugin") }));
    assert.equal(applied.nextAction, "verify_event_log or export_audit_bundle");
  });
});
