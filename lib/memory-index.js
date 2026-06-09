/**
 * memory-index — pure-JS BM25 inverted index for Runtime Self-Learning (v0.9).
 *
 * The plan called for SQLite FTS5; we deliberately use a dependency-free,
 * Node-18-compatible inverted index instead (see README · 检索). The payoff is
 * full control over CJK tokenization, which is the plan's #1 retrieval pain
 * point: FTS5's default tokenizer does not segment Chinese, so "排版" would not
 * match a document containing "论文排版". Here we emit CJK unigrams AND adjacent
 * bigrams, so substring-ish Chinese queries recall reliably without a segmenter.
 *
 * The pattern store is tiny (≤ ~100 patterns), so the index is cheap to rebuild
 * per query; a persistent on-disk index would be premature. The class API
 * (rebuild/upsert/search) mirrors what a SQLite-backed index would expose, so a
 * future swap stays localized.
 */

// CJK ranges: Unified Ideographs (+Ext A via 㐀-䶿), Hiragana, Katakana, Hangul.
const CJK_RE = /[㐀-鿿぀-ゟ゠-ヿ가-힯]/;
const ASCII_RE = /[a-z0-9]/;

/**
 * Tokenize mixed CN/EN text. ASCII/alphanumeric runs become word tokens; CJK
 * runs become unigrams plus adjacent bigrams. Everything else is a separator.
 */
export function tokenizeText(text) {
  const s = String(text || "").toLowerCase();
  const tokens = [];
  let ascii = "";
  let cjk = [];
  const flushAscii = () => { if (ascii) { tokens.push(ascii); ascii = ""; } };
  const flushCjk = () => {
    if (!cjk.length) return;
    for (let i = 0; i < cjk.length; i++) {
      tokens.push(cjk[i]);                              // unigram
      if (i + 1 < cjk.length) tokens.push(cjk[i] + cjk[i + 1]); // bigram
    }
    cjk = [];
  };
  for (const ch of s) {
    if (ASCII_RE.test(ch)) { flushCjk(); ascii += ch; }
    else if (CJK_RE.test(ch)) { flushAscii(); cjk.push(ch); }
    else { flushAscii(); flushCjk(); }
  }
  flushAscii();
  flushCjk();
  return tokens;
}

// Default document text for a pattern/fact: the fields worth matching on. id and
// type are duplicated lightly via the explicit fields below; BM25's term
// frequency then naturally rewards items that mention a query term in several
// fields.
export function defaultDocText(item) {
  if (!item || typeof item !== "object") return "";
  const ctx = item.context || {};
  const scope = item.scope || {};
  const parts = [
    item.id,
    item.type,
    item.desc,
    item.fix,
    scope.project,
    scope.taskType || ctx.taskType,
    Array.isArray(item.tags) ? item.tags.join(" ") : "",
    Array.isArray(item.keywords) ? item.keywords.join(" ") : "",
    Array.isArray(ctx.categories) ? ctx.categories.join(" ") : "",
    Array.isArray(ctx.tools) ? ctx.tools.join(" ") : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const K1 = 1.5;
const B = 0.75;

export class MemoryIndex {
  constructor({ docText = defaultDocText } = {}) {
    this._docText = docText;
    this.docs = new Map();      // id -> { item, tf:Map, len }
    this.df = new Map();        // term -> document frequency
    this._avgdl = 0;
    this._dirty = false;
  }

  get size() { return this.docs.size; }

  _index(item) {
    const tokens = tokenizeText(this._docText(item));
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { item, tf, len: tokens.length };
  }

  upsert(item) {
    if (!item || !item.id) return;
    if (this.docs.has(item.id)) this.remove(item.id);
    const doc = this._index(item);
    this.docs.set(item.id, doc);
    for (const t of doc.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this._dirty = true;
  }

  remove(id) {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const t of doc.tf.keys()) {
      const n = (this.df.get(t) || 0) - 1;
      if (n <= 0) this.df.delete(t); else this.df.set(t, n);
    }
    this.docs.delete(id);
    this._dirty = true;
  }

  rebuild(items) {
    this.docs.clear();
    this.df.clear();
    for (const item of items || []) this.upsert(item);
    this._recomputeAvg();
    return this;
  }

  _recomputeAvg() {
    let total = 0;
    for (const d of this.docs.values()) total += d.len;
    this._avgdl = this.docs.size ? total / this.docs.size : 0;
    this._dirty = false;
  }

  /**
   * BM25 search. `query` may be a string (tokenized here) or a pre-tokenized
   * array (e.g. synonym-expanded by the caller). Returns descending bm25 score.
   */
  search(query, { limit = 20 } = {}) {
    if (this._dirty) this._recomputeAvg();
    const qTokens = Array.isArray(query) ? query : tokenizeText(query);
    const qset = [...new Set(qTokens)];
    if (!qset.length) return [];
    const N = this.docs.size;
    const avgdl = this._avgdl || 1;
    const out = [];
    for (const [id, d] of this.docs) {
      let score = 0;
      for (const t of qset) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const denom = f + K1 * (1 - B + B * (d.len / avgdl));
        score += idf * (f * (K1 + 1)) / denom;
      }
      if (score > 0) out.push({ id, item: d.item, bm25: Number(score.toFixed(4)) });
    }
    out.sort((a, b) => b.bm25 - a.bm25);
    return out.slice(0, limit);
  }
}

// Convenience: build a fresh index over `items` and run one query. Used by the
// stateless search tool, which has no long-lived index to maintain.
export function searchIndex(items, query, opts = {}) {
  return new MemoryIndex({ docText: opts.docText }).rebuild(items).search(query, opts);
}
