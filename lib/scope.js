/**
 * Scope inference and matching for Runtime Self-Learning (v0.9).
 *
 * A "scope" bounds where a memory applies: which project, which task type. The
 * retrieval layer uses it to keep one project's experience from polluting
 * another's. Two deliberate asymmetries (from the plan):
 *   - project mismatch  → hard block (cross-project recall denied by default)
 *   - taskType mismatch → soft penalty (down-weighted, not denied)
 *
 * "general" is the unscoped sentinel: a general-scoped memory matches any query
 * and a general-scoped query matches any memory. Most legacy patterns (written
 * before scope existed) are general, so this keeps them recallable while newly
 * scoped memories gain isolation.
 */

const GENERIC_DIRS = new Set([
  "", "sessions", "session", "tmp", "temp", "cache", "data",
  ".hanako", "hanako", "agents", "agent", "logs", "log", "home", "users", "user",
]);

// A segment directly under one of these is a session/agent id, not a project —
// skip it even when it's a short, non-hex token the id heuristics miss.
const SESSION_CONTAINERS = new Set(["sessions", "session", "agents", "agent"]);

const TASK_DOMAINS = {
  coding: "software",
  file_management: "software",
  research: "research",
  planning: "planning",
  usage: "runtime",
  general: "general",
};

export function slugifyProject(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    // keep ascii word chars, CJK, dot/underscore/hyphen; collapse the rest
    .replace(/[^a-z0-9㐀-䶿一-鿿._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
}

// Derive a stable project slug from a session/workspace path, skipping generic
// container dirs and session-id-ish segments (hashes, uuids, timestamps, file
// names). Returns null when nothing meaningful remains — the caller then falls
// back to "general" rather than inventing a noisy project from an opaque id.
export function deriveProjectFromPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return null;
  const parts = sessionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    const low = seg.toLowerCase();
    if (GENERIC_DIRS.has(low)) continue;
    if (i > 0 && SESSION_CONTAINERS.has(parts[i - 1].toLowerCase())) continue; // session id under a container
    if (/^[0-9a-f]{8,}$/i.test(seg)) continue;                 // hash / hex id
    if (/^\d{8,}$/.test(seg)) continue;                        // timestamp / numeric id
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(seg)) continue; // uuid
    if (/\.(jsonl?|log|txt|md|tmp)$/i.test(seg)) continue;     // a file, not a project
    const slug = slugifyProject(seg);
    if (slug) return slug;
  }
  return null;
}

export function domainForTask(taskType) {
  const first = String(taskType || "general").split(",")[0].trim();
  return TASK_DOMAINS[first] || "general";
}

/**
 * Infer the scope of the current activity. Precedence (highest first), matching
 * the plan's table: explicit project > git repo > session/workspace path >
 * fallback general. taskType comes from the task classifier upstream.
 *
 * @returns {{project:string, taskType:string, domain:string, source:string, validity:string}}
 */
export function inferScope({ sessionPath, userText, repo, project, taskType } = {}) {
  let proj = null;
  let source = "general";
  if (project) {
    proj = slugifyProject(project);
    if (proj) source = "explicit";
  }
  if (!proj && repo) {
    proj = slugifyProject(String(repo).split("/").pop());
    if (proj) source = "repo";
  }
  if (!proj) {
    const fromPath = deriveProjectFromPath(sessionPath);
    if (fromPath) { proj = fromPath; source = "session"; }
  }
  if (!proj) { proj = "general"; source = "general"; }
  const tt = taskType || "general";
  return { project: proj, taskType: tt, domain: domainForTask(tt), source, validity: "active" };
}

// Pull a {project, taskType} view out of either a pattern.scope object or the
// older pattern.context object, so callers can pass whichever they have.
export function normalizeScope(raw) {
  if (!raw || typeof raw !== "object") return { project: "general", taskType: "general", global: false };
  const project = slugifyProject(raw.project || "general") || "general";
  const taskType = raw.taskType || "general";
  const global = !!raw.global || project === "global";
  return { project, taskType, global };
}

function taskTypeList(taskType) {
  return String(taskType || "general").split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Project-level admission: may a pattern in `patternScope` surface for a query
 * in `queryScope`? True when the projects are the same, or either side is the
 * unscoped "general"/"global" sentinel.
 */
export function scopeMatches(patternScope, queryScope) {
  const p = normalizeScope(patternScope);
  const q = normalizeScope(queryScope);
  if (p.global || q.global) return true;
  if (p.project === "general" || q.project === "general") return true;
  return p.project === q.project;
}

/**
 * taskType-level compatibility (used for ranking penalty, not hard gating).
 * A general query matches any task; otherwise the query's task must be among the
 * pattern's (comma-joined) task types, or the pattern must itself be general.
 */
export function taskTypeMatches(patternScope, queryScope) {
  const p = normalizeScope(patternScope);
  const q = normalizeScope(queryScope);
  if (q.taskType === "general" || p.taskType === "general") return true;
  const pTasks = taskTypeList(p.taskType);
  return taskTypeList(q.taskType).some((t) => pTasks.includes(t));
}

/**
 * Whether a pattern whose project does NOT match the query may still be allowed
 * through. Reserved for durable, explicitly-global hard constraints (e.g. "never
 * write secrets to disk") that should cross project boundaries.
 */
export function isCrossScopeAllowed(pattern, queryScope) {
  if (!pattern) return false;
  const ps = pattern.scope || pattern.context || {};
  const s = normalizeScope(ps);
  if (s.global) return true;
  if (pattern.knowledgeTier === "durable" && (ps.global || ps.crossProject)) return true;
  // Same project (or general) already passes scopeMatches; this only adds the
  // global-override path, so a plain durable preference stays project-bound.
  return false;
}
