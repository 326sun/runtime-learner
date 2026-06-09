// Tests for lib/embeddings.js (optional semantic layer) and the RRF fusion path
// in runSearch. No network: embedTexts is driven by an injected fetch + cache.

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  cosineSim,
  normalizeEmbeddingUrl,
  resolveSemanticConfig,
  embedTexts,
} from "../lib/embeddings.js";
import { runSearch } from "../tools/search.js";

describe("embeddings · cosineSim", () => {
  it("is 1 for identical, 0 for orthogonal, 0 for bad input", () => {
    assert.equal(cosineSim([1, 0], [1, 0]), 1);
    assert.equal(cosineSim([1, 0], [0, 1]), 0);
    assert.equal(cosineSim([1, 2, 3], [2, 4, 6]).toFixed(5), "1.00000");
    assert.equal(cosineSim([1], [1, 2]), 0);
    assert.equal(cosineSim([], []), 0);
  });
});

describe("embeddings · url + config resolution", () => {
  it("normalizes embedding URLs", () => {
    assert.equal(normalizeEmbeddingUrl("http://x"), "http://x/v1/embeddings");
    assert.equal(normalizeEmbeddingUrl("http://x/v1"), "http://x/v1/embeddings");
    assert.equal(normalizeEmbeddingUrl("http://x/v1/embeddings"), "http://x/v1/embeddings");
    assert.equal(normalizeEmbeddingUrl(""), "");
  });

  it("resolveSemanticConfig gates on enable + endpoint + model", () => {
    assert.equal(resolveSemanticConfig({ semanticSearchEnabled: false }).ok, false);
    assert.equal(resolveSemanticConfig({ semanticSearchEnabled: true }).reason, "no endpoint");
    assert.equal(resolveSemanticConfig({ semanticSearchEnabled: true, semanticEmbeddingBaseUrl: "http://x" }).reason, "no model");
    const ok = resolveSemanticConfig({ semanticSearchEnabled: true, semanticEmbeddingBaseUrl: "http://x", semanticEmbeddingModel: "m" });
    assert.equal(ok.ok, true);
    assert.equal(ok.url, "http://x/v1/embeddings");
  });
});

describe("embeddings · embedTexts (mocked)", () => {
  const config = { semanticSearchEnabled: true, semanticEmbeddingBaseUrl: "http://x", semanticEmbeddingModel: "m" };
  const fakeFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ data: body.input.map((t) => ({ embedding: [t.length, 1, 0] })) }) };
  };

  it("returns vectors, caches them, and skips the fetch on a full cache hit", async () => {
    const cache = {};
    const r1 = await embedTexts(["aa", "bbb"], config, { fetchImpl: fakeFetch, cache });
    assert.equal(r1.ok, true);
    assert.equal(r1.vectors.length, 2);
    assert.equal(Object.keys(cache).length, 2);

    let calls = 0;
    const countingFetch = async () => { calls++; return { ok: true, json: async () => ({ data: [] }) }; };
    const r2 = await embedTexts(["aa", "bbb"], config, { fetchImpl: countingFetch, cache });
    assert.equal(r2.ok, true);
    assert.equal(calls, 0, "all cache hits → no fetch");
  });

  it("degrades (ok:false) when disabled or on HTTP error — never throws", async () => {
    assert.equal((await embedTexts(["x"], { semanticSearchEnabled: false })).ok, false);
    const errFetch = async () => ({ ok: false, status: 500 });
    const r = await embedTexts(["x"], config, { fetchImpl: errFetch, cache: {} });
    assert.equal(r.ok, false);
    assert.match(r.reason, /http 500/);
  });
});

describe("runSearch · RRF semantic fusion", () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
  // A: strong BM25 (term twice), weak memoryStrength.
  // B: weaker BM25 (term once), strong memoryStrength.
  // BM25 favors A, memoryStrength favors B — so the semantic signal is the
  // tie-breaking third ranker and decides the top result.
  const PATS = [
    { id: "wf:a", type: "workflow", status: "approved", score: 5, count: 2, lastSeen: old,
      scope: { project: "general", taskType: "general" }, desc: "signal signal" },
    { id: "wf:b", type: "workflow", status: "approved", score: 20, count: 5, lastSeen: now,
      scope: { project: "general", taskType: "general" }, desc: "signal" },
  ];
  const ids = (r) => r.results.map((x) => x.id);

  it("weighted (no semantic) path is unchanged — no fused breakdown", () => {
    const r = runSearch(PATS, "signal", { limit: 5 });
    assert.equal(r.results[0].scoreBreakdown.fused, undefined);
    assert.equal(r.results.length, 2);
  });

  it("semantic direction decides the top result under RRF", () => {
    const favA = runSearch(PATS, "signal", { limit: 5, semantic: { "wf:a": 0.95, "wf:b": 0.05 } });
    const favB = runSearch(PATS, "signal", { limit: 5, semantic: { "wf:a": 0.05, "wf:b": 0.95 } });
    assert.equal(ids(favA)[0], "wf:a");
    assert.equal(ids(favB)[0], "wf:b");
    // fused breakdown is populated when semantic is active
    assert.ok(typeof favA.results[0].scoreBreakdown.fused === "number");
    assert.ok(typeof favA.results[0].scoreBreakdown.semantic === "number");
  });
});
