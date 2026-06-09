import path from "path";
import { readJson, memoryStrength, learnerDir as resolveLearnerDir, DEFAULT_CONFIG, knowledgeTier } from "../lib/common.js";
import { defineTool } from "../lib/hana-runtime-compat.js";
import { searchOfficialMemory } from "../lib/official-memory-bridge.js";
import { MemoryIndex, tokenizeText, defaultDocText } from "../lib/memory-index.js";
import { admitMemory } from "../lib/memory-gate.js";
import { inferScope, normalizeScope } from "../lib/scope.js";
import { previewEvidence } from "../lib/evidence.js";
import { factMemoryItems } from "../lib/facts.js";
import { rrfScores } from "../lib/rank-fusion.js";
import { resolveSemanticConfig, embedTexts, cosineSim } from "../lib/embeddings.js";

const PATTERNS_FILE = path.join(resolveLearnerDir(), "patterns.json");
const CONFIG_FILE = path.join(resolveLearnerDir(), "config.json");

// Cross-language synonym table for mixed CN/EN search expansion. Applied on top
// of the index's CJK bigram tokenization to bridge terms that share no
// characters (e.g. "coding" ↔ "代码").
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

// Tokenize the query (CJK-aware) and fold in cross-language synonyms. We expand
// on whitespace-split words first so multi-word EN phrases still hit the table.
export function expandQueryTokens(query) {
  const base = tokenizeText(query);
  const expanded = new Set(base);
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  for (const w of [...words, ...base]) {
    const syns = SYNONYMS[w];
    if (syns) for (const s of syns) for (const t of tokenizeText(s)) expanded.add(t);
  }
  return [...expanded];
}

function matchesTaskFilter(pattern, taskFilter) {
  if (!taskFilter) return true;
  const raw = pattern.scope?.taskType || pattern.context?.taskType || "";
  return String(raw).split(",").map((item) => item.trim()).includes(taskFilter);
}

