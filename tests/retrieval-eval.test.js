// Retrieval evaluation (v0.9) — a small labeled corpus + query set that locks in
// the behavior the plan asks for: positive recall (Hit@3), CJK recall, and the
// negative side (cross-project isolation, rejected/ephemeral/superseded hidden,
// no false admission of unrelated memories). Drives the real runSearch pipeline.

import { describe, it } from "node:test";
import assert from "node:assert";
import { runSearch } from "../tools/search.js";
import { DEFAULT_CONFIG } from "../lib/common.js";

const now = new Date().toISOString();
const P = (over) => ({ count: 3, score: 10, status: "pending", firstSeen: now, lastSeen: now, ...over });

// project / taskType scoped corpus spanning several "projects" so cross-project
// leakage is observable.
const CORPUS = [
  P({ id: "workflow:code→test", type: "workflow", scope: { project: "hanako", taskType: "coding" },
      desc: "跨类别工作流 代码 测试 code test", fix: "改代码前先跑测试 run tests before code changes", score: 14, count: 5 }),
  P({ id: "error:syntax_error", type: "error", scope: { project: "hanako", taskType: "coding" },
      desc: "Repeated error: syntax_error 语法错误", fix: "修复语法再运行 fix syntax before retry" }),
  P({ id: "pref:paper-table", type: "preference", knowledgeTier: "durable", scope: { project: "yolo-paper", taskType: "research" },
      desc: "User correction: 论文排版 使用三线表", fix: "论文表格使用三线表 booktabs" }),
  P({ id: "pref:paper-figure", type: "preference", knowledgeTier: "durable", scope: { project: "yolo-paper", taskType: "research" },
      desc: "论文图表 风格 figure", fix: "图表用 matplotlib 默认风格" }),
  P({ id: "workflow:research→file", type: "workflow", scope: { project: "yolo-paper", taskType: "research" },
      desc: "跨类别工作流 研究 文件 research file", fix: "调研后整理文件 organize files after research" }),
  P({ id: "pref:ui-apple", type: "preference", knowledgeTier: "durable", scope: { project: "frontend-ui", taskType: "coding" },
      desc: "前端 UI Apple 极简 minimal", fix: "界面遵循 Apple 极简风格" }),
  P({ id: "pref:lang-cn", type: "preference", knowledgeTier: "durable", scope: { project: "general", taskType: "general" },
      desc: "总是用中文回复", fix: "用中文回复 reply in Chinese" }),
  P({ id: "usage:large_context", type: "usage", scope: { project: "general", taskType: "usage" },
      desc: "Large context usage 大上下文 token", fix: "压缩输入 compact inputs" }),
  // gated-out items:
  P({ id: "pref:rejected", type: "preference", status: "rejected", scope: { project: "hanako", taskType: "coding" },
      desc: "不要用 tabs 用空格", fix: "用空格 spaces not tabs" }),
  P({ id: "host_capability:snapshot", type: "host_capability", scope: { project: "general", taskType: "general" },
      desc: "宿主能力 host capability snapshot", fix: "capability list" }),
];

const search = (query, opts = {}) =>
  runSearch(CORPUS, query, { config: DEFAULT_CONFIG, limit: 5, ...opts }).results;
const ids = (results) => results.map((r) => r.id);

describe("retrieval eval · positive recall (Hit@3)", () => {
  const cases = [
    { name: "代码测试工作流 (CN)", query: "代码 测试", want: "workflow:code→test" },
    { name: "coding workflow (EN→CN synonym)", query: "coding test workflow", want: "workflow:code→test" },
    { name: "论文排版 (CJK bigram)", query: "排版", want: "pref:paper-table" },
    { name: "论文图表", query: "论文 图表", want: "pref:paper-figure" },
    { name: "syntax error (EN)", query: "syntax error", want: "error:syntax_error" },
    { name: "调研整理文件", query: "研究 文件", want: "workflow:research→file" },
    { name: "Apple 极简 UI", query: "Apple 极简", want: "pref:ui-apple" },
    { name: "中文回复偏好", query: "中文 回复", want: "pref:lang-cn" },
    { name: "大上下文用量", query: "大上下文 token", want: "usage:large_context" },
    { name: "booktabs 三线表", query: "三线表", want: "pref:paper-table" },
  ];
  for (const c of cases) {
    it(`hit@3: ${c.name}`, () => {
      const top3 = ids(search(c.query, c.opts)).slice(0, 3);
      assert.ok(top3.includes(c.want), `expected ${c.want} in top-3, got [${top3.join(", ")}]`);
    });
  }
});

