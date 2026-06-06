import fs from "fs";
import path from "path";
import os from "os";
import { DEFAULT_CONFIG, readJson, writeJson, ageDays, decayedScore, isInjectable } from "../lib/common.js";

export const name = "self_learning_control";
export const description = "Review and control the runtime self-learning engine: list patterns, approve/reject hints, update injection config, or roll back the generated skill.";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["status", "list", "approve", "reject", "set_config", "rollback", "regenerate_skill"],
      description: "Control action to run.",
    },
    id: { type: "string", description: "Pattern id for approve/reject." },
    autoInjectHighConfidence: { type: "boolean", description: "Whether high-confidence pending patterns can be injected automatically." },
    minInjectScore: { type: "number", description: "Minimum decayed score for automatic injection." },
    minInjectCount: { type: "number", description: "Minimum repeat count for automatic injection." },
    decayHalfLifeDays: { type: "number", description: "Score half-life in days." },
    includePendingPreferences: { type: "boolean", description: "Whether detected user corrections can be injected before manual approval." },
  },
  required: ["action"],
};

function hanakoHome() {
  return process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
}

function paths(ctx) {
  const learnerDir = path.join(hanakoHome(), "self-learning");
  const pluginDir = ctx?.pluginDir || path.join(hanakoHome(), "plugins", "runtime-learner");
  return {
    learnerDir,
    pluginDir,
    configPath: path.join(learnerDir, "config.json"),
    patternsPath: path.join(learnerDir, "patterns.json"),
    historyDir: path.join(learnerDir, "skill_history"),
    skillPath: path.join(pluginDir, "skills", "self-learning", "SKILL.md"),
  };
}

function loadConfig(configPath) {
  const config = { ...DEFAULT_CONFIG, ...readJson(configPath, {}) };
  writeJson(configPath, config);
  return config;
}

function decorate(patterns, config) {
  return patterns.map((pattern) => ({
    ...pattern,
    status: pattern.status || "pending",
    decayedScore: Number(decayedScore(pattern, config).toFixed(2)),
    injectable: isInjectable(pattern, config),
  })).sort((a, b) => (b.decayedScore || 0) - (a.decayedScore || 0));
}

function buildSkill(patterns, config, learnerDir) {
  const decorated = decorate(patterns, config);
  const prefs = decorated.filter((p) => p.type === "preference" && p.fix && p.injectable).slice(0, 8);
  const hints = decorated.filter((p) => p.injectable).slice(0, 8);
  const lines = [
    "# Runtime Self-Learning",
    "",
    "This plugin observes Hanako runtime behavior, learns repeated local patterns, and injects only high-confidence reminders.",
    "Use these reminders conservatively. They are local hints, not hard rules.",
    "",
  ];

  if (prefs.length) {
    lines.push("## User Preferences");
    for (const pref of prefs) lines.push(`- ${pref.fix}`);
    lines.push("");
  }

  if (hints.length) {
    lines.push("## Learned Runtime Hints");
    for (const hint of hints) {
      lines.push(`- [${hint.type}, ${hint.status}, count=${hint.count}, score=${hint.decayedScore}] ${hint.desc}${hint.fix ? ` -> ${hint.fix}` : ""}`);
    }
    lines.push("");
  }

  lines.push(
    "## Available Tools",
    "- `self_learning_stats`: inspect local learning statistics.",
    "- `self_learning_report`: generate a local learning report.",
    "- `self_learning_control`: review, approve, reject, configure, or roll back learned hints.",
    "",
    "## Safety",
    "- Do not expose private file paths, prompts, or logs unless the user asks.",
    "- Treat learned hints as suggestions and prefer current user instructions.",
    "",
    `Config: autoInjectHighConfidence=${config.autoInjectHighConfidence}, minInjectScore=${config.minInjectScore}, minInjectCount=${config.minInjectCount}`,
    `Data dir: ${learnerDir}`,
    `Updated: ${new Date().toISOString()}`,
    "",
  );
  return lines.join("\n");
}

