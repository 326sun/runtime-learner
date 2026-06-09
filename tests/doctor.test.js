// Tests for self_learning_doctor's pure analysis core (tools/doctor.js · diagnose).
// Each case isolates one check by constructing minimal triggering inputs.

import { describe, it } from "node:test";
import assert from "node:assert";
import { diagnose, formatReport } from "../tools/doctor.js";

const NOW = Date.parse("2026-06-09T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const types = (r) => r.issues.map((i) => i.type);

const base = (over) => ({
  id: "p", type: "workflow", status: "approved", score: 5, count: 2,
  firstSeen: daysAgo(1), lastSeen: daysAgo(1), scope: { project: "general", taskType: "general" }, ...over,
});

describe("doctor · healthy baseline", () => {
  it("reports Good with no issues for a clean store", () => {
    const r = diagnose({
      patterns: [base({ id: "wf:a", desc: "do a" }), base({ id: "wf:b", desc: "do b" })],
      now: NOW,
    });
    assert.equal(r.status, "good");
    assert.equal(r.label, "Good");
    assert.equal(r.score, 100);
    assert.equal(r.issues.length, 0);
  });
});

describe("doctor · duplicate_patterns", () => {
  it("flags identical desc/fix across records", () => {
    const r = diagnose({
      patterns: [
        base({ id: "wf:a", desc: "run tests then build", fix: "npm test" }),
        base({ id: "wf:b", desc: "run tests then build", fix: "npm test" }),
      ],
      now: NOW,
    });
    assert.ok(types(r).includes("duplicate_patterns"));
    assert.equal(r.status, "warning");
  });
});

describe("doctor · conflicting_facts", () => {
  it("flags same subject/predicate with multiple active values", () => {
    const r = diagnose({
      patterns: [],
      facts: [
        { subject: "model", predicate: "has_module", object: "A" },
        { subject: "model", predicate: "has_module", object: "B" },
      ],
      now: NOW,
    });
    assert.ok(types(r).includes("conflicting_facts"));
    assert.equal(r.status, "warning"); // high severity → warning status
  });

  it("does not flag once one value is superseded/expired", () => {
    const r = diagnose({
      patterns: [],
      facts: [
        { subject: "model", predicate: "has_module", object: "A", validTo: daysAgo(1) },
        { subject: "model", predicate: "has_module", object: "B" },
      ],
      now: NOW,
    });
    assert.ok(!types(r).includes("conflicting_facts"));
  });
});

describe("doctor · stale_auto_approved", () => {
  it("flags aged auto-approved patterns never adopted", () => {
    const r = diagnose({
      patterns: [base({ id: "wf:x", desc: "stale", status: "pending", autoApproved: true, lastSeen: daysAgo(200) })],
      now: NOW,
    });
    assert.ok(types(r).includes("stale_auto_approved"));
  });
});

describe("doctor · pending preferences", () => {
  it("raises a high issue when includePendingPreferences is ON with pending prefs", () => {
    const r = diagnose({
      patterns: [base({ id: "pref:a", type: "preference", status: "pending", desc: "use tabs" })],
      config: { includePendingPreferences: true },
      now: NOW,
    });
    assert.ok(types(r).includes("pending_preference_injection"));
    assert.equal(r.status, "warning");
  });

  it("only warns about backlog (info) when opt-in is OFF and many pending", () => {
    const patterns = [];
    for (let i = 0; i < 12; i++) patterns.push(base({ id: `pref:${i}`, type: "preference", status: "pending", desc: `c${i}` }));
    const r = diagnose({ patterns, config: { includePendingPreferences: false }, now: NOW });
    assert.ok(types(r).includes("pending_preference_backlog"));
    assert.ok(!types(r).includes("pending_preference_injection"));
  });
});

describe("doctor · proposal_backlog", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `prop${i}`, status: "pending" }));
  it("warns at ≥10 pending proposals", () => {
    const r = diagnose({ patterns: [], proposals: mk(10), now: NOW });
    assert.ok(types(r).includes("proposal_backlog"));
    assert.equal(r.status, "warning");
  });
  it("escalates to critical at ≥25", () => {
    const r = diagnose({ patterns: [], proposals: mk(25), now: NOW });
    const issue = r.issues.find((i) => i.type === "proposal_backlog");
    assert.equal(issue.severity, "critical");
    assert.equal(r.status, "critical");
  });
});

describe("doctor · skill_budget", () => {
  it("flags when injectable hints exceed maxSkillTokens", () => {
    const patterns = [];
    for (let i = 0; i < 6; i++) {
      patterns.push(base({ id: `wf:${i}`, status: "approved", desc: `a long hint number ${i} ${"x".repeat(60)}`, fix: `${"y".repeat(60)}` }));
    }
    const r = diagnose({ patterns, config: { maxSkillTokens: 50 }, now: NOW });
    assert.ok(types(r).includes("skill_budget"));
  });
});

describe("doctor · privacy_retention", () => {
  it("flags log entries older than the retention window", () => {
    const r = diagnose({
      patterns: [],
      logs: [{ name: "experience_log.jsonl", oldestMs: NOW - 40 * 86_400_000 }],
      now: NOW,
    });
    assert.ok(types(r).includes("privacy_retention"));
  });
  it("does not flag fresh logs", () => {
    const r = diagnose({
      patterns: [],
      logs: [{ name: "experience_log.jsonl", oldestMs: NOW - 5 * 86_400_000 }],
      now: NOW,
    });
    assert.ok(!types(r).includes("privacy_retention"));
  });
});

describe("doctor · scope_leakage", () => {
  it("notes injectable patterns spanning multiple concrete projects", () => {
    const r = diagnose({
      patterns: [
        base({ id: "wf:a", status: "approved", scope: { project: "proj-x", taskType: "coding" } }),
        base({ id: "wf:b", status: "approved", scope: { project: "proj-y", taskType: "coding" } }),
      ],
      now: NOW,
    });
    assert.ok(types(r).includes("scope_leakage"));
  });
});

describe("doctor · orphan_relations", () => {
  it("flags relation edges pointing at missing patterns", () => {
    const r = diagnose({
      patterns: [base({ id: "wf:a", context: { relations: [{ targetId: "wf:ghost", type: "same-task", weight: 0.5 }] } })],
      now: NOW,
    });
    assert.ok(types(r).includes("orphan_relations"));
  });
});

describe("doctor · evidence_missing", () => {
  it("flags high-score patterns lacking evidence once evidence is in use", () => {
    const r = diagnose({
      patterns: [
        base({ id: "wf:withev", score: 20, evidence: [{ type: "turn", quote: "x" }] }),
        base({ id: "wf:noev", score: 20 }),
      ],
      now: NOW,
    });
    assert.ok(types(r).includes("evidence_missing"));
  });
  it("stays silent before any pattern carries evidence (pre-v1.1)", () => {
    const r = diagnose({ patterns: [base({ id: "wf:noev", score: 20 })], now: NOW });
    assert.ok(!types(r).includes("evidence_missing"));
  });
});

describe("doctor · formatReport", () => {
  it("renders a human-readable report and never claims to modify files", () => {
    const r = diagnose({ patterns: [base({ id: "wf:a", desc: "x", fix: "y" }), base({ id: "wf:b", desc: "x", fix: "y" })], now: NOW });
    const text = formatReport(r);
    assert.match(text, /Self-Learning Doctor/);
    assert.match(text, /Read-only diagnostic/);
    assert.match(text, /duplicate_patterns/);
  });
});
