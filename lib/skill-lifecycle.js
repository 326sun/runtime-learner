import fs from "fs";
import path from "path";

const DEFAULT_KEEP = 20;

let lastTimestampMs = 0;

function timestamp() {
  // Monotonic: bump by 1ms on same-millisecond calls so snapshot names never collide.
  lastTimestampMs = Math.max(Date.now(), lastTimestampMs + 1);
  return new Date(lastTimestampMs).toISOString().replace(/[:.]/g, "-");
}

export function pruneSkillHistory(historyDir, { keep = DEFAULT_KEEP } = {}) {
  try {
    const entries = fs.readdirSync(historyDir)
      .filter((name) => name.endsWith("-SKILL.md"))
      .sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - keep))) {
      fs.rmSync(path.join(historyDir, old), { force: true });
    }
  } catch {}
}

export function snapshotSkill(skillPath, historyDir, { keep = DEFAULT_KEEP } = {}) {
  fs.mkdirSync(historyDir, { recursive: true });
  if (!fs.existsSync(skillPath)) return null;
  const target = path.join(historyDir, `${timestamp()}-SKILL.md`);
  fs.copyFileSync(skillPath, target);
  pruneSkillHistory(historyDir, { keep });
  return target;
}

export function pruneSkillBackups(skillDir, { keep = DEFAULT_KEEP } = {}) {
  try {
    const baks = fs.readdirSync(skillDir)
      .filter((name) => name.startsWith("SKILL.md.") && name.endsWith(".bak"))
      .sort();
    for (const old of baks.slice(0, Math.max(0, baks.length - keep))) {
      fs.rmSync(path.join(skillDir, old), { force: true });
    }
  } catch {}
}

export function writeSkillIfChanged(skillPath, content, historyDir, { keep = DEFAULT_KEEP } = {}) {
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  let current = null;
  try { current = fs.readFileSync(skillPath, "utf-8"); } catch {}
  if (current === content) {
    pruneSkillHistory(historyDir, { keep });
    return { changed: false, snapshotPath: null };
  }
  const snapshotPath = snapshotSkill(skillPath, historyDir, { keep });
  fs.writeFileSync(skillPath, content, "utf-8");
  return { changed: true, snapshotPath };
}

// ── Skill registry (merged from skill-registry.js) ──

import { readJson, writeJson, learnerDir } from "./common.js";
import { appendEvent } from "./event-log.js";

export function skillRegistryPath(baseDir = learnerDir()) {
  return path.join(baseDir, "skill_registry.json");
}

export function loadSkillRegistry(baseDir = learnerDir()) {
  return readJson(skillRegistryPath(baseDir), {}) || {};
}

export function saveSkillRegistry(baseDir, registry) {
  writeJson(skillRegistryPath(baseDir), registry);
  return registry;
}

export function updateSkillState(baseDir, skillPath, state = {}) {
  const registry = loadSkillRegistry(baseDir);
  const key = skillPath || "skills/self-learning/SKILL.md";
  const next = {
    status: "active",
    version: null,
    firstSeenAt: new Date().toISOString(),
    ...(registry[key] || {}),
    ...state,
    updatedAt: new Date().toISOString(),
  };
  registry[key] = next;
  saveSkillRegistry(baseDir, registry);
  appendEvent(baseDir, {
    type: `skill.${next.status || "updated"}`,
    entityType: "skill",
    entityId: key,
    summary: `Skill ${next.status || "updated"}: ${key}`,
    data: next,
  });
  return next;
}