describe("retrieval eval · negative & isolation", () => {
  const cases = [
    { name: "cross-project block (paper hidden from hanako)", query: "论文 排版", opts: { project: "hanako" }, absent: "pref:paper-table" },
    { name: "cross-project block (hanako code hidden from yolo-paper)", query: "代码 测试", opts: { project: "yolo-paper" }, absent: "workflow:code→test" },
    { name: "rejected pattern hidden", query: "tabs 空格", absent: "pref:rejected" },
    { name: "ephemeral capability hidden", query: "宿主 能力 capability", absent: "host_capability:snapshot" },
    { name: "unrelated not admitted (paper vs code query)", query: "代码 测试", absent: "pref:paper-figure" },
    { name: "unrelated not admitted (ui vs research query)", query: "研究 文件", absent: "pref:ui-apple" },
    { name: "no false admission on nonsense query", query: "zxqw nonexistent 乱码词汇", absent: "workflow:code→test" },
  ];
  for (const c of cases) {
    it(`absent: ${c.name}`, () => {
      const got = ids(search(c.query, c.opts));
      assert.ok(!got.includes(c.absent), `expected ${c.absent} absent, got [${got.join(", ")}]`);
    });
  }
});

describe("retrieval eval · aggregate metrics", () => {
  // Labeled (query → single relevant id) set reused for MRR / Hit@1.
  const labeled = [
    { query: "代码 测试", want: "workflow:code→test" },
    { query: "排版 三线表", want: "pref:paper-table" },
    { query: "syntax error 语法", want: "error:syntax_error" },
    { query: "研究 文件", want: "workflow:research→file" },
    { query: "Apple 极简", want: "pref:ui-apple" },
    { query: "中文 回复", want: "pref:lang-cn" },
    { query: "大上下文 token", want: "usage:large_context" },
  ];

  it("Hit@1 ≥ 0.85", () => {
    let hits = 0;
    for (const c of labeled) if (ids(search(c.query))[0] === c.want) hits++;
    const hit1 = hits / labeled.length;
    assert.ok(hit1 >= 0.85, `Hit@1 = ${hit1.toFixed(2)}`);
  });

  it("MRR ≥ 0.85", () => {
    let mrr = 0;
    for (const c of labeled) {
      const rank = ids(search(c.query)).indexOf(c.want);
      if (rank >= 0) mrr += 1 / (rank + 1);
    }
    mrr /= labeled.length;
    assert.ok(mrr >= 0.85, `MRR = ${mrr.toFixed(2)}`);
  });

  it("scope leakage rate = 0 across project-scoped queries", () => {
    // For each project, query its own terms scoped to a DIFFERENT project and
    // confirm none of the foreign project's memories leak through.
    const probes = [
      { project: "hanako", query: "论文 排版 图表", foreign: ["pref:paper-table", "pref:paper-figure"] },
      { project: "yolo-paper", query: "代码 测试 syntax", foreign: ["workflow:code→test", "error:syntax_error"] },
      { project: "frontend-ui", query: "论文 排版", foreign: ["pref:paper-table"] },
    ];
    let leaks = 0, total = 0;
    for (const pr of probes) {
      const got = new Set(ids(search(pr.query, { project: pr.project })));
      for (const f of pr.foreign) { total++; if (got.has(f)) leaks++; }
    }
    assert.equal(leaks, 0, `leaked ${leaks}/${total} foreign memories`);
  });

  it("false admission rate = 0 on an out-of-vocabulary query", () => {
    const got = search("qqzz 不存在的检索词 foobarbaz");
    assert.equal(got.length, 0, `expected no admissions, got [${ids(got).join(", ")}]`);
  });
});
