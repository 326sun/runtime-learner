// Guards against config-default drift across the three places a default is
// declared: lib/common.js (DEFAULT_CONFIG, the runtime source of truth),
// manifest.json (the settings UI), and README.md (the documented table).
//
// This is the regression net for the class of bug the v0.8.2 plan called out:
// e.g. modelAdvisorMinIntervalMinutes sliding between 60 and 180 in one place
// but not the others. We don't require every key to appear everywhere (some
// runtime keys are intentionally not surfaced in the settings UI, and the UI has
// the display-only dataDirPath), but where a key DOES appear in two places, the
// defaults must agree.

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../lib/common.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf-8"));
const manifestProps = manifest.contributes.configuration.properties;

// Manifest keys that intentionally have no DEFAULT_CONFIG counterpart (pure
// display fields written by the runtime, never read back as config).
const MANIFEST_ONLY = new Set(["dataDirPath"]);

describe("config consistency · manifest ↔ DEFAULT_CONFIG", () => {
  it("every manifest default matches DEFAULT_CONFIG for shared keys", () => {
    for (const [key, spec] of Object.entries(manifestProps)) {
      if (MANIFEST_ONLY.has(key)) continue;
      assert.ok(
        Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key),
        `manifest exposes "${key}" but DEFAULT_CONFIG has no such key (add it or to MANIFEST_ONLY)`
      );
      assert.strictEqual(
        spec.default,
        DEFAULT_CONFIG[key],
        `manifest default for "${key}" (${JSON.stringify(spec.default)}) != DEFAULT_CONFIG (${JSON.stringify(DEFAULT_CONFIG[key])})`
      );
    }
  });

  it("manifest declares a default for every exposed property", () => {
    for (const [key, spec] of Object.entries(manifestProps)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(spec, "default"),
        `manifest property "${key}" is missing a default`
      );
    }
  });
});

describe("config consistency · README ↔ DEFAULT_CONFIG", () => {
  // Parse README config tables. Rows look like:
  //   | `key` | `value` | description |
  // We only consider rows whose first cell is a known DEFAULT_CONFIG key.
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf-8");
  const rowRe = /^\|\s*`([a-zA-Z][a-zA-Z0-9]*)`\s*\|\s*`([^`]*)`\s*\|/gm;

  const documented = new Map();
  let m;
  while ((m = rowRe.exec(readme)) !== null) {
    const [, key, rawValue] = m;
    if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
      documented.set(key, rawValue);
    }
  }

  it("finds documented config rows in the README", () => {
    assert.ok(documented.size >= 5, `expected several documented config keys, found ${documented.size}`);
  });

  it("every documented default matches DEFAULT_CONFIG", () => {
    for (const [key, rawValue] of documented) {
      const expected = DEFAULT_CONFIG[key];
      let ok;
      if (typeof expected === "boolean") ok = rawValue === String(expected);
      else if (typeof expected === "number") ok = Number(rawValue) === expected;
      else ok = rawValue === expected;
      assert.ok(
        ok,
        `README documents "${key}" default as \`${rawValue}\` but DEFAULT_CONFIG is ${JSON.stringify(expected)}`
      );
    }
  });
});
