/**
 * memfs — human-readable Markdown view of long-term memory (v1.2).
 *
 * Why (Letta MemFS): patterns.json is the machine source of truth, but a user
 * can't audit raw JSON. MemFS renders the *current* memory as a small tree of
 * Markdown files you can open, read, and diff. It is a DERIVED view — never the
 * source — so it is always safe to delete and regenerate from patterns/facts.
 *
 *   memfs/
 *   ├── system/
 *   │   ├── user_profile.md       # durable preferences (who the user is)
 *   │   ├── hard_constraints.md   # approved / global durable rules
 *   │   └── active_projects.md    # project → item counts
 *   ├── projects/<project>.md     # per concrete project: its workflows/prefs/errors/facts
 *   ├── patterns/
 *   │   ├── workflows.md
 *   │   ├── errors.md
 *   │   └── preferences.md
 *   └── archive/deprecated.md     # rejected patterns + superseded facts
 *
 * buildMemFS is pure (returns { path: content }); generateMemFS does the I/O.
 */

import fs from "fs";
import path from "path";
import { decoratePatterns, knowledgeTier } from "./common.js";
import { shortHash } from "./helpers.js";
import { normalizeScope } from "./scope.js";
import { isActiveFact } from "./temporal.js";

// A stable fingerprint of the memory state MemFS was rendered from. doctor
// compares this against the live patterns to detect a stale view.
export function fingerprintPatterns(patterns = [], facts = []) {
  const pat = (patterns || []).map((p) => `${p.id}:${p.status || "pending"}:${Math.round(Number(p.score) || 0)}`).sort();
  const fct = (facts || []).map((f) => `${f.id}:${f.supersededBy ? "x" : "a"}`).sort();
  return shortHash(JSON.stringify([pat, fct]));
}

const mdList = (items, fmt) => (items.length ? items.map(fmt).join("\n") : "_（暂无）_");

function evidenceTag(p) {
  const n = Array.isArray(p.evidence) ? p.evidence.length : 0;
  return n ? ` · 证据×${n}` : "";
}

function prefText(p) {
  return (p.fix && !p.fix.startsWith("User correction:")) ? p.fix : String(p.desc || "").replace(/^User correction: /, "");
}

/**
 * Render the full MemFS tree from memory state. Pure — returns a
 * { relativePath: markdownContent } map plus the fingerprint.
 */
