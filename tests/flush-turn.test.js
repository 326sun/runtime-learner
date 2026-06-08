/**
 * Integration test for the full flushTurn pipeline.
 * Simulates: event stream → SessionTurn → exp object → PatternDetector → persistence.
 * Run: node --test tests/flush-turn.test.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { SessionTurn } from "../lib/session-turn.js";
import { PatternDetector } from "../lib/pattern-detector.js";
import {
  safeText,
  normalizeToolName,
  classifyTask,
  classifyError,
  extractCorrectionFromUserText,
} from "../lib/helpers.js";

function tempDir(name) {
  return path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function resultStatus(turn, stopReason) {
  if (turn.errors.length > 0) return "partial";
  if (stopReason && stopReason !== "stop") return "partial";
  return "success";
}

// Simulates flushTurn's exp-object construction (mirrors index.js logic)
function buildExperience(turn, sessionPath) {
  const correction = turn.userTexts.map(extractCorrectionFromUserText).find(Boolean) || "";
  const tools = [...turn.tools];
  const date = new Date().toISOString();
  const stopReason = turn.stopReason || null;

  return {
    date,
    taskId: `${path.basename(sessionPath)}:${Date.now()}`,
    sessionPath,
    taskType: classifyTask(tools),
    project: "general",
    userIntent: turn.userTexts.at(-1) || "",
    taskSummary: tools.length ? `tools: ${tools.join(" -> ")}` : "assistant turn without tool use",
    toolsUsed: tools,
    toolCallCount: turn.toolCallCount,
    resultStatus: resultStatus(turn, stopReason),
    stopReason,
    userFeedback: correction ? "correction" : "unknown",
    userExplicitCorrection: !!correction,
    errorType: turn.errors.length ? classifyError(turn.errors[0]) : "none",
    failurePoint: turn.errors.length ? turn.errors[0] : "none",
    correction,
    impactLevel: turn.errors.length ? 2 : 1,
    repeatability: tools.length >= 2 ? "medium" : "low",
    oneOff: false,
    skillCandidate: false,
    suggestedSkill: null,
    notes: "",
  };
}

describe("flushTurn integration", () => {
  describe("SessionTurn lifecycle", () => {
    it("tracks tools in order", () => {
      const turn = new SessionTurn("test-session");
      turn.addTool("grep");
      turn.addTool("edit");
      turn.addTool("bash");
      assert.deepEqual(turn.tools, ["grep", "edit", "bash"]);
      assert.equal(turn.toolCallCount, 3);
    });

    it("tracks user text messages", () => {
      const turn = new SessionTurn("test-session");
      turn.addUserText("帮我修复这个文件");
      turn.addUserText("不对，应该用绝对路径");
      assert.equal(turn.userTexts.length, 2);
      assert.equal(turn.userTexts[0], "帮我修复这个文件");
    });

    it("tracks errors", () => {
      const turn = new SessionTurn("test-session");
      turn.addError("bash: ENOENT: no such file");
      turn.addError("grep: permission denied");
      assert.equal(turn.errors.length, 2);
    });

    it("markToolStart/End handles pending tool tracking", () => {
      const turn = new SessionTurn("test-session");
      turn.markToolStart("bash");
      assert.equal(turn.pendingCount, 1);
      turn.markToolEnd("bash");
      assert.equal(turn.pendingCount, 0);
      assert.equal(turn.tools.length, 1);
    });

    it("touch updates lastTouched timestamp", () => {
      const turn = new SessionTurn("test-session");
      const before = turn.lastTouched;
      // Small delay to ensure timestamp difference
      const start = Date.now();
      while (Date.now() === start) {}
      turn.touch();
      assert.ok(turn.lastTouched > before);
    });
  });

  describe("error classification", () => {
    it("classifies file_not_found errors", () => {
      assert.equal(classifyError("ENOENT: no such file or directory"), "file_not_found");
      assert.equal(classifyError("Error: file not found: /path/to/file"), "file_not_found");
    });

    it("classifies permission_denied errors", () => {
      assert.equal(classifyError("EACCES: permission denied"), "permission_denied");
      assert.equal(classifyError("access is denied"), "permission_denied");
    });

    it("classifies network errors", () => {
      assert.equal(classifyError("ECONNREFUSED"), "network_error");
      assert.equal(classifyError("fetch failed"), "network_error");
    });

    it("classifies auth errors", () => {
      assert.equal(classifyError("401 Unauthorized"), "auth_error");
      assert.equal(classifyError("invalid api key"), "auth_error");
    });

    it("classifies model errors", () => {
      assert.equal(classifyError("context length exceeded"), "model_error");
      assert.equal(classifyError("token limit reached"), "model_error");
    });

    it("returns unknown for unclassified errors", () => {
      assert.equal(classifyError("some random text"), "unknown");
      assert.equal(classifyError(""), "unknown");
    });
  });

  describe("correction extraction", () => {
    it("detects strong correction signals (single match)", () => {
      assert.ok(extractCorrectionFromUserText("不对，这里搞错了"));
      assert.ok(extractCorrectionFromUserText("不应该这样写"));
      assert.ok(extractCorrectionFromUserText("纠正一下"));
      assert.ok(extractCorrectionFromUserText("wrong approach"));
    });

    it("detects weak signals with co-occurrence (≥2)", () => {
      assert.ok(extractCorrectionFromUserText("以后改成默认使用绝对路径"));
      assert.ok(extractCorrectionFromUserText("下次记住应该先检查"));
      assert.ok(extractCorrectionFromUserText("remember to actually check next time"));
    });

    it("does not trigger on single weak signal", () => {
      assert.equal(extractCorrectionFromUserText("以后再说"), "");
      assert.equal(extractCorrectionFromUserText("默认配置"), "");
    });

    it("handles empty or short text", () => {
      assert.equal(extractCorrectionFromUserText(""), "");
      // Single character without any correction signal returns empty
      assert.equal(extractCorrectionFromUserText("嗯"), "");
    });
  });

  describe("task classification", () => {
    it("classifies coding tasks", () => {
      assert.equal(classifyTask(["bash", "edit", "grep"]), "coding");
    });

    it("classifies file management tasks", () => {
      assert.equal(classifyTask(["read", "write", "find"]), "file_management");
    });

    it("classifies research tasks", () => {
      assert.equal(classifyTask(["web_search", "web_fetch"]), "research");
    });

    it("defaults to general for unrecognized tools", () => {
      assert.equal(classifyTask([]), "general");
      assert.equal(classifyTask(["unknown_tool"]), "general");
    });
  });

  describe("end-to-end: SessionTurn → exp → PatternDetector", () => {
    let dataDir;
    let patternsFile;

    before(() => {
      dataDir = tempDir("flush-turn-test");
      fs.mkdirSync(dataDir, { recursive: true });
      patternsFile = path.join(dataDir, "patterns.json");
    });

    after(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    function persistPatterns(detector) {
      const mem = [...detector.patterns.values()].map(p => ({ ...p }));
      fs.writeFileSync(patternsFile, JSON.stringify(mem, null, 2), "utf-8");
    }

    it("full pipeline: 3-turn coding session with error and correction", () => {
      const detector = new PatternDetector({
        minInjectScore: 3,
        minInjectCount: 2,
        autoInjectHighConfidence: true,
        decayHalfLifeDays: 30,
      });

      // ── Turn 1: successful coding with grep → edit → bash ──
      const turn1 = new SessionTurn("sessions/test.jsonl");
      turn1.addUserText("帮我找到并修改配置文件");
      turn1.markToolStart("grep"); turn1.markToolEnd("grep");
      turn1.markToolStart("edit"); turn1.markToolEnd("edit");
      turn1.markToolStart("bash"); turn1.markToolEnd("bash");
      turn1.stopReason = "stop";

      const exp1 = buildExperience(turn1, "sessions/test.jsonl");
      assert.equal(exp1.taskType, "coding");
      assert.equal(exp1.resultStatus, "success");
      assert.equal(exp1.toolCallCount, 3);

      const new1 = detector.ingest(exp1);
      assert.equal(new1.length, 0); // No workflow yet (count < 3)

      // ── Turn 2: same coding pattern, but with an error ──
      const turn2 = new SessionTurn("sessions/test.jsonl");
      turn2.addUserText("继续修改配置");
      turn2.markToolStart("grep"); turn2.markToolEnd("grep");
      turn2.markToolStart("edit"); turn2.markToolEnd("edit");
      turn2.markToolStart("bash"); turn2.markToolEnd("bash");
      turn2.addError("bash: EACCES: permission denied");
      turn2.stopReason = "stop";

      const exp2 = buildExperience(turn2, "sessions/test.jsonl");
      assert.equal(exp2.errorType, "permission_denied");
      assert.equal(exp2.resultStatus, "partial"); // has errors
      assert.equal(exp2.impactLevel, 2);

      // Ingest error
      const errResult = detector.ingestError({
        date: exp2.date,
        taskId: exp2.taskId,
        sessionPath: "sessions/test.jsonl",
        taskType: exp2.taskType,
        errorType: exp2.errorType,
        errorDesc: turn2.errors[0],
        severity: 3,
        tool: "bash",
      });
      assert.equal(errResult.isNew, true);

      const new2 = detector.ingest(exp2);
      assert.equal(new2.length, 0); // Still count < 3

      // ── Turn 3: same pattern + user correction ──
      const turn3 = new SessionTurn("sessions/test.jsonl");
      turn3.addUserText("不对，不应该用 sudo，直接用普通权限");
      turn3.markToolStart("grep"); turn3.markToolEnd("grep");
      turn3.markToolStart("edit"); turn3.markToolEnd("edit");
      turn3.markToolStart("bash"); turn3.markToolEnd("bash");
      turn3.stopReason = "stop";

      const exp3 = buildExperience(turn3, "sessions/test.jsonl");
      assert.equal(exp3.userExplicitCorrection, true);
      assert.ok(exp3.correction.length > 0);

      const new3 = detector.ingest(exp3);
      // Should have workflow (3rd occurrence) and preference (correction)
      assert.ok(new3.length >= 2);
      assert.ok(new3.some(p => p.type === "workflow"));
      assert.ok(new3.some(p => p.type === "preference"));

      // ── Verify final state ──
      const all = detector.all();

      const workflow = all.find(p => p.type === "workflow");
      assert.ok(workflow);
      assert.equal(workflow.count, 3);
      assert.ok(workflow.injectable);

      const error = all.find(p => p.type === "error");
      assert.ok(error);
      assert.equal(error.count, 1);

      const pref = all.find(p => p.type === "preference");
      assert.ok(pref);
      assert.ok(pref.desc.includes("不对"));

      // ── Persist and reload ──
      persistPatterns(detector);
      const restored = JSON.parse(fs.readFileSync(patternsFile, "utf-8"));
      assert.ok(restored.length >= 3, `expected >=3 patterns, got ${restored.length}`);

      // Verify all three pattern types are present
      assert.ok(restored.some(p => p.type === "workflow"));
      assert.ok(restored.some(p => p.type === "preference"));
      assert.ok(restored.some(p => p.type === "error"));
    });

    it("handles empty turn (no tools, no errors, no text)", () => {
      const turn = new SessionTurn("sessions/empty.jsonl");
      // Empty turn should produce an exp with general taskType
      const exp = buildExperience(turn, "sessions/empty.jsonl");
      assert.equal(exp.taskType, "general");
      assert.equal(exp.toolsUsed.length, 0);
      assert.equal(exp.resultStatus, "success");
      assert.equal(exp.errorType, "none");
      assert.equal(exp.correction, "");
    });

    it("handles partial turn with only errors", () => {
      const turn = new SessionTurn("sessions/errors-only.jsonl");
      turn.addError("ENOENT: no such file or directory, open 'missing.txt'");
      turn.stopReason = "error";

      const exp = buildExperience(turn, "sessions/errors-only.jsonl");
      assert.equal(exp.errorType, "file_not_found");
      assert.equal(exp.resultStatus, "partial");
      assert.equal(exp.impactLevel, 2);
    });
  });
});