function relationBoost(pattern, byId) {
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

/**
 * Core retrieval pipeline, separated from the tool wrapper so tests (and the
 * retrieval eval) can drive it directly with in-memory patterns:
 *   tokens → BM25 top-K → memory-gate → relation+strength rerank → low-conf reject
 */
export function runSearch(allPatterns, query, { config = DEFAULT_CONFIG, type = null, taskType = null, project = null, limit = 5, semantic = null } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const byId = new Map(allPatterns.map((p) => [p.id, p]));
  const tokens = expandQueryTokens(query);
  const queryScope = inferScope({ taskType, userText: query, project });

  // Pre-filter only on the user's explicit, hard filters (type / taskType).
  const prefiltered = allPatterns.filter((p) => {
    if (type && p.type !== type) return false;
    if (!matchesTaskFilter(p, taskType)) return false;
    return true;
  });

  if (!tokens.length) return { results: [], queryScope };

  // 1) BM25 candidate generation.
  const candidateLimit = Math.max(limit, Number(cfg.retrievalCandidateLimit || 20));
  const index = new MemoryIndex().rebuild(prefiltered);
  const bm25Hits = index.search(tokens, { limit: candidateLimit });
  if (!bm25Hits.length) return { results: [], queryScope };

  const topBm25 = bm25Hits[0].bm25 || 0;
  const relFloor = topBm25 * Number(cfg.minRetrievalRelative ?? 0.15);

  // "Strong" query tokens: ASCII words (len ≥ 2) and CJK bigrams. A candidate
  // matching ONLY single CJK unigrams is an incidental coincidence (e.g. "乱码"
  // sharing 码 with "代码"), not a real hit — those are rejected for precision
  // while bigram recall (排版 → 论文排版) is preserved.
  const strongQ = new Set(tokens.filter((t) => t.length >= 2));

  // 2) Gate + 3) rerank.
  const scored = [];
  for (const hit of bm25Hits) {
    // Low-confidence reject: weak textual tail relative to the best match.
    if (hit.bm25 < relFloor) continue;
    const p = hit.item;
    if (strongQ.size) {
      const docToks = new Set(tokenizeText(defaultDocText(p)));
      let strong = false;
      for (const t of strongQ) if (docToks.has(t)) { strong = true; break; }
      if (!strong) continue;
    }
    const gate = admitMemory(p, { scope: queryScope }, cfg);
    if (!gate.admitted) continue;

    const relation = relationBoost(p, byId);
    const memStr = memoryStrength(p, cfg);
    const pScope = normalizeScope(p.scope || p.context);
    // Bonus for a concrete same-project match (general scopes get nothing extra).
    const scopeBonus = pScope.project !== "general" && pScope.project === queryScope.project ? 0.5 : 0;
    const breakdown = {
      bm25: Number(hit.bm25.toFixed(3)),
      relation: Number(relation.toFixed(3)),
      memoryStrength: Number((Math.log1p(memStr) * 0.5).toFixed(3)),
      scope: Number((scopeBonus - (gate.penalty || 0)).toFixed(3)),
    };
    const composite = breakdown.bm25 + breakdown.relation + breakdown.memoryStrength + breakdown.scope;
    scored.push({ p, gate, breakdown, composite: Number(composite.toFixed(3)), memStr });
  }

  // Optional semantic fusion (v1.3): when a semantic similarity map is supplied
  // (id → cosine), fuse BM25 / semantic / relation / memoryStrength rankings via
  // RRF. Without it, ranking stays the dependency-free weighted composite above,
  // so default behavior — and the retrieval eval — is unchanged.
  const semMap = semantic instanceof Map ? semantic : (semantic ? new Map(Object.entries(semantic)) : null);
  if (semMap && semMap.size > 0) {
    const rankBy = (scoreOf, positiveOnly = false) => scored
      .map((s) => ({ id: s.p.id, v: scoreOf(s) }))
      .filter((x) => Number.isFinite(x.v) && (!positiveOnly || x.v > 0))
      .sort((a, b) => b.v - a.v)
      .map((x) => x.id);
    const lists = [
      rankBy((s) => s.breakdown.bm25),
      rankBy((s) => (semMap.has(s.p.id) ? semMap.get(s.p.id) : NaN)),
      rankBy((s) => s.breakdown.relation, true),
      rankBy((s) => s.memStr),
    ];
    const fused = rrfScores(lists, { k: Number(cfg.rrfK) || 60 });
    for (const s of scored) {
      s.breakdown.semantic = semMap.has(s.p.id) ? Number(semMap.get(s.p.id).toFixed(3)) : 0;
      s.breakdown.fused = Number((fused.get(s.p.id) || 0).toFixed(4));
      // scope term as a tiny tie-break so same-project / cross-task ordering holds.
      s.composite = Number((s.breakdown.fused + s.breakdown.scope * 0.0001).toFixed(4));
    }
  }

  scored.sort((a, b) => b.composite - a.composite);

  const results = scored.slice(0, limit).map(({ p, gate, breakdown, composite, memStr }) => ({
    id: p.id,
    type: p.type,
    knowledgeTier: knowledgeTier(p),
    scope: normalizeScope(p.scope || p.context),
    desc: p.desc,
    fix: p.fix || null,
    context: p.context ? { taskType: p.context.taskType, categories: p.context.categories } : null,
    evidencePreview: previewEvidence(p),
    gateReason: gate.reason,
    count: p.count,
    score: p.score,
    memoryStrength: Number(memStr.toFixed(1)),
    status: p.status,
    scoreBreakdown: breakdown,
    _score: composite,
  }));

  return { results, queryScope };
}

const tool = defineTool({
  name: "self_learning_search",
  description: "Search learned patterns by keyword, type, context, or task category. Scope-aware retrieval: CJK-aware BM25 + memory gate (rejects cross-project / expired / superseded / low-confidence) + relation & memory-strength rerank.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords (e.g. 'coding', 'preference', 'web search workflow', 'paper writing')" },
      type: { type: "string", description: "Filter by pattern type: workflow, preference, error, or all (default)" },
      taskType: { type: "string", description: "Filter by task context: file_management, coding, research, planning, or general" },
      project: { type: "string", description: "Scope the search to a project. Cross-project memories are blocked unless global." },
      limit: { type: "number", description: "Maximum results, default 5" },
    },
    required: ["query"],
  },
  async execute(input = {}) {
    const query = input.query || "";
    const typeFilter = input.type || null;
    const taskFilter = input.taskType || null;
    const projectFilter = input.project || null;
    const limit = Math.min(input.limit || 5, 10);

    const patterns = (readJson(PATTERNS_FILE, []) || []).filter((p) => p && p.id);
    // Merge time-aware facts as retrieval candidates. Superseded/expired facts
    // are carried in but rejected by the gate (status/validTo), so the old value
    // of a corrected fact never resurfaces.
    const factItems = factMemoryItems(resolveLearnerDir());
    const allPatterns = [...patterns, ...factItems];
    const config = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const officialMemory = config.officialMemoryBridgeEnabled
      ? searchOfficialMemory(query, { limit: Math.max(0, Math.min(Number(config.officialMemoryBridgeMaxResults || 3), 10)) })
      : [];

    // Optional semantic pass (v1.3). Only when enabled + endpoint configured;
    // any failure (network/timeout) leaves `semantic` null → weighted BM25.
    let semantic = null;
    let semanticUsed = false;
    if (resolveSemanticConfig(config).ok) {
      try {
        const probe = runSearch(allPatterns, query, {
          config, type: typeFilter, taskType: taskFilter, project: projectFilter,
          limit: Math.max(limit, Number(config.semanticTopK) || 50),
        }).results;
        if (probe.length) {
          const emb = await embedTexts([query, ...probe.map((r) => `${r.desc} ${r.fix || ""}`)], config);
          if (emb.ok && Array.isArray(emb.vectors[0])) {
            const qv = emb.vectors[0];
            semantic = new Map();
            probe.forEach((r, i) => {
              const v = emb.vectors[i + 1];
              if (Array.isArray(v)) semantic.set(r.id, cosineSim(qv, v));
            });
            semanticUsed = semantic.size > 0;
          }
        }
      } catch { /* degrade to weighted */ }
    }

    const { results, queryScope } = runSearch(allPatterns, query, {
      config,
      type: typeFilter,
      taskType: taskFilter,
      project: projectFilter,
      limit,
      semantic,
    });

    if (!results.length) {
      return JSON.stringify({
        ok: true,
        query,
        queryScope,
        count: 0,
        results: [],
        officialMemory,
        hint: "No matching patterns admitted. Try broader keywords, a different taskType/project filter, or check self_learning_stats for an overview.",
      }, null, 2);
    }

    return JSON.stringify({
      ok: true,
      query,
      queryScope,
      count: results.length,
      strategy: semanticUsed
        ? "rrf(bm25 + semantic + relation + memoryStrength) + gate"
        : "bm25(cjk) + gate + relation + memoryStrength",
      results,
      officialMemory,
    }, null, 2);
  },
});

export const { name, description, parameters, execute } = tool;
