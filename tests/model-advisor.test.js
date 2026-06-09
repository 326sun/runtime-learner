import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

// Redirect the learner data dir into a temp home BEFORE the module under test is
// imported (it resolves its state-file paths at load time via hanakoHome()).
const tmpHome = path.join(os.tmpdir(), `learner-advisor-test-${process.pid}-${Date.now()}`);
process.env.HANA_HOME = tmpHome;
const learnerDir = () => path.join(tmpHome, "self-learning");

let advisor;
const originalFetch = globalThis.fetch;

describe("model advisor", () => {
  before(async () => {
    fs.mkdirSync(learnerDir(), { recursive: true });
    advisor = await import("../lib/model-advisor.js");
  });

  after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("normalizeBaseUrl", () => {
    it("appends /v1/chat/completions to a bare host", () => {
      assert.equal(advisor.normalizeBaseUrl("https://api.x.com"), "https://api.x.com/v1/chat/completions");
    });
    it("appends /chat/completions when the path already ends with /v1", () => {
      assert.equal(advisor.normalizeBaseUrl("https://api.x.com/v1"), "https://api.x.com/v1/chat/completions");
    });
    it("leaves a full endpoint untouched", () => {
      assert.equal(advisor.normalizeBaseUrl("https://api.x.com/v1/chat/completions"), "https://api.x.com/v1/chat/completions");
    });
    it("strips trailing slashes", () => {
      assert.equal(advisor.normalizeBaseUrl("https://api.x.com/v1/"), "https://api.x.com/v1/chat/completions");
    });
    it("returns empty string for blank input", () => {
      assert.equal(advisor.normalizeBaseUrl(""), "");
    });
  });

  describe("runModelAdvisor", () => {
    const baseConfig = {
      modelAdvisorEnabled: true,
      modelAdvisorSource: "private",
      modelAdvisorBaseUrl: "https://api.example.com",
      modelAdvisorModel: "small-1",
      modelAdvisorApiKey: "sk-test",
      modelAdvisorMinIntervalMinutes: 60,
      minAdvisorNewPatterns: 0,
    };

    const jsonResponse = () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ suggestions: [] }) } }] }),
    });

    beforeEach(() => {
      fs.rmSync(path.join(learnerDir(), "model_advice_state.json"), { force: true });
      fs.rmSync(path.join(learnerDir(), "model_advice.json"), { force: true });
    });

    it("skips when disabled, without any network call", async () => {
      let called = false;
      globalThis.fetch = async () => { called = true; throw new Error("should not fetch"); };
      const res = await advisor.runModelAdvisor({ config: { ...baseConfig, modelAdvisorEnabled: false }, patterns: [] });
      assert.equal(res.ok, false);
      assert.equal(res.skipped, true);
      assert.equal(called, false);
    });

    it("never sends preference or durable patterns to the external model", async () => {
      let sentBody = null;
      globalThis.fetch = async (_url, opts) => { sentBody = opts.body; return jsonResponse(); };
      const patterns = [
        { id: "workflow:a→b", type: "workflow", status: "approved", count: 5, score: 30, desc: "WF_DESC", fix: "" },
        { id: "pref:secret", type: "preference", knowledgeTier: "durable", status: "approved", count: 3, score: 20, desc: "SECRET_USER_TEXT", fix: "SECRET_USER_TEXT" },
        { id: "error:net", type: "error", status: "pending", count: 4, score: 8, desc: "ERR_DESC", fix: "" },
      ];
      const res = await advisor.runModelAdvisor({ config: baseConfig, patterns });
      assert.equal(res.ok, true);
      assert.ok(sentBody, "fetch should have been called");
      assert.ok(sentBody.includes("workflow:a→b"), "non-sensitive workflow should be sent");
      assert.ok(sentBody.includes("error:net"), "non-sensitive error should be sent");
      assert.ok(!sentBody.includes("pref:secret"), "preference id must not be sent");
      assert.ok(!sentBody.includes("SECRET_USER_TEXT"), "raw user text must not be sent");
    });

    it("respects the rate limit — no second call within the interval", async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls += 1; return jsonResponse(); };
      const patterns = [{ id: "error:x", type: "error", status: "pending", count: 4, score: 8, desc: "d", fix: "" }];
      const first = await advisor.runModelAdvisor({ config: baseConfig, patterns });
      assert.equal(first.ok, true);
      const second = await advisor.runModelAdvisor({ config: baseConfig, patterns });
      assert.equal(second.ok, false);
      assert.equal(second.skipped, true);
      assert.equal(calls, 1);
    });

    it("gates on genuinely new pattern IDs, immune to total-count shrink/churn", async () => {
      globalThis.fetch = async () => jsonResponse();
      const cfg = { ...baseConfig, minAdvisorNewPatterns: 2 };
      const mk = (id) => ({ id, type: "error", status: "pending", count: 4, score: 8, desc: "d", fix: "" });
      // The min-interval gate clamps to ≥1 min, so clear only lastRunAt between
      // runs (keeping lastPatternIds) to isolate the new-pattern gate from it.
      const statePath = path.join(learnerDir(), "model_advice_state.json");
      const clearRunAt = () => {
        const s = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        delete s.lastRunAt;
        fs.writeFileSync(statePath, JSON.stringify(s));
      };

      // First run establishes the baseline ID set {a, b, c}.
      const first = await advisor.runModelAdvisor({ config: cfg, patterns: [mk("a"), mk("b"), mk("c")] });
      assert.equal(first.ok, true);
      clearRunAt();

      // Churn: 2 pruned, 2 new (total count drops). A total-count delta would be
      // <= 0 and wrongly suppress; the ID-based gate sees 2 new and runs.
      const churn = await advisor.runModelAdvisor({ config: cfg, patterns: [mk("a"), mk("d"), mk("e")] });
      assert.equal(churn.ok, true, "2 genuinely new IDs should pass even as total count drops");
      clearRunAt();

      // Only 1 new ID (f) since last run {a,d,e} → below threshold → skip.
      const oneNew = await advisor.runModelAdvisor({ config: cfg, patterns: [mk("d"), mk("e"), mk("f")] });
      assert.equal(oneNew.ok, false);
      assert.equal(oneNew.skipped, true);
    });
  });
});
