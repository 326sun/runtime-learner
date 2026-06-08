/**
 * Unit tests for lib/observer.js — event routing and turn lifecycle.
 * Verifies correct dispatch of session/message/tool events to SessionTurn.
 * Uses mocked dependencies to test the observer in isolation.
 * Run: node --test tests/observer.test.js
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { createObserver } from "../lib/observer.js";
import { SessionTurn } from "../lib/session-turn.js";
import { PatternDetector } from "../lib/pattern-detector.js";

function tempDir(name) {
  return path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function makeCtx(log = { info() {}, warn() {}, error() {}, debug() {} }) {
  return { log };
}

describe("SessionObserver — event routing", () => {
  let dataDir;
  let paths;

  function setupMocks(overrides = {}) {
    dataDir = tempDir("observer-test");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ minInjectScore: 8 }));

    paths = {
      TURNS_FILE: path.join(dataDir, "turns.jsonl"),
      EXPERIENCE_LOG: path.join(dataDir, "experience_log.jsonl"),
      ERROR_LOG: path.join(dataDir, "error_log.jsonl"),
      CONFIG_FILE: path.join(dataDir, "config.json"),
    };

    const detector = overrides.detector || new PatternDetector({ minInjectScore: 8 });
    const sessions = overrides.sessions || new Map();
    const runtimeState = overrides.runtimeState || {
      pendingAdoptionChecks: new Map(),
      sessionActivityCount: 0,
    };

    const defaults = {
      detector,
      sessions,
      runtimeState,
      persistPatterns: () => {},
      refreshSkill: () => {},
      autoApprovePatterns: () => ({ count: 0, allPatterns: [] }),
      syncDiskStatus: () => {},
      pruneDataFiles: async () => {},
      maybeRunModelAdvisor: async () => {},
      appendJsonl: () => {},
      logActivity: () => {},
      recordUsage: () => {},
      configRef: { current: { minInjectScore: 8 } },
      ctx: makeCtx(),
      paths,
      MAX_SESSIONS: 64,
    };

    return { ...defaults, ...overrides };
  }

  after(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  describe("subscribe and event dispatch", () => {
    it("routes session_user_message to SessionTurn.addUserText", () => {
      const mocks = setupMocks();
      const sessions = mocks.sessions;
      const observer = createObserver(mocks);

      // Create a mock event bus that captures the subscription callback
      let eventCallback;
      const mockBus = {
        subscribe(cb) {
          eventCallback = cb;
          return () => {};
        },
      };

      observer.subscribe(mockBus, { learnFromUsage: false });

      // Simulate session_user_message event
      eventCallback(
        { type: "session_user_message", message: { content: "帮我修复文件" } },
        "sessions/test.jsonl"
      );

      const turn = sessions.get("sessions/test.jsonl");
      assert.ok(turn);
      assert.equal(turn.userTexts.length, 1);
      assert.ok(turn.userTexts[0].includes("帮我修复文件"));
    });

    it("routes user_message with role=user to addUserText", () => {
      const sessions = new Map();
      const mocks = setupMocks({ sessions });
      const observer = createObserver(mocks);

      let eventCallback;
      observer.subscribe({
        subscribe(cb) { eventCallback = cb; return () => {}; },
      }, { learnFromUsage: false });

      eventCallback(
        { type: "user_message", message: { role: "user", content: "用绝对路径" } },
        "sessions/test.jsonl"
      );

      const turn = sessions.get("sessions/test.jsonl");
      assert.equal(turn.userTexts.length, 1);
    });

    it("routes tool_execution_start to markToolStart", () => {
      const sessions = new Map();
      const mocks = setupMocks({ sessions });
      const observer = createObserver(mocks);

      let eventCallback;
      observer.subscribe({
        subscribe(cb) { eventCallback = cb; return () => {}; },
      }, { learnFromUsage: false });

      eventCallback(
        { type: "tool_execution_start", toolName: "grep" },
        "sessions/test.jsonl"
      );

      const turn = sessions.get("sessions/test.jsonl");
      assert.equal(turn.tools.length, 1);
      assert.equal(turn.tools[0], "grep");
    });

    it("routes tool_execution_end to markToolEnd", () => {
      const sessions = new Map();
      const mocks = setupMocks({ sessions });
      const observer = createObserver(mocks);

      let eventCallback;
      observer.subscribe({
        subscribe(cb) { eventCallback = cb; return () => {}; },
      }, { learnFromUsage: false });

      eventCallback(
        { type: "tool_execution_start", toolName: "bash" },
        "sessions/test.jsonl"
      );
      eventCallback(
        { type: "tool_execution_end", toolName: "bash", isError: false },
        "sessions/test.jsonl"
      );

      const turn = sessions.get("sessions/test.jsonl");
      assert.equal(turn.pendingCount, 0);
      assert.equal(turn.tools.length, 1);
    });

    it("routes tool_execution_end errors to addError", () => {
      const sessions = new Map();
      const mocks = setupMocks({ sessions });
      const observer = createObserver(mocks);

      let eventCallback;
      observer.subscribe({
        subscribe(cb) { eventCallback = cb; return () => {}; },
      }, { learnFromUsage: false });

      eventCallback(
        {
          type: "tool_execution_end",
          toolName: "bash",
          isError: true,
          error: { message: "ENOENT: no such file" },
        },
        "sessions/test.jsonl"
      );

      const turn = sessions.get("sessions/test.jsonl");
      assert.equal(turn.errors.length, 1);
    });

    it("routes message_end (assistant) to flushTurn", () => {
      const sessions = new Map();
      let flushCalled = false;
      const mocks = setupMocks({ sessions });
      const observer = createObserver(mocks);

      let eventCallback;
      observer.subscribe({
        subscribe(cb) { eventCallback = cb; return () => {}; },
      }, { learnFromUsage: false });

      // Set up a turn with tools so flushTurn doesn't bail early
      const turn = new SessionTurn("sessions/test.jsonl");
      turn.addUserText("hello");
      turn.markToolStart("edit");
      turn.markToolEnd("edit");
      sessions.set("sessions/test.jsonl", turn);

      eventCallback(
        { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
        "sessions/test.jsonl"
      );

      // After flushTurn, sessions.delete(key) is called
      assert.equal(sessions.has("sessions/test.jsonl"), false);
    });

    it("ignores events without a type", () => {
      const sessions = new Map();
      const mocks = setupMocks({ sessions });
      const observer = createObserver(mocks);

      let eventCallback;
      observer.subscribe({
        subscribe(cb) { eventCallback = cb; return () => {}; },
      }, { learnFromUsage: false });

      eventCallback({}, "sessions/test.jsonl");
      // No error thrown, no session created
      assert.equal(sessions.size, 0);
    });
  });

  describe("tool-end semantic handlers", () => {
    it("pin_memory creates durable preference pattern", () => {
      const detector = new PatternDetector({ minInjectScore: 8 });
      const mocks = setupMocks({ detector });
      const observer = createObserver(mocks);

      let eventCallback;
      observer.subscribe({
        subscribe(cb) { eventCallback = cb; return () => {}; },
      }, { learnFromUsage: false });

      eventCallback(
        {
          type: "tool_execution_end",
          toolName: "pin_memory",
          isError: false,
          args: { content: "用户喜欢深色主题" },
        },
        "sessions/test.jsonl"
      );

      const all = detector.all();
      const pref = all.find(p => p.type === "preference" && p.desc === "用户喜欢深色主题");
      assert.ok(pref, "pin_memory should create preference pattern");
      assert.equal(pref.knowledgeTier, "durable");
      assert.equal(pref.status, "approved");
      assert.equal(pref.score, 5);
    });

    it("self_learning_search tracks searched patterns", () => {
      const detector = new PatternDetector({ minInjectScore: 8 });
      // Create a workflow pattern first
      detector.patterns.set("workflow:test", {
        id: "workflow:test",
        type: "workflow",
        desc: "test workflow",
        count: 3,
        tools: ["grep", "edit"],
        score: 9,
        context: { categories: ["文件探索", "代码编写"] },
      });

      const runtimeState = { pendingAdoptionChecks: new Map(), sessionActivityCount: 0 };
      const mocks = setupMocks({ detector, runtimeState });
      const observer = createObserver(mocks);

      let eventCallback;
      observer.subscribe({
        subscribe(cb) { eventCallback = cb; return () => {}; },
      }, { learnFromUsage: false });

      eventCallback(
        {
          type: "tool_execution_end",
          toolName: "self_learning_search",
          isError: false,
          result: JSON.stringify({
            results: [{ id: "workflow:test", type: "workflow", desc: "test" }],
          }),
        },
        "sessions/test.jsonl"
      );

      // Search should set lastSearchedAt on the pattern
      const stored = detector.patterns.get("workflow:test");
      assert.ok(stored.lastSearchedAt);

      // Adoption check should be queued
      const pending = runtimeState.pendingAdoptionChecks.get("sessions/test.jsonl");
      assert.ok(pending);
      assert.equal(pending.remaining, 3);
    });
  });

  describe("unsubscribe", () => {
    it("calls all unsub functions", () => {
      let unsubCount = 0;
      const mockBus = {
        subscribe() {
          unsubCount++;
          return () => { unsubCount--; };
        },
      };

      const mocks = setupMocks();
      const observer = createObserver(mocks);
      observer.subscribe(mockBus, { learnFromUsage: false });
      assert.equal(unsubCount, 1);

      observer.unsubscribe();
      assert.equal(unsubCount, 0);
    });
  });
});
