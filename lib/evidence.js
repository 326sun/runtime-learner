/**
 * evidence — provenance records for patterns and facts (v1.1).
 *
 * Why (from MemMachine / the plan): don't keep only the LLM/regex-distilled
 * conclusion ("fix"); keep a traceable pointer to where it came from. That makes
 * a memory auditable — the user (and the doctor) can see WHY a rule was learned.
 *
 * Privacy (the plan's §8 risk row): an evidence quote may contain secrets or
 * long private text. So we summarize/truncate, redact obvious secrets, and
 * always store a hash of the original — never blindly persist the full raw text.
 */

import { shortHash, safeText } from "./helpers.js";

const MAX_QUOTE_LEN = 160;
const MAX_EVIDENCE = 3;

// Obvious secret/PII shapes — redacted before storage. Conservative: aimed at
// the high-signal cases (keys, tokens, emails, inline credentials) rather than
// trying to be a full DLP scanner.
const SENSITIVE = [
  { re: /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{10,}\b/g, tag: "[redacted-key]" },
  { re: /\b[A-Fa-f0-9]{32,}\b/g, tag: "[redacted-hex]" },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, tag: "[redacted-email]" },
  { re: /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, tag: "$1=[redacted]" },
];

export function redactSensitive(text) {
  let out = String(text || "");
  let redacted = false;
  for (const { re, tag } of SENSITIVE) {
    if (re.test(out)) { redacted = true; out = out.replace(re, tag); }
  }
  return { text: out, redacted };
}

/**
 * Normalize a quote for storage: collapse whitespace, redact secrets, truncate.
 * Returns { quote, hash, redacted } where hash is over the ORIGINAL text so two
 * evidences from the same source dedupe even after truncation.
 */
export function summarizeEvidenceText(text, maxLen = MAX_QUOTE_LEN) {
  const original = safeText(text, 2000);
  const hash = shortHash(original);
  const { text: cleaned, redacted } = redactSensitive(original);
  const truncated = cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
  return { quote: truncated, hash, redacted };
}

/**
 * Build a normalized evidence record.
 * @param {object} src { type, file, date, line, quote, id }
 */
export function makeEvidence({ type = "turn", file = null, date = null, line = null, quote = "", id = null } = {}) {
  const { quote: q, hash, redacted } = summarizeEvidenceText(quote);
  const ev = { type, date: date || new Date().toISOString(), quote: q, hash };
  if (file) ev.file = file;
  if (line != null) ev.line = line;
  if (id) ev.id = id;
  if (redacted) ev.redacted = true;
  return ev;
}

/**
 * Attach an evidence record to a pattern/fact in place: ensures the array,
 * dedupes by hash, and caps to the most recent `max`. Returns the host.
 */
export function attachEvidence(host, ev, { max = MAX_EVIDENCE } = {}) {
  if (!host || !ev) return host;
  const list = Array.isArray(host.evidence) ? host.evidence : [];
  if (list.some((e) => e.hash === ev.hash)) {
    host.evidence = list;
    return host; // already recorded
  }
  list.push(ev);
  // keep newest by date, cap length
  list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  host.evidence = list.slice(0, max);
  return host;
}

// One-line provenance preview for search results / reports. Falls back to the
// distilled fix/desc when no evidence is attached.
export function previewEvidence(item) {
  const ev = Array.isArray(item?.evidence) ? item.evidence[0] : null;
  const raw = (ev && ev.quote) || item?.fix || item?.desc || "";
  const text = String(raw).replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}
