import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { buildSkillPatchProposal, applyProposal, rejectProposal } from "../lib/proposals.js";
import { previewProposalDiff } from "../lib/proposals.js";
import { validateProposal } from "../lib/validation-gate.js";
import { listReviews, reviewIdForProposal, updateReviewStatus, reviewPanel } from "../lib/review-queue.js";
import { readEvents, replayEventState } from "../lib/event-log.js";
import { loadSkillRegistry } from "../lib/skill-lifecycle.js";

const tmpDir = path.join(os.tmpdir(), `learner-review-test-${Date.now()}`);

describe("review governance", () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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
});
