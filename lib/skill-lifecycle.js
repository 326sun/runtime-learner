import fs from "fs";
import path from "path";

const DEFAULT_KEEP = 20;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
