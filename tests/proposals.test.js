import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  applyProposal,
  buildCodePatchProposal,
  buildSkillPatchProposal,
  isActionableCodePatchPattern,
  listProposals,
  verifyProposal,
} from "../lib/proposals.js";

const tmpDir = path.join(os.tmpdir(), "learner-proposals-test-" + Date.now());

describe("proposal engine", () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates, verifies, and applies a skill patch proposal", () => {
    const skillPath = path.join(tmpDir, "plugin", "skills", "self-learning", "SKILL.md");
    const content = "# Runtime Self-Learning\n\nUpdated hints.\n";
    const proposal = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content, triggerPatternIds: ["pref:test"] });

    assert.equal(proposal.type, "skill_patch");
    assert.equal(proposal.status, "pending");
    assert.deepEqual(verifyProposal(proposal), { ok: true });

    const applied = applyProposal(tmpDir, proposal.id);
    assert.equal(applied.status, "applied");
    assert.equal(fs.readFileSync(skillPath, "utf-8"), content);
    assert.equal(listProposals(tmpDir, { status: "applied" }).length, 1);
  });

  it("rejects tampered skill patch content", () => {
    const skillPath = path.join(tmpDir, "SKILL.md");
    const proposal = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content: "# Runtime Self-Learning\n" });
    proposal.patch.content = "# Runtime Self-Learning\nchanged\n";
    const result = verifyProposal(proposal);
    assert.equal(result.ok, false);
    assert.match(result.error, /hash mismatch/);
  });

  it("creates high-risk code patch proposals but does not auto-apply them", () => {
    const proposal = buildCodePatchProposal({
      learnerDir: tmpDir,
      pattern: {
        id: "error:permission_denied",
        type: "error",
        count: 3,
        desc: "Repeated error: permission_denied",
        fix: "Check write permissions.",
      },
    });

    assert.equal(proposal.type, "code_patch");
    assert.equal(proposal.risk, "high");
    assert.equal(proposal.autoApply, false);
    assert.throws(() => applyProposal(tmpDir, proposal.id), /cannot be auto-applied/);
  });

  it("only treats specific error patterns as actionable code patches", () => {
    assert.equal(isActionableCodePatchPattern({ id: "error:unknown", type: "error", count: 3 }), false);
    assert.equal(isActionableCodePatchPattern({ id: "error:file_not_found", type: "error", count: 3 }), true);
    assert.equal(isActionableCodePatchPattern({ id: "usage:failed_request:openai_chat", type: "usage", count: 3 }), false);
    assert.equal(isActionableCodePatchPattern({ id: "usage:large_context:pixel_api_gpt-5.5", type: "usage", count: 3 }), false);
  });

  it("caps resolved proposals but always keeps pending ones", () => {
    // Create + apply 45 distinct skill_patch proposals (terminal "applied").
    for (let i = 0; i < 45; i++) {
      const skillPath = path.join(tmpDir, "plugin", "skills", "self-learning", "SKILL.md");
      const content = `# Runtime Self-Learning\n\nhint ${i}\n`;
      const p = buildSkillPatchProposal({ learnerDir: tmpDir, skillPath, content });
      applyProposal(tmpDir, p.id);
    }
    // And a couple of pending code_patch proposals (actionable, must survive).
    const pendingIds = [];
    for (let i = 0; i < 3; i++) {
      const p = buildCodePatchProposal({
        learnerDir: tmpDir,
        pattern: { id: `error:type_${i}`, type: "error", count: 3, desc: `err ${i}`, fix: `fix ${i}` },
      });
      pendingIds.push(p.id);
    }

    const applied = listProposals(tmpDir, { status: "applied" });
    assert.ok(applied.length <= 40, `applied capped at 40, got ${applied.length}`);

    const pending = listProposals(tmpDir, { status: "pending" });
    assert.equal(pending.length, 3, "all pending proposals retained");
    for (const id of pendingIds) {
      assert.ok(pending.some((p) => p.id === id), `pending ${id} kept`);
    }
  });
});
