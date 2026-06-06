import fs from "fs";
import path from "path";
import os from "os";
import { DEFAULT_CONFIG, readJson, ageDays, decayedScore, isInjectable } from "../lib/common.js";

export const name = "self_learning_stats";
export const description = "View runtime self-learning statistics: turns, patterns, injectable hints, review states, and current config.";

export const parameters = {
  type: "object",
  properties: {},
  required: [],
};

function countJsonl(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    const text = fs.readFileSync(file, "utf-8").trim();
    return text ? text.split("\n").filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

export async function execute() {
  const hanakoHome = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
  const learnerDir = path.join(hanakoHome, "self-learning");
  const patternsPath = path.join(learnerDir, "patterns.json");
  const experiencePath = path.join(learnerDir, "experience_log.jsonl");
  const errorPath = path.join(learnerDir, "error_log.jsonl");
  const turnsPath = path.join(learnerDir, "turns.jsonl");
  const configPath = path.join(learnerDir, "config.json");
  const historyDir = path.join(learnerDir, "skill_history");

  const config = { ...DEFAULT_CONFIG, ...readJson(configPath, {}) };
  const patterns = readJson(patternsPath, []);
  const decorated = patterns.map((pattern) => ({
    ...pattern,
    status: pattern.status || "pending",
    decayedScore: Number(decayedScore(pattern, config).toFixed(2)),
    injectable: isInjectable(pattern, config),
  })).sort((a, b) => b.decayedScore - a.decayedScore);

  const byStatus = { pending: 0, approved: 0, rejected: 0 };
  for (const pattern of decorated) byStatus[pattern.status] = (byStatus[pattern.status] || 0) + 1;

  let historySnapshots = 0;
  try {
    historySnapshots = fs.readdirSync(historyDir).filter((name) => name.endsWith("-SKILL.md")).length;
  } catch {}

  return JSON.stringify({
    totalTurns: countJsonl(experiencePath),
    compactTurns: countJsonl(turnsPath),
    errors: countJsonl(errorPath),
    patternCount: decorated.length,
    injectableCount: decorated.filter((pattern) => pattern.injectable).length,
    byStatus,
    historySnapshots,
    config,
    topPatterns: decorated.slice(0, 5).map((pattern) => ({
      id: pattern.id,
      type: pattern.type,
      status: pattern.status,
      count: pattern.count,
      decayedScore: pattern.decayedScore,
      injectable: pattern.injectable,
      desc: pattern.desc,
    })),
    dataDir: learnerDir,
  }, null, 2);
}