function snapshotSkill(skillPath, historyDir) {
  fs.mkdirSync(historyDir, { recursive: true });
  if (!fs.existsSync(skillPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(historyDir, `${stamp}-SKILL.md`);
  fs.copyFileSync(skillPath, target);
  return target;
}

function regenerateSkill(pathsValue, patterns, config) {
  fs.mkdirSync(path.dirname(pathsValue.skillPath), { recursive: true });
  snapshotSkill(pathsValue.skillPath, pathsValue.historyDir);
  fs.writeFileSync(pathsValue.skillPath, buildSkill(patterns, config, pathsValue.learnerDir), "utf-8");
}

export async function execute(input = {}, ctx) {
  const p = paths(ctx);
  const config = loadConfig(p.configPath);
  const patterns = readJson(p.patternsPath, []);
  const action = input.action;

  if (action === "status") {
    const decorated = decorate(patterns, config);
    const history = fs.readdirSync(p.historyDir).filter((name) => name.endsWith("-SKILL.md")).sort();
    return JSON.stringify({
      config,
      patterns: decorated.length,
      injectable: decorated.filter((x) => x.injectable).length,
      pending: decorated.filter((x) => x.status === "pending").length,
      approved: decorated.filter((x) => x.status === "approved").length,
      rejected: decorated.filter((x) => x.status === "rejected").length,
      historySnapshots: history.length,
      dataDir: p.learnerDir,
    }, null, 2);
  }

  if (action === "list") {
    return JSON.stringify(decorate(patterns, config).slice(0, 20).map((pattern) => ({
      id: pattern.id,
      type: pattern.type,
      status: pattern.status,
      count: pattern.count,
      score: pattern.score,
      decayedScore: pattern.decayedScore,
      injectable: pattern.injectable,
      desc: pattern.desc,
      fix: pattern.fix || null,
    })), null, 2);
  }

  if (action === "approve" || action === "reject") {
    fs.mkdirSync(p.learnerDir, { recursive: true });
    fs.mkdirSync(p.historyDir, { recursive: true });
    if (!input.id) throw new Error("id is required for approve/reject");
    const target = patterns.find((pattern) => pattern.id === input.id);
    if (!target) throw new Error(`pattern not found: ${input.id}`);
    target.status = action === "approve" ? "approved" : "rejected";
    target.reviewedAt = new Date().toISOString();
    writeJson(p.patternsPath, patterns);
    regenerateSkill(p, patterns, config);
    return JSON.stringify({ ok: true, id: target.id, status: target.status }, null, 2);
  }

  if (action === "set_config") {
    fs.mkdirSync(p.learnerDir, { recursive: true });
    fs.mkdirSync(p.historyDir, { recursive: true });
    const next = { ...config };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (Object.prototype.hasOwnProperty.call(input, key)) next[key] = input[key];
    }
    writeJson(p.configPath, next);
    regenerateSkill(p, patterns, next);
    return JSON.stringify({ ok: true, config: next }, null, 2);
  }

  if (action === "regenerate_skill") {
    fs.mkdirSync(p.learnerDir, { recursive: true });
    fs.mkdirSync(p.historyDir, { recursive: true });
    regenerateSkill(p, patterns, config);
    return JSON.stringify({ ok: true, skillPath: p.skillPath }, null, 2);
  }

  if (action === "rollback") {
    fs.mkdirSync(p.learnerDir, { recursive: true });
    fs.mkdirSync(p.historyDir, { recursive: true });
    const history = fs.readdirSync(p.historyDir).filter((name) => name.endsWith("-SKILL.md")).sort();
    const latest = history.at(-1);
    if (!latest) throw new Error("no skill history snapshot available");
    fs.mkdirSync(path.dirname(p.skillPath), { recursive: true });
    fs.copyFileSync(path.join(p.historyDir, latest), p.skillPath);
    return JSON.stringify({ ok: true, restored: latest, skillPath: p.skillPath }, null, 2);
  }

  throw new Error(`unknown action: ${action}`);
}
