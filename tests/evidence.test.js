// Tests for lib/evidence.js — provenance records with privacy-aware redaction.

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  summarizeEvidenceText,
  redactSensitive,
  makeEvidence,
  attachEvidence,
  previewEvidence,
} from "../lib/evidence.js";

describe("evidence · redactSensitive", () => {
  it("redacts API keys, emails, and inline credentials", () => {
    assert.match(redactSensitive("token is sk-abcdef0123456789").text, /\[redacted-key\]/);
    assert.match(redactSensitive("ping me at user@example.com").text, /\[redacted-email\]/);
    assert.match(redactSensitive("password=hunter2longvalue").text, /password=\[redacted\]/);
    assert.match(redactSensitive("hash 0123456789abcdef0123456789abcdef").text, /\[redacted-hex\]/);
  });

  it("leaves benign text untouched", () => {
    const r = redactSensitive("run npm test before pushing");
    assert.equal(r.redacted, false);
    assert.equal(r.text, "run npm test before pushing");
  });
});

describe("evidence · summarizeEvidenceText", () => {
  it("truncates long text and returns a stable hash of the original", () => {
    const long = "x".repeat(500);
    const a = summarizeEvidenceText(long);
    assert.ok(a.quote.length <= 161);
    assert.equal(a.hash, summarizeEvidenceText(long).hash);
    assert.match(a.quote, /…$/);
  });

  it("flags redaction in the summary", () => {
    const s = summarizeEvidenceText("key sk-abcdef0123456789 here");
    assert.equal(s.redacted, true);
    assert.match(s.quote, /\[redacted-key\]/);
  });
});

describe("evidence · makeEvidence / attachEvidence", () => {
  it("builds a normalized record", () => {
    const ev = makeEvidence({ type: "turn", file: "experience_log.jsonl", date: "2026-06-09T00:00:00Z", quote: "tools: a -> b" });
    assert.equal(ev.type, "turn");
    assert.equal(ev.file, "experience_log.jsonl");
    assert.equal(ev.quote, "tools: a -> b");
    assert.ok(ev.hash);
  });

  it("dedupes by hash and caps to the most recent N", () => {
    const host = {};
    attachEvidence(host, makeEvidence({ date: "2026-01-01T00:00:00Z", quote: "same" }));
    attachEvidence(host, makeEvidence({ date: "2026-02-01T00:00:00Z", quote: "same" })); // dup hash
    assert.equal(host.evidence.length, 1);

    attachEvidence(host, makeEvidence({ date: "2026-03-01T00:00:00Z", quote: "b" }));
    attachEvidence(host, makeEvidence({ date: "2026-04-01T00:00:00Z", quote: "c" }));
    attachEvidence(host, makeEvidence({ date: "2026-05-01T00:00:00Z", quote: "d" }), { max: 3 });
    assert.equal(host.evidence.length, 3);
    // newest first
    assert.equal(host.evidence[0].quote, "d");
  });
});

describe("evidence · previewEvidence", () => {
  it("prefers the first evidence quote, falls back to fix then desc", () => {
    assert.equal(previewEvidence({ evidence: [{ quote: "from evidence" }], fix: "f", desc: "d" }), "from evidence");
    assert.equal(previewEvidence({ fix: "the fix", desc: "d" }), "the fix");
    assert.equal(previewEvidence({ desc: "only desc" }), "only desc");
  });
});
