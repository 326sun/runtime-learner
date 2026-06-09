/**
 * memory-gate — admission control for retrieved memories (v0.9).
 *
 * Core principle (from MemGate): semantic similarity is NOT a license to inject.
 * Retrieval is a safety boundary. A candidate that ranks high on BM25 can still
 * be wrong to surface — it may be rejected, expired, superseded, from another
 * project, or below the confidence floor. The gate turns those into explicit,
 * auditable decisions instead of silent ranking nudges.
 *
 * Returns { admitted, reason, penalty }:
 *   - admitted=false → drop the candidate, `reason` says why.
 *   - admitted=true  → keep it; `penalty` ≥ 0 is a soft down-weight the caller
 *                      subtracts during reranking (e.g. cross-taskType recall).
 */

import { knowledgeTier } from "./common.js";
import { scopeMatches, taskTypeMatches, isCrossScopeAllowed } from "./scope.js";

export function isExpired(item, now = Date.now()) {
  const validTo = item?.scope?.validTo ?? item?.validTo;
  if (!validTo) return false;
  const t = Date.parse(validTo);
  return Number.isFinite(t) && t < now;
}

export function isSuperseded(item) {
  // v1.1 temporal fields; absent in v0.9 patterns, so this is a no-op until then.
  if (item?.supersededBy) return true;
  if (Array.isArray(item?.supersededByIds) && item.supersededByIds.length) return true;
  if (item?.status === "superseded") return true;
  return false;
}

const DEFAULT_CROSS_TASK_PENALTY = 1.0;

/**
 * @param {object} candidate  a pattern (or fact) being considered
 * @param {object} queryContext { scope?: {project,taskType}, ... }
 * @param {object} config      runtime config (reads minRetrievalConfidence)
 */
/**
 * Admit or reject a memory candidate for retrieval. Applies hard gates
 * (rejected, ephemeral, expired, superseded, cross-project) and soft
 * penalties (cross-taskType down-weight, confidence floor).
 *
 * @param {object} candidate — a pattern or fact memory item
 * @param {object} queryContext — { scope: { project, taskType } }
 * @param {object} config — { minRetrievalConfidence, crossTaskPenalty }
 * @returns {{ admitted: boolean, reason: string, penalty?: number }}
 */
export function admitMemory(candidate, queryContext = {}, config = {}) {
  if (!candidate || !candidate.id) return { admitted: false, reason: "empty" };

  if (candidate.status === "rejected") return { admitted: false, reason: "rejected" };
  if (knowledgeTier(candidate) === "ephemeral") return { admitted: false, reason: "ephemeral tier" };
  if (isExpired(candidate)) return { admitted: false, reason: "expired" };
  if (isSuperseded(candidate)) return { admitted: false, reason: "superseded" };

  const queryScope = queryContext.scope || queryContext || {};
  const candidateScope = candidate.scope || candidate.context || {};

  const projectOk = scopeMatches(candidateScope, queryScope) || isCrossScopeAllowed(candidate, queryScope);
  if (!projectOk) return { admitted: false, reason: "cross-project memory blocked" };

  // Confidence floor (facts carry an explicit confidence; patterns usually don't).
  const minConf = Number(config.minRetrievalConfidence ?? 0);
  if (minConf > 0 && typeof candidate.confidence === "number" && candidate.confidence < minConf) {
    return { admitted: false, reason: `confidence ${candidate.confidence} < ${minConf}` };
  }

  // Soft penalty: cross-taskType recall is allowed but down-weighted, so a
  // same-task memory outranks an off-task one of equal textual relevance.
  let penalty = 0;
  let reason = "ok";
  if (!taskTypeMatches(candidateScope, queryScope)) {
    penalty = Number(config.crossTaskPenalty ?? DEFAULT_CROSS_TASK_PENALTY);
    reason = "cross-taskType (down-weighted)";
  }

  return { admitted: true, reason, penalty };
}
