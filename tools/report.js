import fs from "fs";
import path from "path";
import os from "os";
import { DEFAULT_CONFIG, readJson, ageDays, decayedScore, isInjectable } from "../lib/common.js";

export const name = "self_learning_report";
export const description = "Generate a local self-learning report: task trends, error trends, review states, injectable hints, and skill candidates.";

export const parameters = {
  type: "object",
  properties: {
    days: { type: "number", description: "Days to analyze, default 7" },
  },
  required: [],
};

function readRecentJsonl(file, cutoff) {
  const rows = [];
  try {
    if (!fs.existsSync(file)) return rows;
    for (const line of fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (new Date(row.date).getTime() >= cutoff) rows.push(row);
      } catch {}
    }
  } catch {}
  return rows;
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key] || "unknown"] = (counts[row[key] || "unknown"] || 0) + 1;
  return counts;
}

export async function execute(input = {}) {
  const days = input.days || 7;
  const hanakoHome = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
  const learnerDir = path.join(hanakoHome, "self-learning");
  const experiencePath = path.join(learnerDir, "experience_log.jsonl");
  const errorPath = path.join(learnerDir, "error_log.jsonl");
  const patternsPath = path.join(learnerDir, "patterns.json");
  const configPath = path.join(learnerDir, "config.json");
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const experiences = readRecentJsonl(experiencePath, cutoff);
  const errors = readRecentJsonl(errorPath, cutoff);
  const config = { ...DEFAULT_CONFIG, ...readJson(configPath, {}) };
  const patterns = readJson(patternsPath, []).map((pattern) => ({
    ...pattern,
    status: pattern.status || "pending",
    decayedScore: Number(decayedScore(pattern, config).toFixed(2)),
    injectable: isInjectable(pattern, config),
  })).sort((a, b) => b.decayedScore - a.decayedScore);

  const injectable = patterns.filter((pattern) => pattern.injectable);
  const pending = patterns.filter((pattern) => pattern.status === "pending");
  const rejected = patterns.filter((pattern) => pattern.status === "rejected");
  const skillCandidates = patterns.filter((pattern) => pattern.decayedScore >= 12 && pattern.count >= 3);

  return [
    `# Self-Learning Report (last ${days} days)`,
    "",
    "## Overview",
    `- Total tasks: ${experiences.length}`,
    `- Errors: ${errors.length}`,
    `- Patterns detected: ${patterns.length}`,
    `- Injectable hints: ${injectable.length}`,
    `- Pending review: ${pending.length}`,
    `- Rejected: ${rejected.length}`,
    `- Skill candidates: ${skillCandidates.length}`,
    "",
    "## Current Config",
    `- autoInjectHighConfidence: ${config.autoInjectHighConfidence}`,
    `- minInjectScore: ${config.minInjectScore}`,
    `- minInjectCount: ${config.minInjectCount}`,
    `- decayHalfLifeDays: ${config.decayHalfLifeDays}`,
    `- includePendingPreferences: ${config.includePendingPreferences}`,
    "",
    "## Task Distribution",
    ...Object.entries(countBy(experiences, "taskType")).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Error Distribution",
    ...(errors.length ? Object.entries(countBy(errors, "errorType")).map(([k, v]) => `- ${k}: ${v}`) : ["- No errors recorded"]),
    "",
    "## Injectable Hints",
    ...(injectable.length ? injectable.slice(0, 10).map((p) => `- [${p.type}, ${p.status}, score=${p.decayedScore}] ${p.id}: ${p.desc}${p.fix ? ` -> ${p.fix}` : ""}`) : ["- No injectable hints"]),
    "",
    "## Pending Review",
    ...(pending.length ? pending.slice(0, 10).map((p) => `- [score=${p.decayedScore}] ${p.id}: ${p.desc}`) : ["- No pending patterns"]),
    "",
    `> Data dir: ${learnerDir}`,
  ].join("\n");
}
