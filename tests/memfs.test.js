// Tests for lib/memfs.js — the human-readable Markdown view of memory, plus the
// doctor staleness check that keeps it honest.

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMemFS, generateMemFS, fingerprintPatterns, readMemFSIndex } from "../lib/memfs.js";
import { diagnose } from "../tools/doctor.js";

const now = new Date("2026-06-09T12:00:00Z").getTime();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "memfs-"));

const PATTERNS = [
  { id: "workflow:code→test", type: "workflow", status: "approved", score: 14, count: 5,
    lastSeen: new Date(now).toISOString(), scope: { project: "hanako", taskType: "coding" },
    desc: "跨类别工作流 code→test", fix: "改代码前先跑测试" },
  { id: "pref:tabs", type: "preference", knowledgeTier: "durable", status: "approved", score: 8, count: 3,
    lastSeen: new Date(now).toISOString(), scope: { project: "general", taskType: "general" },
    desc: "User correction: 用四空格缩进", fix: "用四空格缩进" },
  { id: "error:syntax_error", type: "error", status: "pending", score: 4, count: 2,
    lastSeen: new Date(now).toISOString(), scope: { project: "hanako", taskType: "coding" },
    desc: "Repeated error: syntax_error", fix: "修复语法再运行" },
  { id: "pref:rejected", type: "preference", status: "rejected", score: 2, count: 1,
    desc: "不要用 tabs", fix: "用空格" },
];

const FACTS = [
  { id: "fact:hanako:model:module:cbam", subject: "model", predicate: "module", object: "CBAM",
    scope: { project: "hanako" }, confidence: 0.9 },
  { id: "fact:hanako:model:module:lscd", subject: "model", predicate: "module", object: "LSCD",
    scope: { project: "hanako" }, supersededBy: "fact:hanako:model:module:cbam" },
];

describe("memfs · buildMemFS", () => {
  const { files } = buildMemFS({ patterns: PATTERNS, facts: FACTS }, { now });

  it("renders the expected file tree", () => {
    for (const f of ["system/user_profile.md", "system/hard_constraints.md", "system/active_projects.md",
      "projects/hanako.md", "patterns/workflows.md", "patterns/errors.md", "patterns/preferences.md",
      "archive/deprecated.md"]) {
      assert.ok(files[f], `missing ${f}`);
    }
  });

  it("puts durable preferences in the user profile and hard constraints", () => {
    assert.match(files["system/user_profile.md"], /四空格缩进/);
    assert.match(files["system/hard_constraints.md"], /四空格缩进/);
  });

  it("groups concrete-project memory under projects/", () => {
    assert.match(files["projects/hanako.md"], /code→test/);
    assert.match(files["projects/hanako.md"], /CBAM/);          // active fact
    assert.ok(!files["projects/hanako.md"].includes("LSCD"));   // superseded fact excluded from active
  });

  it("does not create a projects file for the general scope", () => {
    assert.ok(!files["projects/general.md"]);
  });

  it("archives rejected patterns and dead facts", () => {
    assert.match(files["archive/deprecated.md"], /pref:rejected/);
    assert.match(files["archive/deprecated.md"], /LSCD/);
  });

  it("active_projects table lists hanako with counts", () => {
    assert.match(files["system/active_projects.md"], /hanako/);
  });
});

describe("memfs · fingerprintPatterns", () => {
  it("is stable for identical state and sensitive to status/score changes", () => {
    assert.equal(fingerprintPatterns(PATTERNS, FACTS), fingerprintPatterns(PATTERNS, FACTS));
    const changed = PATTERNS.map((p) => (p.id === "error:syntax_error" ? { ...p, status: "approved" } : p));
    assert.notEqual(fingerprintPatterns(PATTERNS, FACTS), fingerprintPatterns(changed, FACTS));
  });
});

describe("memfs · generateMemFS (disk)", () => {
  it("writes the tree, an index with fingerprint, and rebuilds cleanly", () => {
    const dir = tmpDir();
    // a stale leftover that a clean rebuild must remove
    fs.mkdirSync(path.join(dir, "memfs", "projects"), { recursive: true });
    fs.writeFileSync(path.join(dir, "memfs", "projects", "old-project.md"), "stale", "utf-8");

    const res = generateMemFS(dir, { patterns: PATTERNS, facts: FACTS }, { now });
    assert.ok(fs.existsSync(path.join(dir, "memfs", "system", "user_profile.md")));
    assert.ok(!fs.existsSync(path.join(dir, "memfs", "projects", "old-project.md")), "stale file removed");

    const index = readMemFSIndex(dir);
    assert.equal(index.fingerprint, fingerprintPatterns(PATTERNS, FACTS));
    assert.equal(res.fingerprint, index.fingerprint);

    // regenerating identical state yields the same fingerprint (idempotent)
    const res2 = generateMemFS(dir, { patterns: PATTERNS, facts: FACTS }, { now });
    assert.equal(res2.fingerprint, res.fingerprint);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("memfs · doctor staleness check", () => {
  it("flags memfs_stale when the index fingerprint diverges", () => {
    const r = diagnose({ patterns: PATTERNS, facts: FACTS, memfsIndex: { fingerprint: "deadbeef" }, now });
    assert.ok(r.issues.map((i) => i.type).includes("memfs_stale"));
  });
  it("is silent when fingerprints match", () => {
    const r = diagnose({ patterns: PATTERNS, facts: FACTS, memfsIndex: { fingerprint: fingerprintPatterns(PATTERNS, FACTS) }, now });
    assert.ok(!r.issues.map((i) => i.type).includes("memfs_stale"));
  });
  it("is silent when MemFS has never been generated", () => {
    const r = diagnose({ patterns: PATTERNS, facts: FACTS, now });
    assert.ok(!r.issues.map((i) => i.type).includes("memfs_stale"));
  });
});
