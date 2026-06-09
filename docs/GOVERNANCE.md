# 学习治理

学习结果进入可审计治理链，防止模式膨胀、噪音注入和无人监管的自动变更。

---

## 治理流水线

```
Pattern → autoApprove → Proposal → Review Queue → Diff Preview → Validation Gate → Apply / Reject → Event Log → Rollback
```

### Proposal 两级风险

| 类型 | 风险 | 行为 |
|---|---|---|
| `skill_patch` | 低 | 默认自动应用，刷新 SKILL.md |
| `code_patch` | 高 | 永不自动写代码，需人工审批后手动实施 |

`skill_patch` 在 `requireReviewForAutoApply: true` 下停止自动应用，进入 Review Queue 等待人工审批。

### Review Queue

Proposal 创建后自动入队，记录：
- 来源 pattern ID
- 风险等级
- diff 预览（skill_patch/config_patch 的行级变更，code_patch 的实施计划）
- validation 状态

控制动作：`review_panel`、`preview_proposal`、`validate_proposal`、`approve_review`、`reject_review`、`apply_review`。

### Validation Gate

Proposal apply 前必须通过：
- `skill_patch`：检查头部 `# Runtime Self-Learning` + token budget
- `config_patch`：检查 payload 存在性
- `code_patch`：明确阻止自动 apply
- doctor 状态为 `critical` 时阻止所有 apply

### Event Log

Append-only `event_log.jsonl` 记录 proposal/review/skill 的所有状态变更。`event_summary` 从事件流回放各实体最新状态。

### Rollback

`action=rollback` 从 `skill_history/` 恢复上一个 SKILL.md 快照（上限 20）。

---

## Doctor 健康检查

`self_learning_doctor` 只读诊断，不修改文件。输出 Good / Warning / Critical + 修复建议。

| 检查项 | 触发条件 | 严重度 |
|---|---|---|
| `duplicate_patterns` | desc/fix 完全相同的重复 pattern | warning |
| `conflicting_facts` | 同 subject/predicate 多个有效值 | high |
| `stale_auto_approved` | 自动批准但长期未采纳 | warning |
| `pending_preference_injection` | `includePendingPreferences` 开启且存在未审核偏好 | high |
| `pending_preference_backlog` | 未审核偏好堆积 ≥10 | info |
| `proposal_backlog` | 待处理提案 ≥10（≥25 升级 critical） | warning/critical |
| `skill_budget` | 可注入提示超出 `maxSkillTokens` | info |
| `privacy_retention` | 日志存在超过 30 天的条目 | warning |
| `scope_leakage` | 可注入 pattern 横跨多个具体项目 | info |
| `orphan_relations` | 关系边指向已不存在的 pattern | warning |
| `evidence_missing` | 高分 pattern 缺证据 | info |
| `review_backlog` | 待审核 review ≥20 | warning |
| `validation_blocked_reviews` | 被 validation 阻塞的 review | high |
| `memfs_stale` | MemFS 视图落后于 patterns/facts | info |

评分从 100 起按严重度扣分。Critical 或 <50 → Critical，high/warning 或 <80 → Warning，否则 Good。

---

## MemFS 长期记忆视图

`patterns.json` 是机器源，人读不便。MemFS 把当前记忆渲染为可读、可 diff 的 Markdown 文件树（派生视图，可删除后重建）：

```text
memfs/
├── system/{user_profile,hard_constraints,active_projects}.md
├── projects/<project>.md
├── patterns/{workflows,errors,preferences}.md
└── archive/deprecated.md
```

```text
self_learning_control action=regenerate_memfs
```

---

## 策略配置档

三种预设，一键切换：

| 配置档 | 自动注入 | 自动批准 | Pending 偏好 | 严格审核 |
|---|---|---|---|---|
| `conservative` | 关闭 | 关闭 | 关闭 | 开启 |
| `balanced`（默认） | 开启 | 开启 | 关闭 | 关闭 |
| `autonomous` | 开启 | 开启 | 开启 | 关闭 |

外部网络功能（模型顾问、语义检索）在所有配置档中默认关闭，需显式配置才会外发。

```text
self_learning_control action=set_policy_profile governanceProfile=conservative
```

## 审计包导出

```text
self_learning_control action=export_audit_bundle
```

生成 `audit-bundle.json` + `audit-report.md`，汇总 doctor、scope 分布、proposal/review 状态、event replay summary，自动脱敏 API key/token/secret/password。
