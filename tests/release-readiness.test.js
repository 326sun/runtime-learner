import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import { buildReleaseReadiness, exportReleaseReadiness, formatReleaseReadinessReport, REQUIRED_LTS_DOCS } from "../lib/release-readiness.js";

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function makeProject({ version = "4.0.18-lts", lockVersion = version, scenarios = 16, omitAcceptance = false, testCount = 496 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-release-readiness-"));
  const baseVersion = version.replace(/-lts$/, "");
  write(path.join(root, "package.json"), JSON.stringify({ name: "hanako-runtime-learner", version }, null, 2));
  write(path.join(root, "package-lock.json"), JSON.stringify({ name: "hanako-runtime-learner", version: lockVersion, lockfileVersion: 3, packages: { "": { name: "hanako-runtime-learner", version: lockVersion } } }, null, 2));
  write(path.join(root, "manifest.json"), JSON.stringify({ name: "hanako-runtime-learner", version }, null, 2));
  write(
    path.join(root, "README.md"),
    [
      `<img src="https://img.shields.io/badge/version-${baseVersion}--lts-blue" alt="version">`,
      `<img src="https://img.shields.io/badge/tests-${testCount}%2F${testCount}-success" alt="tests">`,
      `git clone --branch v${version} https://github.com/example/hanako-runtime-learner.git`,
      `npm test           # ${testCount} 项测试`,
      "",
    ].join("\n"),
  );
  write(path.join(root, "CHANGELOG.md"), `# Changelog\n\n## ${version.replace(/-lts$/i, " LTS")}\n\n- Release readiness.\n`);
  for (const rel of REQUIRED_LTS_DOCS) write(path.join(root, rel), rel.endsWith("API_FREEZE.md") ? "# API Freeze\n\nv4.0 frozen API surface.\n" : `# ${rel}\n\n${version}\n`);
  write(path.join(root, "docs", "DESIGN_GOAL_COMPLETION_MATRIX.md"), `# Design Goal Completion Matrix\n\nStatus: ${version}.\n`);
  if (!omitAcceptance) write(path.join(root, `docs/ACCEPTANCE-v${version.replace(/-lts$/i, "-LTS")}.md`), "# 验收报告\n\nok\n");
  write(path.join(root, "benchmarks", "baseline-v4.0.9.json"), JSON.stringify({ metrics: { task_success_rate: 1 } }, null, 2));
  write(path.join(root, "benchmarks", "thresholds.json"), JSON.stringify({ thresholds: {} }, null, 2));
  for (let i = 0; i < scenarios; i += 1) {
    write(path.join(root, "benchmarks", "scenarios", "quality", `scenario-${i}.json`), JSON.stringify({ id: `quality.scenario_${i}`, title: `Scenario ${i}`, steps: [{ type: "note", note: "ok" }] }, null, 2));
  }
  return root;
}

test("release readiness passes when LTS release contract is coherent", () => {
  const root = makeProject();
  const result = buildReleaseReadiness(root, { minBenchmarkScenarios: 16 });
  assert.equal(result.summary.status, "ready");
  assert.equal(result.summary.ok, true);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.version, "4.0.18-lts");
});

test("release readiness blocks mismatched lockfile and missing acceptance report", () => {
  const root = makeProject({ lockVersion: "4.0.17-lts", omitAcceptance: true });
  const result = buildReleaseReadiness(root, { minBenchmarkScenarios: 16 });
  assert.equal(result.summary.status, "blocked");
  assert(result.summary.failedChecks.includes("package_lock.version_matches"));
  assert(result.summary.failedChecks.includes("docs.acceptance_current_version"));
});

test("release readiness report can be exported as JSON and Markdown", () => {
  const root = makeProject();
  const outputDir = path.join(root, "out");
  const result = exportReleaseReadiness(root, outputDir, { minBenchmarkScenarios: 16 });
  assert.equal(result.status, "ready");
  assert(fs.existsSync(path.join(outputDir, "release-readiness.json")));
  const md = fs.readFileSync(path.join(outputDir, "release-readiness.md"), "utf-8");
  assert(md.includes("# Release Readiness Report"));
  assert(md.includes("Status: ready"));
});

test("release readiness formatter surfaces failed checks", () => {
  const root = makeProject({ scenarios: 2 });
  const result = buildReleaseReadiness(root, { minBenchmarkScenarios: 16 });
  const md = formatReleaseReadinessReport(result);
  assert.equal(result.summary.status, "blocked");
  assert(md.includes("benchmarks.corpus_valid"));
  assert(md.includes("blocked"));
});
