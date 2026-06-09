#!/usr/bin/env node
// One-time maintenance script: normalize a residual self-learning config.json.
//
// Fixes issue #7 — `modelAdvisorEnabled: true` left on disk while no usable
// advisor endpoint resolves. Such a config makes the plugin attempt (and fail)
// the advisor once per distinct reason on every startup. This script turns the
// flag off when, and only when, the endpoint cannot be resolved with the exact
// same logic the runtime uses (resolveAdvisorConfig), so a correctly configured
// advisor is never disabled.
//
// Usage:
//   node tools/normalize-config.js            # apply the fix in place
//   node tools/normalize-config.js --dry-run  # report what would change only
//   node tools/normalize-config.js --file <path>   # target a specific config.json

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { learnerDir, DEFAULT_CONFIG } from "../lib/common.js";
import { resolveAdvisorConfig } from "../lib/model-advisor.js";

function parseArgs(argv) {
  const args = { dryRun: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--file" || a === "-f") args.file = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file || path.join(learnerDir(), "config.json");

  if (!fs.existsSync(file)) {
    console.log(`No config file at ${file} — nothing to normalize (runtime will write defaults).`);
    return 0;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`Failed to parse ${file}: ${err.message}`);
    return 1;
  }

  const changes = [];

  if (config.modelAdvisorEnabled) {
    const resolved = resolveAdvisorConfig({ ...DEFAULT_CONFIG, ...config });
    if (!resolved.ok) {
      config.modelAdvisorEnabled = false;
      changes.push(`modelAdvisorEnabled: true -> false (no usable endpoint: ${resolved.reason})`);
    } else {
      console.log("modelAdvisorEnabled is on and a usable endpoint resolves — left as-is.");
    }
  }

  if (changes.length === 0) {
    console.log("Config already normal — no changes needed.");
    return 0;
  }

  console.log(`Normalizing ${file}:`);
  for (const c of changes) console.log(`  - ${c}`);

  if (args.dryRun) {
    console.log("(--dry-run: no file written)");
    return 0;
  }

  // Atomic write (temp + rename) mirroring common.js writeJson semantics.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.error(`Failed to write ${file}: ${err.message}`);
    return 1;
  }
  console.log("Done.");
  return 0;
}

function isDirectCliRun() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectCliRun()) {
  process.exit(main());
}

export { main, parseArgs };