export function buildMemFS({ patterns = [], facts = [], config = {} } = {}, { now = Date.now() } = {}) {
  const decorated = decoratePatterns(patterns, config);
  const live = decorated.filter((p) => p.status !== "rejected");
  const projectOf = (p) => normalizeScope(p.scope || p.context).project;

  const workflows = live.filter((p) => p.type === "workflow");
  const errors = live.filter((p) => p.type === "error");
  const preferences = live.filter((p) => p.type === "preference");
  const durablePrefs = preferences.filter((p) => knowledgeTier(p) === "durable" && (p.status === "approved" || p.advisorUpdatedAt));
  const hardConstraints = durablePrefs.filter((p) => p.status === "approved" || normalizeScope(p.scope).global);

  const activeFactList = (facts || []).filter((f) => isActiveFact(f, now));
  const deadFacts = (facts || []).filter((f) => !isActiveFact(f, now));
  const rejected = decorated.filter((p) => p.status === "rejected");

  const header = (title, note) => `# ${title}\n\n> ${note}\n> 由 Runtime Self-Learning 自动生成的只读视图——编辑无效，请用工具操作 patterns.json。\n`;

  const files = {};

  // ── system/ ──
  files["system/user_profile.md"] = [
    header("用户画像 · User Profile", "从长期偏好（durable preference）归纳的用户画像。"),
    "## 长期偏好",
    mdList(durablePrefs, (p) => `- ${prefText(p)}${evidenceTag(p)}`),
    "",
  ].join("\n");

  files["system/hard_constraints.md"] = [
    header("硬约束 · Hard Constraints", "已批准 / 全局的强约束，应优先于运行时提示。"),
    mdList(hardConstraints, (p) => `- ${prefText(p)}  \`[${normalizeScope(p.scope).project}]\``),
    "",
  ].join("\n");

  // project → counts
  const byProject = new Map();
  for (const p of live) {
    const proj = projectOf(p);
    if (!byProject.has(proj)) byProject.set(proj, { workflow: 0, error: 0, preference: 0, usage: 0 });
    const bucket = byProject.get(proj);
    bucket[p.type] = (bucket[p.type] || 0) + 1;
  }
  for (const f of activeFactList) {
    const proj = normalizeScope(f.scope).project;
    if (!byProject.has(proj)) byProject.set(proj, { workflow: 0, error: 0, preference: 0, usage: 0 });
    const bucket = byProject.get(proj);
    bucket.fact = (bucket.fact || 0) + 1;
  }
  files["system/active_projects.md"] = [
    header("活跃项目 · Active Projects", "记忆涉及的项目作用域与各自条目数。"),
    "| 项目 | workflow | error | preference | fact |",
    "|---|---:|---:|---:|---:|",
    ...[...byProject.entries()].sort().map(([proj, b]) =>
      `| ${proj} | ${b.workflow || 0} | ${b.error || 0} | ${b.preference || 0} | ${b.fact || 0} |`),
    "",
  ].join("\n");

  // ── projects/<project>.md (concrete projects only) ──
  const concreteProjects = [...byProject.keys()].filter((proj) => proj && proj !== "general");
  for (const proj of concreteProjects) {
    const inProj = (p) => projectOf(p) === proj;
    const pf = (f) => normalizeScope(f.scope).project === proj;
    files[`projects/${proj}.md`] = [
      header(`项目 · ${proj}`, `作用域 \`${proj}\` 下的全部记忆。`),
      "## 工作流",
      mdList(workflows.filter(inProj), (p) => `- ${p.desc}${p.fix ? ` → ${p.fix}` : ""}`),
      "",
      "## 偏好",
      mdList(preferences.filter(inProj), (p) => `- ${prefText(p)}`),
      "",
      "## 错误模式",
      mdList(errors.filter(inProj), (p) => `- ${p.desc}${p.fix ? ` → ${p.fix}` : ""}`),
      "",
      "## 事实",
      mdList(activeFactList.filter(pf), (f) => `- ${f.subject} ${f.predicate}: ${f.object}  \`conf=${f.confidence ?? "?"}\``),
      "",
    ].join("\n");
  }

  // ── patterns/ (type-organized, all scopes) ──
  files["patterns/workflows.md"] = [
    header("工作流 · Workflows", "跨类别重复工作流（按衰减分排序）。"),
    mdList(workflows, (p) => `- \`[${projectOf(p)}]\` ${p.desc}${p.fix ? ` → ${p.fix}` : ""}  \`score=${p.decayedScore}\``),
    "",
  ].join("\n");
  files["patterns/errors.md"] = [
    header("错误模式 · Errors", "反复出现的错误及处置建议。"),
    mdList(errors, (p) => `- \`[${projectOf(p)}]\` ${p.desc}${p.fix ? ` → ${p.fix}` : ""}`),
    "",
  ].join("\n");
  files["patterns/preferences.md"] = [
    header("偏好 · Preferences", "用户偏好（含未审核 core 级）。"),
    mdList(preferences, (p) => `- \`[${p.knowledgeTier}/${p.status}]\` ${prefText(p)}`),
    "",
  ].join("\n");

  // ── archive/ ──
  files["archive/deprecated.md"] = [
    header("已弃用 · Deprecated", "被拒绝的模式与被覆盖/过期的事实，仅作审计留存。"),
    "## 被拒绝的模式",
    mdList(rejected, (p) => `- \`${p.id}\` ${p.desc}`),
    "",
    "## 失效事实",
    mdList(deadFacts, (f) => `- ${f.subject} ${f.predicate}: ${f.object}${f.supersededBy ? `（被 ${f.supersededBy} 覆盖）` : "（已过期）"}`),
    "",
  ].join("\n");

  return { files, fingerprint: fingerprintPatterns(patterns, facts) };
}

export function memfsDir(learnerDir) {
  return path.join(learnerDir, "memfs");
}

export function readMemFSIndex(learnerDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(memfsDir(learnerDir), ".index.json"), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Regenerate the MemFS tree on disk. Wipes the derived directory first (it is a
 * pure view, so a clean rebuild can't lose source data) and writes an
 * .index.json carrying the fingerprint for staleness detection.
 */
export function generateMemFS(learnerDir, { patterns = [], facts = [], config = {} } = {}, { now = Date.now() } = {}) {
  const root = memfsDir(learnerDir);
  const { files, fingerprint } = buildMemFS({ patterns, facts, config }, { now });

  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  const index = { fingerprint, generatedAt: new Date(now).toISOString(), files: Object.keys(files) };
  fs.writeFileSync(path.join(root, ".index.json"), JSON.stringify(index, null, 2), "utf-8");
  return { root, fingerprint, files: Object.keys(files) };
}
