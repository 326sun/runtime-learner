// Tests for lib/temporal.js + lib/facts.js — time-aware facts and supersession,
// plus the end-to-end guarantee that a superseded fact never re-surfaces in
// retrieval (the v1.1 acceptance criterion).

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isActiveFact, activeFacts, applyFact, factConflicts } from "../lib/temporal.js";
import { makeFact, recordFact, factMemoryItems, factToMemoryItem } from "../lib/facts.js";
import { admitMemory } from "../lib/memory-gate.js";
import { runSearch } from "../tools/search.js";

const NOW = Date.parse("2026-06-09T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "facts-"));

describe("temporal · isActiveFact", () => {
  it("respects validFrom / validTo / supersession", () => {
    assert.equal(isActiveFact({ validFrom: iso(NOW - 1000) }, NOW), true);
    assert.equal(isActiveFact({ validFrom: iso(NOW + 1e6) }, NOW), false);
    assert.equal(isActiveFact({ validTo: iso(NOW - 1000) }, NOW), false);
    assert.equal(isActiveFact({ supersededBy: "fact:x" }, NOW), false);
    assert.equal(isActiveFact({ status: "superseded" }, NOW), false);
  });
});

describe("temporal · applyFact supersession", () => {
  it("supersedes a conflicting active fact (same subject/predicate, new object)", () => {
    const old = makeFact({ subject: "m", predicate: "version", object: "0.8.1", scope: { project: "hanako" } }, { now: NOW - 1e6 });
    const next = makeFact({ subject: "m", predicate: "version", object: "0.9.0", scope: { project: "hanako" } }, { now: NOW });
    const { facts, superseded } = applyFact([old], next, { now: NOW });
    assert.deepEqual(superseded, [old.id]);
    assert.equal(old.supersededBy, next.id);
    assert.ok(old.validTo);
    assert.ok(next.supersedes.includes(old.id));
    assert.equal(activeFacts(facts, NOW).length, 1);
    assert.equal(activeFacts(facts, NOW)[0].object, "0.9.0");
  });

  it("refreshes instead of duplicating when the same value is restated", () => {
    const a = makeFact({ subject: "m", predicate: "version", object: "0.9.0", scope: { project: "hanako" }, confidence: 0.6 }, { now: NOW - 1e6 });
    const b = makeFact({ subject: "m", predicate: "version", object: "0.9.0", scope: { project: "hanako" }, confidence: 0.95 }, { now: NOW });
    const { facts, action } = applyFact([a], b, { now: NOW });
    assert.equal(action, "refreshed");
    assert.equal(facts.length, 1);
    assert.equal(facts[0].confidence, 0.95);
  });

  it("does not cross project scopes", () => {
    const a = makeFact({ subject: "m", predicate: "version", object: "A", scope: { project: "p1" } }, { now: NOW });
    const b = makeFact({ subject: "m", predicate: "version", object: "B", scope: { project: "p2" } }, { now: NOW });
    const { superseded } = applyFact([a], b, { now: NOW });
    assert.equal(superseded.length, 0);
  });
});

describe("temporal · factConflicts", () => {
  it("flags two active values, ignores superseded ones", () => {
    const facts = [
      makeFact({ subject: "m", predicate: "v", object: "A", scope: { project: "p" } }, { now: NOW }),
      makeFact({ subject: "m", predicate: "v", object: "B", scope: { project: "p" } }, { now: NOW }),
    ];
    assert.equal(factConflicts(facts, NOW).length, 1);
    facts[0].status = "superseded";
    assert.equal(factConflicts(facts, NOW).length, 0);
  });
});

describe("facts · gate integration", () => {
  it("admits an active fact item and rejects a superseded one", () => {
    const active = factToMemoryItem(makeFact({ subject: "m", predicate: "v", object: "B", scope: { project: "hanako" } }, { now: NOW }));
    const superseded = factToMemoryItem({ ...makeFact({ subject: "m", predicate: "v", object: "A", scope: { project: "hanako" } }, { now: NOW }), supersededBy: "fact:new" });
    assert.equal(admitMemory(active, { scope: { project: "hanako" } }).admitted, true);
    assert.equal(admitMemory(superseded, { scope: { project: "hanako" } }).admitted, false);
  });
});

describe("facts · recordFact + retrieval (superseded never resurfaces)", () => {
  it("persists supersession and keeps the old value out of search", () => {
    const dir = tmpDir();
    recordFact(dir, { subject: "model", predicate: "module", object: "LSCD", scope: { project: "yolo" } }, { now: NOW - 1e6 });
    const r2 = recordFact(dir, { subject: "model", predicate: "module", object: "CBAM", scope: { project: "yolo" } }, { now: NOW });
    assert.equal(r2.superseded.length, 1);

    const items = factMemoryItems(dir);
    const results = runSearch(items, "model module", { limit: 5 }).results;
    const objs = results.map((r) => r.desc);
    assert.ok(objs.some((d) => d.includes("CBAM")), "active fact present");
    assert.ok(!objs.some((d) => d.includes("LSCD")), "superseded fact absent");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
