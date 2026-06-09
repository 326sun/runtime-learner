// Tests for lib/rank-fusion.js — Reciprocal Rank Fusion.

import { describe, it } from "node:test";
import assert from "node:assert";
import { rankByScore, rrfScores, fuse } from "../lib/rank-fusion.js";

describe("rank-fusion · rankByScore", () => {
  it("orders ids best-first and drops non-finite scores", () => {
    const items = [{ id: "a", s: 1 }, { id: "b", s: 3 }, { id: "c", s: NaN }];
    assert.deepEqual(rankByScore(items, (x) => x.s), ["b", "a"]);
  });
});

describe("rank-fusion · rrfScores", () => {
  it("rewards consensus across lists", () => {
    // 'a' is #1 in list1 and #2 in list2; 'b' is #2 then #1; 'c' only appears low.
    const scores = rrfScores([["a", "b", "c"], ["b", "a"]], { k: 60 });
    assert.ok(scores.get("a") > scores.get("c"));
    assert.ok(scores.get("b") > scores.get("c"));
  });

  it("an item ranked top by one list can still beat a never-top item", () => {
    // x is #1 in list A only; y is #2 in both. With k=60, x: 1/61; y: 1/62+1/62.
    const s = rrfScores([["x", "z"], ["z", "y", "x"]], { k: 1 });
    // x: 1/(1+1) + 1/(1+3) = 0.5+0.25=0.75 ; z: 1/2 + 1/2 = 1.0 ; y: 1/3
    assert.ok(s.get("z") > s.get("x"));
    assert.ok(s.get("x") > s.get("y"));
  });

  it("ignores non-array lists and null ids", () => {
    const s = rrfScores([["a"], null, [null, "a"]], { k: 60 });
    assert.ok(s.get("a") > 0);
    assert.equal(s.has(null), false);
  });
});

describe("rank-fusion · fuse", () => {
  it("returns descending {id,score}", () => {
    const out = fuse([["a", "b"], ["a", "c"]], { k: 60 });
    assert.equal(out[0].id, "a");
    assert.ok(out[0].score >= out[1].score);
  });
});
