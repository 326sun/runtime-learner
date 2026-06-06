#!/usr/bin/env node
/**
 * Install Runtime Self-Learning as a community Hanako plugin.
 *
 * This copies the plugin into ~/.hanako/plugins/runtime-learner.
 * It does not modify Hanako source files or app.asar.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const PLUGIN_NAME = "runtime-learner";
const PLUGIN_SRC = __dirname;
const PLUGIN_DEST = path.join(os.homedir(), ".hanako", "plugins", PLUGIN_NAME);

console.log("Hana Self-Evolve - Runtime Self-Learning Engine");
console.log("=".repeat(50));

console.log("\n[1/3] Clean old install...");
if (fs.existsSync(PLUGIN_DEST)) {
  fs.rmSync(PLUGIN_DEST, { recursive: true, force: true });
  console.log("  Removed old version");
}

console.log("\n[2/3] Copy plugin...");
const filesToCopy = ["manifest.json", "index.js", "package.json"];
const dirsToCopy = ["tools", "skills", "lib"];

fs.mkdirSync(PLUGIN_DEST, { recursive: true });
for (const file of filesToCopy) {
  fs.copyFileSync(path.join(PLUGIN_SRC, file), path.join(PLUGIN_DEST, file));
}
for (const dir of dirsToCopy) {
  fs.cpSync(path.join(PLUGIN_SRC, dir), path.join(PLUGIN_DEST, dir), { recursive: true });
}
console.log(`  Installed to ${PLUGIN_DEST}`);

console.log("\n[3/3] Verify...");
const checks = [
  "package.json",
  "manifest.json",
  "index.js",
  "lib/common.js",
  "tools/stats.js",
  "tools/report.js",
  "tools/control.js",
  "skills/self-learning/SKILL.md",
];
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
