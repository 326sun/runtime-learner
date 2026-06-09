import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { DEFAULT_CONFIG } from "../lib/common.js";
import { applyPolicyProfile, listPolicyProfiles } from "../lib/policy-profiles.js";
import { buildAuditBundle, exportAuditBundle } from "../lib/audit-bundle.js";

test("policy profiles list stable built-in modes", () => {
  const names = listPolicyProfiles().map((p) => p.name).sort();
  assert.deepEqual(names, ["autonomous", "balanced", "conservative"]);
});

test("conservative policy enables review-first defaults without enabling external services", () => {
  const result = applyPolicyProfile({ ...DEFAULT_CONFIG, modelAdvisorEnabled: true, semanticSearchEnabled: true }, "conservative");
  assert.equal(result.ok, true);
  assert.equal(result.config.governanceProfile, "conservative");
  assert.equal(result.config.requireReviewForAutoApply, true);
  assert.equal(result.config.autoApproveHighConfidence, false);
  assert.equal(result.config.includePendingPreferences, false);
  assert.equal(result.config.modelAdvisorEnabled, false);
  assert.equal(result.config.semanticSearchEnabled, false);
  assert.ok(result.changed.requireReviewForAutoApply);
});

test("unknown policy is rejected with available profile names", () => {
  const result = applyPolicyProfile(DEFAULT_CONFIG, "reckless");
  assert.equal(result.ok, false);
  assert.ok(result.available.includes("balanced"));
});

test("audit bundle redacts secrets and writes markdown/json files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-bundle-"));
  const bundle = buildAuditBundle({
    version: "test",
    config: { ...DEFAULT_CONFIG, governanceProfile: "conservative", semanticEmbeddingApiKey: "secret" },
    patterns: [
      { id: "p1", type: "workflow", status: "approved", score: 9, count: 3, scope: { project: "alpha" }, desc: "A", fix: "B" },
      { id: "p2", type: "error", status: "pending", score: 3, count: 1, scope: { project: "general" }, desc: "C", fix: "D" },
    ],
    facts: [{ id: "f1" }],
    proposals: [{ id: "pr1", status: "pending" }],
    reviews: [{ id: "rv1", status: "queued" }],
    events: [{ id: "evt1" }],
    eventSummary: { proposal: { pr1: { status: "pending" } } },
    doctor: { status: "good", label: "Good", score: 100, issues: [] },
  });
  assert.equal(bundle.config.semanticEmbeddingApiKey, "[redacted]");
  assert.equal(bundle.scopeDistribution.alpha, 1);
  const written = exportAuditBundle(tmp, bundle, { name: "run" });
  assert.ok(fs.existsSync(written.jsonPath));
  assert.ok(fs.existsSync(written.mdPath));
  const md = fs.readFileSync(written.mdPath, "utf-8");
  assert.match(md, /Runtime Self-Learning Audit Bundle/);
});
