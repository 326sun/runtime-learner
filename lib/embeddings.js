/**
 * embeddings — optional semantic vectors for retrieval (v1.3).
 *
 * OFF by default and dependency-free at rest. When the user enables semantic
 * search AND configures an OpenAI-compatible /embeddings endpoint, this fetches
 * vectors for query + candidate texts, caches them on disk by content hash, and
 * exposes cosine similarity. With it off (or no endpoint, or a network failure)
 * every entry point degrades gracefully to "no semantic signal" so retrieval
 * keeps working on BM25 alone.
 *
 * Privacy: enabling this sends memory text to your endpoint — disclosed in
 * README · 隐私, same posture as the model advisor.
 */

import path from "path";
import { readJson, writeJson, learnerDir } from "./common.js";
import { shortHash } from "./helpers.js";

export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function normalizeEmbeddingUrl(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.endsWith("/embeddings")) return raw;
  if (raw.endsWith("/v1")) return `${raw}/embeddings`;
  return `${raw}/v1/embeddings`;
}

export function resolveSemanticConfig(config = {}) {
  if (!config.semanticSearchEnabled) return { ok: false, reason: "disabled" };
  const url = normalizeEmbeddingUrl(config.semanticEmbeddingBaseUrl);
  const model = String(config.semanticEmbeddingModel || "").trim();
  if (!url) return { ok: false, reason: "no endpoint" };
  if (!model) return { ok: false, reason: "no model" };
  return { ok: true, url, model, apiKey: String(config.semanticEmbeddingApiKey || "") };
}

const defaultCacheFile = () => path.join(learnerDir(), "embeddings_cache.json");
export function loadEmbedCache(file = defaultCacheFile()) { return readJson(file, {}) || {}; }
export function saveEmbedCache(cache, file = defaultCacheFile()) { writeJson(file, cache); }
export function cacheKey(model, text) { return `${model}:${shortHash(text)}`; }

/**
 * Embed `texts`, using the disk cache for hits and one batched request for
 * misses. Returns { ok, vectors, reason } where vectors[i] aligns with texts[i]
 * (a miss left undefined on failure). Never throws.
 *
 * Injectable deps (`fetchImpl`, `cache`, `cacheFile`) keep this unit-testable
 * without network or touching the real cache file.
 */
export async function embedTexts(texts, config, { fetchImpl, cache, cacheFile, timeoutMs = 15000 } = {}) {
  const resolved = resolveSemanticConfig(config);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, vectors: [] };
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { ok: false, reason: "no fetch", vectors: [] };

  const store = cache || loadEmbedCache(cacheFile || defaultCacheFile());
  const vectors = new Array(texts.length);
  const missIdx = [];
  const missText = [];
  texts.forEach((t, i) => {
    const hit = store[cacheKey(resolved.model, t)];
    if (hit) vectors[i] = hit;
    else { missIdx.push(i); missText.push(t); }
  });

  if (missText.length) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(resolved.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}) },
        body: JSON.stringify({ model: resolved.model, input: missText }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: `http ${res.status}`, vectors };
      const json = await res.json();
      const data = json?.data || [];
      missIdx.forEach((orig, j) => {
        const vec = data[j]?.embedding;
        if (Array.isArray(vec)) {
          vectors[orig] = vec;
          store[cacheKey(resolved.model, texts[orig])] = vec;
        }
      });
      if (!cache) saveEmbedCache(store, cacheFile || defaultCacheFile());
    } catch (e) {
      return { ok: false, reason: e?.name === "AbortError" ? "timeout" : (e?.message || "error"), vectors };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, vectors };
}
