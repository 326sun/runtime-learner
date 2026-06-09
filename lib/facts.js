/**
 * facts — the time-aware fact store (v1.1). Persists (subject, predicate,
 * object) triples with validity intervals in facts.json, and adapts active facts
 * into the memory-item shape the retrieval index + gate already understand, so
 * superseded/expired facts are filtered by the same admission rules as patterns.
 */

import path from "path";
import { readJson, writeJson } from "./common.js";
import { stableKey } from "./helpers.js";
import { applyFact, isActiveFact } from "./temporal.js";
import { normalizeScope } from "./scope.js";

export function factsPath(dir) {
  return path.join(dir, "facts.json");
}

export function loadFacts(dir) {
  return readJson(factsPath(dir), []) || [];
}

export function saveFacts(dir, facts) {
  writeJson(factsPath(dir), facts);
}

export function makeFactId({ subject, predicate, object, scope } = {}) {
  const project = scope?.project || "general";
  return `fact:${stableKey(project)}:${stableKey(subject)}:${stableKey(predicate)}:${stableKey(object)}`;
}

/**
 * Normalize loose input into a v1.1 fact record (no persistence).
 */
export function makeFact(input = {}, { now = Date.now() } = {}) {
  const scope = normalizeScope(input.scope);
  const fact = {
    schemaVersion: 1,
    id: input.id || makeFactId({ ...input, scope }),
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    scope: { project: scope.project, taskType: scope.taskType, source: input.scope?.source || input.source || "runtime" },
    validFrom: input.validFrom || new Date(now).toISOString(),
    validTo: input.validTo ?? null,
    supersedes: input.supersedes || [],
    contradicts: input.contradicts || [],
    confidence: typeof input.confidence === "number" ? input.confidence : 0.8,
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
  };
  return fact;
}

/**
 * Record a fact to disk, auto-superseding conflicting active facts.
 * @returns {{ fact, superseded: string[], action: string }}
 */
export function recordFact(dir, input, { now = Date.now() } = {}) {
  const facts = loadFacts(dir);
  const incoming = makeFact(input, { now });
  const { facts: next, superseded, fact, action } = applyFact(facts, incoming, { now });
  saveFacts(dir, next);
  return { fact, superseded, action };
}

/**
 * Adapt a fact into a retrieval memory-item. Validity/supersession are mapped
 * onto the fields the gate inspects (scope.validTo, supersededBy) so an inactive
 * fact is rejected by admitMemory exactly like an inactive pattern.
 */
export function factToMemoryItem(fact) {
  return {
    id: fact.id,
    type: "fact",
    knowledgeTier: "core",
    status: fact.supersededBy ? "superseded" : "active",
    desc: `${fact.subject} ${fact.predicate}: ${fact.object}`,
    fix: `${fact.subject} 的 ${fact.predicate} 当前为 ${fact.object}。`,
    scope: { project: fact.scope?.project || "general", taskType: fact.scope?.taskType || "general", validTo: fact.validTo },
    supersededBy: fact.supersededBy || null,
    confidence: fact.confidence,
    evidence: fact.evidence || [],
    count: 1,
    score: Math.round((fact.confidence || 0.8) * 15),
  };
}

// All facts as memory items (active + inactive). The gate drops the inactive
// ones; callers that only want live facts can pre-filter with isActiveFact.
export function factMemoryItems(dir, { activeOnly = false, now = Date.now() } = {}) {
  const facts = loadFacts(dir);
  const chosen = activeOnly ? facts.filter((f) => isActiveFact(f, now)) : facts;
  return chosen.map(factToMemoryItem);
}
