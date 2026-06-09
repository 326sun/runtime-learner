// Export a portable, local audit bundle for governance review.
// The bundle is a snapshot only; it does not mutate runtime learning state.

import fs from "fs";
import path from "path";
import { decoratePatterns, DEFAULT_CONFIG } from "./common.js";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactConfig(config = {}) {
  const out = { ...config };
  for (const key of Object.keys(out)) {
    if (/api.?key|token|secret|password/i.test(key)) {
      out[key] = out[key] ? "[redacted]" : out[key];
    }
  }
  return out;
}

function countBy(values) {
  const out = {};
  for (const value of values) out[value || "unknown"] = (out[value || "unknown"] || 0) + 1;
  return out;
}

function scopeProject(pattern) {
  return pattern?.scope?.project || pattern?.context?.project || "general";
}

function renderMarkdown(bundle) {
  const lines = [];
  lines.push(`# Runtime Self-Learning Audit Bundle`);
  lines.push("");
  lines.push(`Generated: ${bundle.generatedAt}`);
  lines.push(`Version: ${bundle.version || "unknown"}`);
  lines.push(`Governance profile: ${bundle.config?.governanceProfile || "balanced"}`);
  lines.push("");
  lines.push("## Doctor");
  lines.push("");
  lines.push(`Status: **${bundle.doctor?.label || bundle.doctor?.status || "unknown"}**`);
  lines.push(`Score: ${bundle.doctor?.score ?? "n/a"}`);
  lines.push(`Issues: ${bundle.doctor?.issues?.length || 0}`);
  lines.push("");
  if (bundle.doctor?.issues?.length) {
    for (const issue of bundle.doctor.issues.slice(0, 20)) {
      lines.push(`- [${issue.severity}] ${issue.type}: ${issue.message}`);
    }
    lines.push("");
  }
  lines.push("## Memory Summary");
  lines.push("");
  lines.push(`Patterns: ${bundle.summary.patterns}`);
  lines.push(`Facts: ${bundle.summary.facts}`);
  lines.push(`Proposals: ${bundle.summary.proposals}`);
  lines.push(`Reviews: ${bundle.summary.reviews}`);
  lines.push(`Events sampled: ${bundle.summary.events}`);
  lines.push("");
  lines.push("### Pattern scopes");
  lines.push("");
  for (const [project, count] of Object.entries(bundle.scopeDistribution || {})) {
    lines.push(`- ${project}: ${count}`);
  }
  lines.push("");
  lines.push("## Event Replay Summary");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(bundle.eventSummary || {}, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("This bundle redacts API keys/tokens from config and is intended for local review or issue attachment after manual inspection.");
  return lines.join("\n");
}

export function buildAuditBundle({
  version = "unknown",
  config = DEFAULT_CONFIG,
  patterns = [],
  facts = [],
  proposals = [],
  reviews = [],
  events = [],
  eventSummary = {},
  doctor = null,
} = {}) {
  const decorated = decoratePatterns(patterns, config);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version,
    config: redactConfig(config),
    summary: {
      patterns: decorated.length,
      injectable: decorated.filter((p) => p.injectable).length,
      facts: facts.length,
      proposals: proposals.length,
      reviews: reviews.length,
      events: events.length,
      doctorStatus: doctor?.status || null,
    },
    scopeDistribution: countBy(decorated.map(scopeProject)),
    patternTypes: countBy(decorated.map((p) => p.type)),
    proposalStatus: countBy(proposals.map((p) => p.status)),
    reviewStatus: countBy(reviews.map((r) => r.status)),
    eventSummary,
    doctor,
  };
}

export function exportAuditBundle(learnerDir, bundle, { name = null } = {}) {
  const dir = path.join(learnerDir, "audit", name || timestamp());
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, "audit-bundle.json");
  const mdPath = path.join(dir, "audit-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(bundle, null, 2), "utf-8");
  fs.writeFileSync(mdPath, renderMarkdown(bundle), "utf-8");
  return { dir, jsonPath, mdPath };
}
