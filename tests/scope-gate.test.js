// Unit tests for the scope inference / matching layer (lib/scope.js) and the
// memory admission gate (lib/memory-gate.js).

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  inferScope,
  deriveProjectFromPath,
  slugifyProject,
  scopeMatches,
  taskTypeMatches,
  isCrossScopeAllowed,
} from "../lib/scope.js";
import { admitMemory, isExpired, isSuperseded } from "../lib/memory-gate.js";

describe("scope · slugify & path derivation", () => {
  it("slugifies messy project names", () => {
    assert.equal(slugifyProject("  Hanako Runtime Learner "), "hanako-runtime-learner");
    assert.equal(slugifyProject("bearing/YOLO"), "bearing-yolo");
  });

  it("skips a short session-id segment directly under a session container", () => {
    assert.equal(deriveProjectFromPath("/home/me/work/bearing-yolo/sessions/abc123"), "bearing-yolo");
  });

  it("returns null for pure session-id paths", () => {
    assert.equal(deriveProjectFromPath("/.hanako/sessions/9f8e7d6c5b4a3210"), null);
    assert.equal(deriveProjectFromPath("/tmp/sessions/1700000000000"), null);
  });

  it("picks the meaningful workspace segment", () => {
    assert.equal(deriveProjectFromPath("D:/work/bearing-yolo/sessions/sess-1"), "bearing-yolo");
    assert.equal(deriveProjectFromPath("/Users/x/code/hanako-runtime-learner/run.jsonl"), "hanako-runtime-learner");
  });
});

describe("scope · inferScope precedence", () => {
  it("explicit project wins over repo and path", () => {
    const s = inferScope({ project: "MyProj", repo: "org/other", sessionPath: "/work/another/sessions/x", taskType: "coding" });
    assert.equal(s.project, "myproj");
    assert.equal(s.source, "explicit");
    assert.equal(s.taskType, "coding");
  });

  it("repo wins over path", () => {
    const s = inferScope({ repo: "org/bearing-yolo", sessionPath: "/work/another/sessions/x" });
    assert.equal(s.project, "bearing-yolo");
    assert.equal(s.source, "repo");
  });

  it("falls back to path, then general", () => {
    assert.equal(inferScope({ sessionPath: "/work/bearing-yolo/sessions/x" }).project, "bearing-yolo");
    const g = inferScope({ sessionPath: "/.hanako/sessions/deadbeefdeadbeef" });
    assert.equal(g.project, "general");
    assert.equal(g.source, "general");
  });
});

describe("scope · matching", () => {
  it("scopeMatches same project / general sentinel", () => {
    assert.equal(scopeMatches({ project: "a" }, { project: "a" }), true);
    assert.equal(scopeMatches({ project: "general" }, { project: "a" }), true);
    assert.equal(scopeMatches({ project: "a" }, { project: "general" }), true);
    assert.equal(scopeMatches({ project: "a" }, { project: "b" }), false);
  });

  it("taskTypeMatches is lenient for general and comma lists", () => {
    assert.equal(taskTypeMatches({ taskType: "general" }, { taskType: "coding" }), true);
    assert.equal(taskTypeMatches({ taskType: "coding,research" }, { taskType: "research" }), true);
    assert.equal(taskTypeMatches({ taskType: "coding" }, { taskType: "research" }), false);
  });

  it("isCrossScopeAllowed only for global memories", () => {
    assert.equal(isCrossScopeAllowed({ scope: { project: "global" } }, { project: "a" }), true);
    assert.equal(isCrossScopeAllowed({ knowledgeTier: "durable", scope: { project: "x", global: true } }, { project: "a" }), true);
    assert.equal(isCrossScopeAllowed({ knowledgeTier: "durable", scope: { project: "x" } }, { project: "a" }), false);
  });
});

describe("gate · temporal helpers", () => {
  it("isExpired honors validTo", () => {
    assert.equal(isExpired({ scope: { validTo: "2000-01-01T00:00:00Z" } }), true);
    assert.equal(isExpired({ scope: { validTo: "2999-01-01T00:00:00Z" } }), false);
    assert.equal(isExpired({}), false);
  });

  it("isSuperseded detects supersession markers", () => {
    assert.equal(isSuperseded({ supersededBy: "fact:x" }), true);
    assert.equal(isSuperseded({ status: "superseded" }), true);
    assert.equal(isSuperseded({ supersededByIds: [] }), false);
  });
});

describe("gate · admitMemory", () => {
  const q = { scope: { project: "hanako", taskType: "coding" } };

  it("admits a same-scope candidate with no penalty", () => {
    const r = admitMemory({ id: "p1", scope: { project: "hanako", taskType: "coding" } }, q);
    assert.equal(r.admitted, true);
    assert.equal(r.penalty, 0);
  });

  it("blocks rejected, ephemeral, expired, superseded", () => {
    assert.equal(admitMemory({ id: "p", status: "rejected", scope: { project: "hanako" } }, q).admitted, false);
    assert.equal(admitMemory({ id: "p", type: "host_capability", scope: { project: "hanako" } }, q).admitted, false);
    assert.equal(admitMemory({ id: "p", scope: { project: "hanako", validTo: "2000-01-01T00:00:00Z" } }, q).admitted, false);
    assert.equal(admitMemory({ id: "p", status: "superseded", scope: { project: "hanako" } }, q).admitted, false);
  });

  it("blocks cross-project memory", () => {
    const r = admitMemory({ id: "p", scope: { project: "yolo-paper", taskType: "research" } }, q);
    assert.equal(r.admitted, false);
    assert.match(r.reason, /cross-project/);
  });

  it("admits a general-scoped memory into any project", () => {
    assert.equal(admitMemory({ id: "p", scope: { project: "general" } }, q).admitted, true);
  });

  it("admits cross-taskType but applies a penalty", () => {
    const r = admitMemory({ id: "p", scope: { project: "hanako", taskType: "research" } }, q);
    assert.equal(r.admitted, true);
    assert.ok(r.penalty > 0, `expected penalty > 0, got ${r.penalty}`);
  });

  it("honors a confidence floor when configured", () => {
    const cand = { id: "p", confidence: 0.3, scope: { project: "hanako", taskType: "coding" } };
    assert.equal(admitMemory(cand, q, { minRetrievalConfidence: 0.5 }).admitted, false);
    assert.equal(admitMemory(cand, q, { minRetrievalConfidence: 0.2 }).admitted, true);
  });

  it("admits a durable global hard-constraint across projects", () => {
    const cand = { id: "p", knowledgeTier: "durable", scope: { project: "x", global: true } };
    assert.equal(admitMemory(cand, q).admitted, true);
  });
});
