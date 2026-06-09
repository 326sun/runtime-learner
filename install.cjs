#!/usr/bin/env node
/**
 * Install Runtime Self-Learning as a community Hanako plugin.
 *
 * This copies the plugin into ~/.hanako/plugins/hanako-runtime-learner.
 * It does not modify Hanako source files or app.asar.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const PLUGIN_NAME = "hanako-runtime-learner";
const PLUGIN_SRC = __dirname;
const PLUGIN_DEST = path.join(os.homedir(), ".hanako", "plugins", PLUGIN_NAME);

console.log("Hana Self-Evolve - Runtime Self-Learning Engine");
console.log("=".repeat(50));

// ── Prerequisite check ──
console.log("\n[1/4] Syntax check before install...");
const JS_FILES = [
  "index.js",
  "lib/common.js",
  "lib/helpers.js",
  "lib/hana-runtime-compat.js",
  "lib/official-utility-model.js",
  "lib/model-advisor.js",
  "lib/official-memory-bridge.js",
  "lib/pattern-detector.js",
  "lib/observer.js",
  "lib/proposals.js",
  "lib/session-turn.js",
  "lib/skill-lifecycle.js",
  "lib/scope.js",
  "lib/memory-index.js",
  "lib/memory-gate.js",
  "lib/evidence.js",
  "lib/temporal.js",
  "lib/facts.js",
  "lib/memfs.js",
  "lib/rank-fusion.js",
  "lib/embeddings.js",
  "lib/event-log.js",
  "lib/validation-gate.js",
  "lib/review-queue.js",
  "lib/tool-repair.js",
  "lib/policy-profiles.js",
  "lib/audit-bundle.js",
  "lib/usage-pipeline.js",
  "lib/pipeline.js",
  "tools/stats.js",
  "tools/report.js",
  "tools/control.js",
  "tools/activity.js",
  "tools/open-dir.js",
  "tools/search.js",
  "tools/doctor.js",
  "tools/normalize-config.js",
  "tools/_shared.js",
];
let syntaxOk = true;
for (const file of JS_FILES) {
  const fullPath = path.join(PLUGIN_SRC, file);
  if (!fs.existsSync(fullPath)) {
    console.log(`  MISS  ${file}`);
    syntaxOk = false;
    continue;
  }
  try {
    execSync(`node --check "${fullPath}"`, { stdio: "pipe" });
    console.log(`  OK    ${file}`);
  } catch (err) {
    console.log(`  FAIL  ${file}: ${err.stderr?.toString().trim() || err.message}`);
    syntaxOk = false;
  }
}

// Also validate manifest.json is valid JSON (no comments, no trailing commas)
try {
  JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, "manifest.json"), "utf-8"));
  console.log("  OK    manifest.json (valid JSON)");
} catch (err) {
  console.log(`  FAIL  manifest.json: ${err.message}`);
  syntaxOk = false;
}

// Version consistency: manifest.json and package.json must agree
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, "manifest.json"), "utf-8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, "package.json"), "utf-8"));
  if (manifest.version !== pkg.version) {
    console.log(`  WARN  version mismatch: manifest=${manifest.version}, package=${pkg.version}`);
  } else {
    console.log(`  OK    version consistent: ${manifest.version}`);
  }
} catch (err) {
  console.log(`  WARN  version consistency check failed: ${err.message}`);
}

if (!syntaxOk) {
  console.error("\nSyntax errors found. Fix them before installing.");
  process.exit(1);
}

// ── Clean ──
console.log("\n[2/4] Clean old install...");
if (fs.existsSync(PLUGIN_DEST)) {
  fs.rmSync(PLUGIN_DEST, { recursive: true, force: true });
  console.log("  Removed old version");
}

// ── Copy ──
console.log("\n[3/4] Copy plugin...");
const filesToCopy = ["manifest.json", "index.js", "package.json", "README.md", "ARCHITECTURE.md", "INSTALL.md", "LICENSE"];
const dirsToCopy = ["tools", "skills", "lib"];

fs.mkdirSync(PLUGIN_DEST, { recursive: true });
for (const file of filesToCopy) {
  fs.copyFileSync(path.join(PLUGIN_SRC, file), path.join(PLUGIN_DEST, file));
}
for (const dir of dirsToCopy) {
  fs.cpSync(path.join(PLUGIN_SRC, dir), path.join(PLUGIN_DEST, dir), { recursive: true });
}
console.log(`  Installed to ${PLUGIN_DEST}`);

// ── Verify deployed files ──
console.log("\n[4/4] Verify...");
const checks = [...JS_FILES, "manifest.json", "package.json", "README.md", "ARCHITECTURE.md", "INSTALL.md", "LICENSE", "skills/self-learning/SKILL.md"];
let ok = true;
for (const check of checks) {
  if (fs.existsSync(path.join(PLUGIN_DEST, check))) {
    console.log(`  OK    ${check}`);
  } else {
    console.log(`  MISS  ${check}`);
    ok = false;
  }
}

console.log("\n" + "=".repeat(50));
if (ok) {
  console.log("Self-Evolve installed.");
  console.log("");
  console.log("To activate:");
  console.log("  1. Restart Hanako");
  console.log("  2. Settings > Plugins > Enable 'Allow full-access plugins'");
  console.log("  3. Enable 'Runtime Self-Learning'");
  console.log("");
  console.log("Data will be stored at: ~/.hanako/self-learning/");
} else {
  console.log("Installation incomplete. Check the missing files above.");
  process.exitCode = 1;
}
