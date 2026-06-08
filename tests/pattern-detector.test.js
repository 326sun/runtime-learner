/**
 * Unit tests for lib/pattern-detector.js — core pattern detection engine.
 * Run: node --test tests/pattern-detector.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PatternDetector } from "../lib/pattern-detector.js";

function makeExp(overrides = {}) {
  return {
    date: new Date().toISOString(),
    taskType: "coding",
    toolsUsed: ["grep", "edit", "bash"],
    taskSummary: "tools: grep -> edit -> bash",
    toolCallCount: 3,
    resultStatus: "success",
    stopReason: "stop",
    correction: "",
    errors: [],
    ...overrides,
  };
}

function makeError(overrides = {}) {
  return {
    date: new Date().toISOString(),
    errorType: "file_not_found",
    errorDesc: "ENOENT: no such file",
    severity: 2,
    ...overrides,
  };
}

describe("PatternDetector", () => {
  describe("constructor and configuration", () => {
    it("initializes with empty state", () => {
      const detector = new PatternDetector({ minInjectScore: 8 });
      assert.equal(detector.turnCount, 0);
      assert.equal(detector.patterns.size, 0);
      assert.equal(detector.seqCache.size, 0);
    });

    it("setConfig updates config reference", () => {
      const detector = new PatternDetector({ minInjectScore: 5 });
      detector.setConfig({ minInjectScore: 10 });
      assert.equal(detector.config.minInjectScore, 10);
    });
  });

  describe("restore", () => {
    it("loads saved patterns into memory", () => {
      const detector = new PatternDetector({});
      const saved = [
        {
          id: "error:file_not_found",
          type: "error",
          status: "approved",
          desc: "Repeated error",
          count: 5,
          firstSeen: "2025-01-01",
          lastSeen: "2025-01-05",
          score: 15,
        },
      ];
      detector.restore(saved);
      assert.equal(detector.patterns.size, 1);
      assert.equal(detector.patterns.get("error:file_not_found").count, 5);
    });

    it("restores workflow patterns into seqCache", () => {
      const detector = new PatternDetector({});
      const saved = [
        {
          id: "workflow:代码编写→文件探索",
          type: "workflow",
          status: "approved",
          desc: "跨类别工作流",
          count: 4,
          tools: ["grep", "edit", "bash"],
          firstSeen: "2025-01-01",
        },
      ];
      detector.restore(saved);
      assert.equal(detector.seqCache.get("代码编写→文件探索"), 4);
    });

    it("skips patterns without id", () => {
      const detector = new PatternDetector({});
      detector.restore([{ type: "error", desc: "no id" }]);
      assert.equal(detector.patterns.size, 0);
    });
  });

  describe("ingest — workflow detection", () => {
    it("does not create workflow for single turn", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({ toolsUsed: ["grep", "edit", "bash"] });
      const result = detector.ingest(exp);
      assert.equal(result.length, 0);
    });

    it("creates workflow after 3 occurrences of same category sequence", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({ toolsUsed: ["grep", "edit", "bash"] });

      detector.ingest(exp);
      detector.ingest(exp);
      const result = detector.ingest(exp);

      assert.ok(result.length >= 1);
      const wf = result.find((p) => p.type === "workflow");
      assert.ok(wf);
      assert.ok(wf.id.startsWith("workflow:"));
      assert.equal(wf.count, 3);
    });

    it("tracks sub-signatures for actionable hints", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({ toolsUsed: ["grep", "edit", "bash"] });

      // Workflow created at count=3, sub-signature starts at 1
      detector.ingest(exp);
      detector.ingest(exp);
      detector.ingest(exp);
      // Additional ingests increment the existing sub-signature
      detector.ingest(exp);
      detector.ingest(exp);

      const all = detector.all();
      const wf = all.find((p) => p.type === "workflow");
      assert.ok(wf);
      assert.ok(wf.subSignatures);
      assert.equal(wf.subSignatures["grep->edit->bash"], 3);
    });

    it("upgrades fix hint when sub-signature dominates", () => {
      const detector = new PatternDetector({});
      const exp1 = makeExp({ toolsUsed: ["grep", "edit", "bash"] });

      // Create workflow (count=3), then 3 more to raise sub-signature to >=3
      detector.ingest(exp1);
      detector.ingest(exp1);
      detector.ingest(exp1);
      detector.ingest(exp1);
      detector.ingest(exp1);
      detector.ingest(exp1);

      const all = detector.all();
      const wf = all.find((p) => p.type === "workflow");
      assert.ok(wf.fix.includes("Common sequence"));
    });

    it("skips single-category tool chains", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({ toolsUsed: ["grep", "find", "ls"] });

      detector.ingest(exp);
      detector.ingest(exp);
      const result = detector.ingest(exp);

      assert.equal(result.length, 0);
    });
  });

  describe("ingest — preference detection", () => {
    it("creates preference pattern from user correction", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({
        toolsUsed: ["edit"],
        correction: "不对，应该用绝对路径",
      });

      const result = detector.ingest(exp);
      const pref = result.find((p) => p.type === "preference");
      assert.ok(pref);
      assert.ok(pref.id.startsWith("pref:"));
    });

    it("increments existing preference count and score", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({
        toolsUsed: ["edit"],
        correction: "不对，应该用绝对路径",
      });

      detector.ingest(exp);
      detector.ingest(exp);

      const all = detector.all();
      const pref = all.find((p) => p.type === "preference");
      assert.ok(pref);
      assert.equal(pref.count, 2);
    });

    it("classifies durable preferences from language cues", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({
        toolsUsed: ["edit"],
        correction: "以后默认使用绝对路径，记住",
      });

      detector.ingest(exp);
      const all = detector.all();
      const pref = all.find((p) => p.type === "preference");
      assert.ok(pref);
      assert.equal(pref.knowledgeTier, "durable");
    });

    it("defaults to core tier for ordinary corrections", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({
        toolsUsed: ["edit"],
        correction: "路径不对",
      });

      detector.ingest(exp);
      const all = detector.all();
      const pref = all.find((p) => p.type === "preference");
      assert.equal(pref.knowledgeTier, "core");
    });
  });

  describe("ingestError", () => {
    it("creates error pattern for new error type", () => {
      const detector = new PatternDetector({});
      const result = detector.ingestError(makeError());
      assert.equal(result.isNew, true);
      assert.equal(result.pattern.type, "error");
      assert.equal(result.pattern.count, 1);
      assert.ok(result.pattern.id.startsWith("error:"));
    });

    it("accumulates existing error pattern", () => {
      const detector = new PatternDetector({});
      detector.ingestError(makeError());
      const result = detector.ingestError(makeError());
      assert.equal(result.isNew, false);
      assert.equal(result.pattern.count, 2);
    });

    it("weights by severity", () => {
      const detector = new PatternDetector({});
      detector.ingestError(makeError({ severity: 4 }));
      const all = detector.all();
      assert.equal(all[0].score, 4);
    });
  });

  describe("ingestUsage", () => {
    it("creates large-context usage pattern above threshold", () => {
      const detector = new PatternDetector({ largeUsageTokenThreshold: 100000 });
      const changes = detector.ingestUsage({
        date: new Date().toISOString(),
        model: "deepseek-v4-pro",
        totalTokens: 150000,
        status: "success",
        subsystem: "chat",
        operation: "send",
      });
      assert.ok(changes.length >= 1);
      assert.ok(changes[0].pattern.id.includes("large_context"));
    });

    it("creates failed-request pattern on error", () => {
      const detector = new PatternDetector({});
      const changes = detector.ingestUsage({
        date: new Date().toISOString(),
        model: "deepseek-v4-pro",
        status: "error",
        error: { message: "timeout" },
        subsystem: "chat",
        operation: "send",
      });
      assert.ok(changes.length >= 1);
      assert.ok(changes.some((c) => c.pattern.id.includes("failed_request")));
    });
  });

  describe("pruneMemory", () => {
    it("does not prune when under threshold", () => {
      const detector = new PatternDetector({});
      for (let i = 0; i < 10; i++) {
        detector.ingestError(makeError({ errorType: `error_type_${i}` }));
      }
      const pruned = detector.pruneMemory();
      assert.equal(pruned, 0);
    });

    it("prunes weakest non-approved, non-durable patterns", () => {
      const detector = new PatternDetector({});
      // Fill past the threshold (MAX_PATTERN_COUNT * 2 = 100)
      for (let i = 0; i < 110; i++) {
        detector.ingestError(makeError({ errorType: `error_type_${i}`, severity: 1 }));
      }
      const pruned = detector.pruneMemory();
      assert.ok(pruned >= 10);
    });
  });

  describe("all()", () => {
    it("returns patterns decorated with knowledgeTier, status, decayedScore, injectable", () => {
      const detector = new PatternDetector({});
      const exp = makeExp({
        toolsUsed: ["grep", "edit", "bash"],
        correction: "以后默认用这个路径",
      });
      detector.ingest(exp);
      detector.ingest(exp);
      detector.ingest(exp);

      const all = detector.all();
      assert.ok(all.length >= 1);
      for (const p of all) {
        assert.ok("knowledgeTier" in p);
        assert.ok("status" in p);
        assert.ok("decayedScore" in p);
        assert.ok("injectable" in p);
      }
    });

    it("sorts by decayedScore descending", () => {
      const detector = new PatternDetector({});
      detector.ingestError(makeError({ errorType: "high", severity: 10 }));
      detector.ingestError(makeError({ errorType: "low", severity: 1 }));

      const all = detector.all();
      assert.ok(all[0].decayedScore >= all[1].decayedScore);
    });

    it("filters out ephemeral tier patterns", () => {
      const detector = new PatternDetector({});
      // capability type patterns are ephemeral by default via knowledgeTier()
      detector.patterns.set("test:cap", {
        id: "test:cap",
        type: "capability",
        status: "pending",
        count: 1,
        score: 1,
      });
      const all = detector.all();
      assert.ok(!all.some((p) => p.id === "test:cap"));
    });
  });

  describe("integration: full pipeline", () => {
    it("detects workflow, preference, and error in same session", () => {
      const detector = new PatternDetector({});
      const date = new Date().toISOString();

      // 3 workflow turns
      for (let i = 0; i < 3; i++) {
        detector.ingest(makeExp({
          date,
          toolsUsed: ["grep", "edit", "bash"],
        }));
      }

      // 1 correction turn
      detector.ingest(makeExp({
        date,
        toolsUsed: ["write"],
        correction: "不对，文件名应该用下划线",
      }));

      // 2 errors
      detector.ingestError(makeError({ date, errorType: "permission_denied", severity: 3 }));
      detector.ingestError(makeError({ date, errorType: "permission_denied", severity: 3 }));

      const all = detector.all();
      assert.ok(all.some((p) => p.type === "workflow"));
      assert.ok(all.some((p) => p.type === "preference"));
      assert.ok(all.some((p) => p.type === "error"));
    });

    it("turnCount tracks total ingest cycles", () => {
      const detector = new PatternDetector({});
      for (let i = 0; i < 5; i++) {
        detector.ingest(makeExp({ toolsUsed: ["grep", "edit"] }));
      }
      assert.equal(detector.turnCount, 5);
    });
  });
});
