/**
 * temporal — fact validity and supersession (v1.1).
 *
 * Why (Graphiti/Zep): project memory must model *time*. When the user first says
 * "the model has module A" and later corrects "no, it's B now", we don't delete
 * A — we invalidate it: set A.validTo and mark it superseded by B. Retrieval then
 * naturally stops surfacing A while its history stays auditable. A fact is a
 * (subject, predicate, object) triple with a validity interval.
 */

export function isActiveFact(fact, now = Date.now()) {
  if (!fact) return false;
  if (fact.status === "superseded" || fact.supersededBy) return false;
  const from = fact.validFrom ? Date.parse(fact.validFrom) : -Infinity;
  const to = fact.validTo ? Date.parse(fact.validTo) : Infinity;
  if (Number.isFinite(from) && from > now) return false;   // not yet in effect
  if (Number.isFinite(to) && to <= now) return false;      // already expired
  return true;
}

export function activeFacts(facts, now = Date.now()) {
  return (facts || []).filter((f) => isActiveFact(f, now));
}

// Two active facts conflict when they share subject+predicate (within the same
// project scope) but assert different objects.
function conflictKey(fact) {
  const project = fact.scope?.project || "general";
  return `${project}||${fact.subject}||${fact.predicate}`;
}

export function factConflicts(facts, now = Date.now()) {
  const groups = new Map();
  for (const f of activeFacts(facts, now)) {
    const key = conflictKey(f);
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(String(f.object), f.id);
  }
  const out = [];
  for (const [key, objects] of groups) {
    if (objects.size > 1) out.push({ key, objects: [...objects.keys()], ids: [...objects.values()] });
  }
  return out;
}

// Mark `oldFact` as superseded by `newFact` (mutates oldFact).
export function supersedeFact(oldFact, newFact) {
  oldFact.status = "superseded";
  oldFact.supersededBy = newFact.id;
  // Close the validity interval at the moment the new fact takes effect.
  if (!oldFact.validTo) oldFact.validTo = newFact.validFrom || new Date().toISOString();
  newFact.supersedes = [...new Set([...(newFact.supersedes || []), oldFact.id])];
  return oldFact;
}

/**
 * Insert `incoming` into `facts`, auto-superseding any active fact with the same
 * subject+predicate+project but a different object. Same-object re-assertions
 * refresh evidence/confidence instead of creating a duplicate.
 *
 * @returns {{ facts: Array, superseded: string[], fact: object, action: string }}
 */
export function applyFact(facts, incoming, { now = Date.now() } = {}) {
  const list = Array.isArray(facts) ? [...facts] : [];
  incoming.validFrom = incoming.validFrom || new Date(now).toISOString();
  if (incoming.validTo === undefined) incoming.validTo = null;

  const key = conflictKey(incoming);
  const superseded = [];

  for (const f of list) {
    if (!isActiveFact(f, now)) continue;
    if (conflictKey(f) !== key) continue;
    if (String(f.object) === String(incoming.object)) {
      // Same assertion restated — keep the existing fact, just refresh it.
      f.validFrom = f.validFrom || incoming.validFrom;
      if (typeof incoming.confidence === "number") f.confidence = Math.max(f.confidence || 0, incoming.confidence);
      if (Array.isArray(incoming.evidence)) f.evidence = [...(f.evidence || []), ...incoming.evidence].slice(-5);
      return { facts: list, superseded, fact: f, action: "refreshed" };
    }
    supersedeFact(f, incoming);
    superseded.push(f.id);
  }

  list.push(incoming);
  return { facts: list, superseded, fact: incoming, action: "added" };
}
