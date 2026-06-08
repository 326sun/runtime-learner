/**
 * Unit tests for lib/common.js — decay algorithms, injection logic, decoration.
 * Run: node --test tests/common.test.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  ageDays,
  decayedScore,
  knowledgeTier,
  memoryStrength,
  isInjectable,
  decoratePatterns,
  buildSkillMdFromPatterns,
  countJsonl,
} from "../lib/common.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("ageDays", () => {
  it("returns 0 for a pattern just seen", () => {
    const pattern = { lastSeen: new Date().toISOString(), score: 10 };
    assert.ok(ageDays(pattern) < 1 / 86400); // less than 1 second in days
  });

  it("returns correct age for a pattern seen 30 days ago", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const pattern = { lastSeen: thirtyDaysAgo, score: 10 };
    const days = ageDays(pattern);
    assert.ok(days >= 29.9 && days <= 30.1, `expected ~30, got ${days}`);
  });

  it("returns 0 for missing date", () => {
    assert.equal(ageDays({ score: 5 }), 0);
    assert.equal(ageDays(null), 0);
  });
});

describe("decayedScore", () => {
  const config = { ...DEFAULT_CONFIG, decayHalfLifeDays: 30 };

  it("full score when just seen", () => {
    const pattern = { lastSeen: new Date().toISOString(), score: 10 };
    const d = decayedScore(pattern, config);
    assert.ok(d > 9.9, `expected ~10, got ${d}`);
  });

  it("halves after one half-life", () => {
    const halfLifeAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const pattern = { lastSeen: halfLifeAgo, score: 10 };
    const d = decayedScore(pattern, config);
    assert.ok(d >= 4.9 && d <= 5.1, `expected ~5, got ${d}`);
  });

  it("quarters after two half-lives", () => {
    const twoHalfLivesAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const pattern = { lastSeen: twoHalfLivesAgo, score: 10 };
    const d = decayedScore(pattern, config);
    assert.ok(d >= 2.4 && d <= 2.6, `expected ~2.5, got ${d}`);
  });

  it("uses default half-life when config is missing", () => {
    const pattern = { lastSeen: new Date().toISOString(), score: 10 };
    const d = decayedScore(pattern, {});
    assert.ok(d > 9.9);
  });

  it("does not decay durable knowledge", () => {
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const pattern = { type: "preference", lastSeen: old, score: 10 };
    assert.equal(decayedScore(pattern, config), 10);
  });
});

describe("knowledgeTier", () => {
  it("partitions preferences as durable knowledge", () => {
    assert.equal(knowledgeTier({ type: "preference" }), "durable");
  });

  it("respects explicit core preference partition", () => {
    assert.equal(knowledgeTier({ type: "preference", knowledgeTier: "core" }), "core");
  });

  it("partitions runtime noise as ephemeral", () => {
    assert.equal(knowledgeTier({ type: "capability" }), "ephemeral");
    assert.equal(knowledgeTier({ id: "usage:large_context:abc" }), "ephemeral");
  });

  it("defaults ordinary patterns to core", () => {
    assert.equal(knowledgeTier({ type: "workflow" }), "core");
  });
});

describe("memoryStrength", () => {
  const config = { ...DEFAULT_CONFIG, decayHalfLifeDays: 30 };

  it("higher count → slower decay", () => {
    const halfLifeAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const lowCount = { lastSeen: halfLifeAgo, score: 10, count: 1 };
    const highCount = { lastSeen: halfLifeAgo, score: 10, count: 9 };
    const lowMs = memoryStrength(lowCount, config);
    const highMs = memoryStrength(highCount, config);
    assert.ok(highMs > lowMs, `highCount=${highMs} should be > lowCount=${lowMs}`);
  });

  it("full strength when just seen", () => {
    const pattern = { lastSeen: new Date().toISOString(), score: 10, count: 1 };
    const ms = memoryStrength(pattern, config);
    assert.ok(ms > 9.9, `expected ~10, got ${ms}`);
  });

  it("decays to near-zero after many half-lives with low count", () => {
    const ages = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const pattern = { lastSeen: ages, score: 10, count: 1 };
    const ms = memoryStrength(pattern, config);
    assert.ok(ms < 1, `expected < 1, got ${ms}`);
  });

  it("keeps durable knowledge strength stable", () => {
    const ages = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const pattern = { type: "preference", lastSeen: ages, score: 10, count: 1 };
    assert.equal(memoryStrength(pattern, config), 10);
  });
});

describe("isInjectable", () => {
  const config = { ...DEFAULT_CONFIG, autoInjectHighConfidence: true, minInjectScore: 8, minInjectCount: 2 };

  it("approved pattern is always injectable", () => {
    assert.equal(isInjectable({ status: "approved", score: 0, count: 0 }, config), true);
  });

  it("rejected pattern is never injectable", () => {
    assert.equal(isInjectable({ status: "rejected", score: 100, count: 100 }, config), false);
  });

  it("high-score, high-count pending is injectable", () => {
    const pattern = { status: "pending", score: 20, count: 5, lastSeen: new Date().toISOString() };
    assert.equal(isInjectable(pattern, config), true);
  });

  it("low-score pending is not injectable", () => {
    const pattern = { status: "pending", score: 3, count: 1, lastSeen: new Date().toISOString() };
    assert.equal(isInjectable(pattern, config), false);
  });

  it("legacy pending preference is injectable when includePendingPreferences is on", () => {
    const pattern = { status: "pending", type: "preference", score: 0, count: 1, fix: "do this" };
    assert.equal(isInjectable(pattern, config), true);
  });

  it("core preference correction is searchable but not injectable", () => {
    const pattern = { status: "pending", type: "preference", knowledgeTier: "core", score: 20, count: 5, fix: "do this" };
    assert.equal(isInjectable(pattern, config), false);
  });

  it("null pattern returns false", () => {
    assert.equal(isInjectable(null, config), false);
    assert.equal(isInjectable(undefined, config), false);
  });
});

describe("decoratePatterns", () => {
  const config = { ...DEFAULT_CONFIG, decayHalfLifeDays: 30 };

  it("adds status, decayedScore, injectable to each pattern", () => {
    const patterns = [
      { id: "a", score: 10, count: 3, lastSeen: new Date().toISOString(), status: "pending" },
      { id: "b", score: 3, count: 1, lastSeen: new Date().toISOString(), status: "pending" },
    ];
    const decorated = decoratePatterns(patterns, config);
    assert.equal(decorated.length, 2);
    for (const p of decorated) {
      assert.ok("decayedScore" in p);
      assert.ok("injectable" in p);
      assert.ok("status" in p);
    }
  });

  it("sorts by decayedScore descending", () => {
    const patterns = [
      { id: "low", score: 3, count: 1, lastSeen: new Date().toISOString() },
      { id: "high", score: 20, count: 5, lastSeen: new Date().toISOString() },
    ];
    const decorated = decoratePatterns(patterns, config);
    assert.equal(decorated[0].id, "high");
    assert.equal(decorated[1].id, "low");
  });

  it("handles empty array", () => {
    assert.deepEqual(decoratePatterns([], config), []);
  });

  it("handles null", () => {
    assert.deepEqual(decoratePatterns(null, config), []);
  });
});

describe("buildSkillMdFromPatterns", () => {
  const config = { ...DEFAULT_CONFIG, autoInjectHighConfidence: true, minInjectScore: 8, minInjectCount: 2 };

  it("returns a string with expected sections", () => {
    const patterns = [
      {
        id: "pref:test",
        type: "preference",
        status: "approved",
        score: 20, count: 5,
        lastSeen: new Date().toISOString(),
        fix: "Always use tabs",
      },
      {
        id: "pref:distilled",
        type: "preference",
        status: "pending",
        score: 20, count: 5,
        lastSeen: new Date().toISOString(),
        advisorUpdatedAt: new Date().toISOString(),
        fix: "Advisor-distilled hint",
      },
      {
        id: "pref:raw",
        type: "preference",
        status: "pending",
        score: 20, count: 5,
        lastSeen: new Date().toISOString(),
        fix: "Raw unprocessed correction",
      },
      {
        id: "workflow:read→write",
        type: "workflow",
        status: "pending",
        score: 30, count: 5,
        lastSeen: new Date().toISOString(),
        desc: "Read then write workflow",
      },
    ];
    patterns.push({
      id: "pref:transient",
      type: "preference",
      knowledgeTier: "core",
      status: "pending",
      score: 30,
      count: 5,
      lastSeen: new Date().toISOString(),
      fix: "Transient correction only",
    });
    const md = buildSkillMdFromPatterns(patterns, config, { turnCount: 10, dataDir: "/tmp/test" });
    assert.ok(md.includes("# Runtime Self-Learning"));
    assert.ok(md.includes("Verified User Preferences"));
    assert.ok(md.includes("Always use tabs"));
    assert.ok(md.includes("Advisor-distilled hint"));
    assert.ok(!md.includes("Raw unprocessed correction"));
    assert.ok(!md.includes("Transient correction only"));
    assert.ok(md.includes("Recent Workflows"));
  });

  it("handles empty patterns", () => {
    const md = buildSkillMdFromPatterns([], config, { turnCount: 0 });
    assert.ok(md.includes("0 active"));
  });

  it("trims to budget lowest-priority first (incremental token accounting)", () => {
    const now = new Date().toISOString();
    const mk = (id, type, fix) => ({ id, type, status: type === "preference" ? "approved" : "pending", knowledgeTier: type === "preference" ? "durable" : undefined, score: 30, count: 5, lastSeen: now, desc: `${id} desc`, fix });
    const patterns = [];
    for (let i = 0; i < 5; i++) patterns.push(mk(`error:e${i}`, "error", `runtime hint ${i} ${"x".repeat(40)}`));
    for (let i = 0; i < 5; i++) patterns.push(mk(`workflow:a${i}→b${i}`, "workflow", null));
    for (let i = 0; i < 5; i++) patterns.push(mk(`pref:p${i}`, "preference", `important preference ${i} ${"y".repeat(40)}`));

    const tight = { ...config, maxSkillTokens: 200 };
    const md = buildSkillMdFromPatterns(patterns, tight, { turnCount: 15 });

    // Runtime Hints are trimmed first, Preferences last → at least one
    // preference must survive while the doc stays near budget.
    assert.ok(md.includes("important preference 0"), "highest-priority preference retained");
    assert.ok(md.includes("# Runtime Self-Learning"));
    // Budget is a soft cap; the trimmed result must be far below the untrimmed size.
    const untrimmed = buildSkillMdFromPatterns(patterns, { ...config, maxSkillTokens: 100000 }, { turnCount: 15 });
    assert.ok(md.length < untrimmed.length, "trimmed output is smaller than untrimmed");
  });

  it("includes injectable runtime hints", () => {
    const patterns = [
      {
        id: "usage:large_context:test",
        type: "usage",
        status: "pending",
        score: 20, count: 3,
        lastSeen: new Date().toISOString(),
        desc: "Large context usage on test-model: 150000 tokens",
        fix: "Compact inputs before retrying.",
      },
      {
        id: "error:permission_denied",
        type: "error",
        status: "approved",
        score: 1, count: 1,
        lastSeen: new Date().toISOString(),
        desc: "Repeated error: permission_denied",
        fix: "Check write permissions.",
      },
    ];
    const md = buildSkillMdFromPatterns(patterns, config, { turnCount: 2 });
    assert.ok(md.includes("Active Runtime Hints"));
    assert.ok(md.includes("Large context usage"));
    assert.ok(md.includes("Check write permissions."));
  });
});


describe("countJsonl", () => {
  const tmpDir = path.join(os.tmpdir(), "learner-test-" + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 for non-existent file", () => {
    assert.equal(countJsonl(path.join(tmpDir, "nope.jsonl")), 0);
  });

  it("returns line count for a file with entries", () => {
    const file = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":3}\n', "utf-8");
    assert.equal(countJsonl(file), 3);
  });

  it("returns 0 for empty file", () => {
    const file = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(file, "", "utf-8");
    assert.equal(countJsonl(file), 0);
  });
});
