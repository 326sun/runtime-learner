import fs from "fs";
import path from "path";
import { readJson, decoratePatterns, memoryStrength, learnerDir as resolveLearnerDir, DEFAULT_CONFIG } from "../lib/common.js";
import { defineTool } from "../lib/hana-runtime-compat.js";

const PATTERNS_FILE = path.join(resolveLearnerDir(), "patterns.json");
const CONFIG_FILE = path.join(resolveLearnerDir(), "config.json");

function tokenize(query) {
  return String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
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

function relationBoost(pattern, allPatterns) {
  // Use explicit relation edges from the knowledge tree
  const rels = pattern.context?.relations || [];
  let boost = 0;
  for (const rel of rels) {
    const target = allPatterns.find(p => p.id === rel.targetId);
    if (target && target.status !== "rejected") {
      boost += (rel.weight || 0.2) * Math.min(1, (target.score || 0) / 15);
    }
  }
  // Also boost from simple category overlap as a baseline
  if (pattern.context?.categories) {
    const cats = new Set(pattern.context.categories);
    for (const other of allPatterns) {
      if (other.id === pattern.id) continue;
      const otherCats = new Set(other.context?.categories || []);
      const overlap = [...cats].filter(c => otherCats.has(c)).length;
      if (overlap > 0) boost += overlap * 0.2 * Math.min(1, (other.score || 0) / 15);
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
    const config = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const tokens = tokenize(query);

    let candidates = allPatterns.filter(p => {
      if (p.status === "rejected") return false;
      if (p.type === "capability" || p.type === "host_capability") return false;
      if (p.id?.startsWith("usage_large")) return false;
      if (typeFilter && p.type !== typeFilter) return false;
      if (taskFilter && (!p.context || p.context.taskType !== taskFilter)) return false;
      return true;
    });

    // Multi-strategy scoring
    const scored = candidates.map(p => {
      const tScore = textScore(p, tokens);
      const cScore = contextScore(p, tokens);
      const rBoost = relationBoost(p, allPatterns);
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
        hint: "No matching patterns. Try broader keywords, different taskType filter, or check self_learning_stats for an overview.",
      }, null, 2);
    }

    return JSON.stringify({
      ok: true,
      query,
      count: results.length,
      strategy: "text + context + relation + memory",
      results,
    }, null, 2);
  },
});

export const { name, description, parameters, execute } = tool;
