import fs from "fs";
import path from "path";
import { readJson, memoryStrength, learnerDir as resolveLearnerDir, DEFAULT_CONFIG, knowledgeTier } from "../lib/common.js";
import { defineTool } from "../lib/hana-runtime-compat.js";
import { searchOfficialMemory } from "../lib/official-memory-bridge.js";

const PATTERNS_FILE = path.join(resolveLearnerDir(), "patterns.json");
const CONFIG_FILE = path.join(resolveLearnerDir(), "config.json");

// Cross-language synonym table for mixed CN/EN search expansion
const SYNONYMS = {
  coding: ["代码", "编写", "code", "编程"],
  code: ["代码", "编写", "coding", "编程"],
  "代码": ["coding", "code", "编写", "编程"],
  "编写": ["coding", "code", "代码"],
  preference: ["偏好", "设定", "pref", "设置"],
  "偏好": ["preference", "pref", "设定", "设置"],
  workflow: ["工作流", "流程"],
  "工作流": ["workflow", "流程"],
  error: ["错误", "报错", "异常"],
  "错误": ["error", "报错", "异常"],
  research: ["研究", "搜索", "调研"],
  "研究": ["research", "搜索", "调研"],
  search: ["搜索", "查找", "检索"],
  "搜索": ["search", "查找", "检索"],
  file: ["文件", "文档"],
  "文件": ["file", "文档"],
  memory: ["记忆", "记住"],
  "记忆": ["memory", "记住"],
  usage: ["用量", "消耗", "token"],
  "用量": ["usage", "消耗", "token"],
};

function tokenize(query) {
  const raw = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  // Expand with synonyms (deduplicated)
  const expanded = new Set(raw);
  for (const token of raw) {
    const syns = SYNONYMS[token];
    if (syns) for (const s of syns) expanded.add(s);
  }
  return [...expanded];
}

function textScore(pattern, tokens) {
  if (!tokens.length) return 0;
  const haystack = `${pattern.id} ${pattern.desc} ${pattern.fix || ""} ${pattern.type || ""}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
    if (pattern.id.toLowerCase().includes(token)) score += 2;
  }
  return score;
}

function contextScore(pattern, tokens) {
  if (!tokens.length || !pattern.context) return 0;
  const ctx = pattern.context;
  const haystack = `${ctx.taskType || ""} ${(ctx.categories || []).join(" ")} ${(ctx.tools || []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1.5;
  }
  return score;
}

function matchesTaskFilter(pattern, taskFilter) {
  if (!taskFilter) return true;
  const raw = pattern.context?.taskType || "";
  return String(raw).split(",").map((item) => item.trim()).includes(taskFilter);
}

function relationBoost(pattern, byId) {
  // Use only explicit relation edges — no O(n²) category overlap scan. Targets
  // are resolved via a prebuilt id→pattern Map (O(1)) rather than a linear scan
  // per edge, so scoring stays O(candidates × edges) instead of × patterns.
  const rels = pattern.context?.relations || [];
  if (!rels.length) return 0;
  let boost = 0;
  for (const rel of rels) {
    const target = byId.get(rel.targetId);
    if (target && target.status !== "rejected") {
      boost += (rel.weight || 0.2) * Math.min(1, (target.score || 0) / 15);
    }
  }
  return Math.min(boost, 5);
}

const tool = defineTool({
  name: "self_learning_search",
  description: "Search learned patterns by keyword, type, context, or task category. Uses multi-strategy retrieval: text match + context match + relation boost.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords (e.g. 'coding', 'preference', 'web search workflow', 'paper writing')" },
      type: { type: "string", description: "Filter by pattern type: workflow, preference, error, or all (default)" },
      taskType: { type: "string", description: "Filter by task context: file_management, coding, research, planning, or general" },
      limit: { type: "number", description: "Maximum results, default 5" },
    },
    required: ["query"],
  },
  async execute(input = {}) {
    const query = input.query || "";
    const typeFilter = input.type || null;
    const taskFilter = input.taskType || null;
    const limit = Math.min(input.limit || 5, 10);

    const allPatterns = readJson(PATTERNS_FILE, []);
      const byId = new Map(allPatterns.map(p => [p.id, p]));
      const config = readJson(CONFIG_FILE, DEFAULT_CONFIG);
      const tokens = tokenize(query);
      const officialMemory = config.officialMemoryBridgeEnabled
        ? searchOfficialMemory(query, { limit: Math.max(0, Math.min(Number(config.officialMemoryBridgeMaxResults || 3), 10)) })
        : [];

    let candidates = allPatterns.filter(p => {
      if (p.status === "rejected") return false;
      if (knowledgeTier(p) === "ephemeral") return false;
      if (typeFilter && p.type !== typeFilter) return false;
      if (!matchesTaskFilter(p, taskFilter)) return false;
      return true;
    });

    // Multi-strategy scoring
    const scored = candidates.map(p => {
      const tScore = textScore(p, tokens);
      const cScore = contextScore(p, tokens);
      const rBoost = relationBoost(p, byId);
      const memStr = memoryStrength(p, config);
      // Composite: text (×1.0) + context (×1.2) + relation boost + memory freshness
      const composite = tScore + cScore * 1.2 + rBoost + Math.log1p(memStr) * 0.5;
      return { ...p, _score: Number(composite.toFixed(2)) };
    });

    // Filter: require at least some text match or very high context match
    let results = scored
      .filter(p => tokens.length === 0 || textScore(p, tokens) > 0 || contextScore(p, tokens) >= 2)
      .sort((a, b) => b._score - a._score)
      .slice(0, limit)
      .map(p => ({
        id: p.id,
        type: p.type,
        knowledgeTier: knowledgeTier(p),
        desc: p.desc,
        fix: p.fix || null,
        context: p.context ? { taskType: p.context.taskType, categories: p.context.categories } : null,
        count: p.count,
        score: p.score,
        memoryStrength: Number(memoryStrength(p, config).toFixed(1)),
        status: p.status,
        _score: p._score,
      }));

    if (!results.length) {
        return JSON.stringify({
          ok: true,
          query,
          count: 0,
          results: [],
          officialMemory,
          hint: "No matching patterns. Try broader keywords, different taskType filter, or check self_learning_stats for an overview.",
        }, null, 2);
      }

      return JSON.stringify({
        ok: true,
        query,
        count: results.length,
        strategy: "text + context + relation + memory",
        results,
        officialMemory,
      }, null, 2);
  },
});

export const { name, description, parameters, execute } = tool;
