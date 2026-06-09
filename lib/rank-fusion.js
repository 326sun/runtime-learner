/**
 * rank-fusion — Reciprocal Rank Fusion (v1.3).
 *
 * Combines several independently-ranked id lists (BM25, semantic, relation,
 * memory-strength) into one ranking without needing the scores to be on the same
 * scale. RRF only looks at each item's *position* in each list:
 *
 *     score(id) = Σ_lists 1 / (k + rank_in_list)      (rank is 1-based)
 *
 * k (default 60) damps the contribution of low ranks. An item ranked highly by
 * any one signal still scores well, but agreement across signals wins — which is
 * exactly what we want when BM25 and a semantic model disagree.
 */

// Order items best-first by a score function, dropping non-finite scores.
export function rankByScore(items, scoreFn) {
  return [...items]
    .map((it) => ({ id: it.id ?? it, s: scoreFn(it) }))
    .filter((x) => Number.isFinite(x.s) && x.id != null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.id);
}

/**
 * @param {Array<Array<string>>} rankedLists  each best-first ordered list of ids
 * @returns {Map<string, number>} id → fused score
 */
export function rrfScores(rankedLists, { k = 60 } = {}) {
  const scores = new Map();
  for (const list of rankedLists) {
    if (!Array.isArray(list)) continue;
    list.forEach((id, idx) => {
      if (id == null) return;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1));
    });
  }
  return scores;
}

// Convenience: fused, descending [{ id, score }].
export function fuse(rankedLists, opts = {}) {
  return [...rrfScores(rankedLists, opts).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}
