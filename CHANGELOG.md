# Changelog

## 1.3.0

可选语义检索 + RRF 融合（计划 §7.6）：

- **新增 `lib/rank-fusion.js`**：Reciprocal Rank Fusion。按位次（非分值）融合多路排序 `score(id)=Σ 1/(k+rank)`，对各路量纲不敏感、抗单路极端值
- **新增 `lib/embeddings.js`**：**默认关闭**的可选 embedding 层。`cosineSim`、`resolveSemanticConfig`、`embedTexts`（OpenAI 兼容 `/embeddings`，按内容哈希缓存到 `embeddings_cache.json`，可注入 `fetchImpl`/`cache` 便于离线测试）。关闭 / 无端点 / 网络失败 → 优雅退化为纯 BM25，永不抛错
- **`tools/search.js`**：`runSearch` 新增可选 `semantic` 入参——提供时用 RRF 融合 BM25 + 语义 + 关系 + 记忆强度，否则保持原加权 BM25（**默认行为与检索评估集完全不变**）。tool `execute` 在开启且端点可用时：先 BM25 探测候选 → 批量 embed（缓存）→ RRF 重排；任意失败退化
- **`DEFAULT_CONFIG` + manifest**：新增 `semanticSearchEnabled`(false) / `semanticEmbeddingBaseUrl` / `semanticEmbeddingApiKey` / `semanticEmbeddingModel`（manifest 暴露、隐私可见）；`semanticTopK`(50) / `rrfK`(60) 为高级 DEFAULT_CONFIG-only。control `set_config` 与 schema 同步
- **隐私**：开启语义检索会把查询词与候选记忆文本发送到你配置的 embedding 端点，已在 README 隐私章节披露；默认关闭
- **新增 `tests/rank-fusion.test.js`、`tests/semantic-search.test.js`**：RRF 数学、cosine、端点解析、`embedTexts` mock（缓存命中/HTTP 错误降级）、RRF 在 bm25/记忆强度对冲时由语义决定 top1。测试总数 215 → 227

## 1.2.0

MemFS 长期记忆视图（计划 §7.5）：

- **新增 `lib/memfs.js`**：把当前长期记忆渲染成可读的 Markdown 文件树（`system/` 用户画像·硬约束·活跃项目、`projects/<project>.md`、`patterns/` 工作流·错误·偏好、`archive/deprecated.md`）。`buildMemFS` 为纯函数（返回 `{路径:内容}`），`generateMemFS` 负责落盘并写 `.index.json`（含指纹）。**派生只读视图，非源数据**——每次全量重建，安全清理残留
- **`self_learning_control` 新增 `regenerate_memfs`**：从 patterns + facts 重建 MemFS
- **`tools/doctor.js` 新增 `memfs_stale` 检查**：用 `fingerprintPatterns` 比对 memfs 视图与当前记忆，过期则建议 `regenerate_memfs`（仅在 memfs 已生成时提示）
- **新增 `tests/memfs.test.js`**：文件树渲染、durable 偏好归类、项目分组、归档、指纹敏感性、磁盘重建幂等与残留清理、doctor 过期检测。测试总数 204 → 215

## 1.1.0

证据链与时间事实（让记忆可追溯、可覆盖、可解释）：

- **新增 `lib/evidence.js`**：pattern/fact 的证据记录。`makeEvidence` / `attachEvidence`（按 hash 去重、上限 3、保留最新）。**隐私优先**：quote 截断到 ~160 字，对 API key / 邮箱 / 令牌 / 内联凭据脱敏，保存原文哈希而非敏感全文（计划 §8 风险行）
- **新增 `lib/temporal.js`**：事实有效期与覆盖。`isActiveFact` / `activeFacts` / `applyFact`（同 subject+predicate+project 不同 object 时自动 supersede 旧事实：写 validTo + supersededBy，新事实 supersedes 记录被覆盖项；同值重述则刷新不重复）/ `factConflicts`
- **新增 `lib/facts.js`**：`facts.json` 时间事实存储。`recordFact` 落盘并自动覆盖冲突事实；`factToMemoryItem` 把事实适配成检索 memory-item，有效期/覆盖映射到 gate 检查的字段——**被覆盖/过期的事实由同一准入 Gate 拒绝，旧值不再召回**
- **pattern 写入 evidence**：`lib/pattern-detector.js` 在 workflow / preference / error 的创建与强化时附带脱敏证据；新建偏好/错误直接带初始 evidence
- **`tools/search.js`**：合并 `facts.json` 活跃事实为检索候选（被覆盖事实经 Gate 过滤）；`evidencePreview` 改用 `lib/evidence.js` 的 `previewEvidence`，展示真实来源摘要
- **`tools/doctor.js`**：`conflicting_facts` 改用 `temporal.factConflicts`（按项目作用域），与检索一致
- **新增 `episodes.jsonl`**：每轮一条结构化情节（scope/tools/correction/summary）作为 provenance 流，纳入 30 天清理（`index.js`、`lib/observer.js`）
- **新增 `tests/evidence.test.js`、`tests/temporal-facts.test.js`**：脱敏/去重/覆盖语义 + 「被覆盖事实不再召回」端到端。测试总数 190 → 204

## 1.0.0

记忆治理与诊断闭环（`self_learning_doctor`）：

- **新增 `tools/doctor.js`**：只读健康检查工具 `self_learning_doctor`。纯函数 `diagnose()` 与磁盘读取分离，便于测试。检查项：`duplicate_patterns`（重复）、`conflicting_facts`（同 subject/predicate 多有效值，facts v1.1 生效）、`stale_auto_approved`（自动批准但长期未采纳）、`pending_preference_injection`（opt-in 开启且有未审核偏好，high）/`pending_preference_backlog`（堆积，info）、`proposal_backlog`（≥10 warning / ≥25 critical）、`skill_budget`（可注入提示超 `maxSkillTokens`）、`privacy_retention`（日志超 30 天）、`scope_leakage`（可注入 pattern 横跨多项目）、`orphan_relations`（关系边指向不存在的 pattern）、`evidence_missing`（高分缺证据，仅证据特性启用后）
- **输出 Good / Warning / Critical**：100 分起按严重度扣分；critical 或 <50 → Critical，high/warning 或 <80 → Warning，否则 Good。支持 `format=text`（默认）/ `format=json`。**只诊断，不修改任何文件**
- **`self_learning_control` 新增 `doctor` action**：`action=doctor [format=json]` 复用同一诊断核心，作为治理建议入口
- manifest 注册 `onToolCall:self_learning_doctor`；install.cjs 纳入 `tools/doctor.js`；README 新增「健康检查」章节
- **新增 `tests/doctor.test.js`**（17 项）：逐项隔离触发每个检查 + 评分/状态分级 + formatReport。测试总数 173 → 190

## 0.9.0

作用域检索升级（Scope + 倒排索引 + 准入 Gate + 检索评估）：

- **新增 `lib/scope.js`**：`inferScope` / `scopeMatches` / `taskTypeMatches` / `isCrossScopeAllowed`。从会话/工作区路径推断 `{ project, taskType, source }`，跳过 `sessions/<id>` 一类的会话 id 段；project 不可判定时回退 `general`（未作用域通配）
- **新增 `lib/memory-index.js`**：纯 JS BM25 倒排索引，**CJK-aware 分词**（单字 + 相邻二元组），无外部依赖、Node ≥ 18。替代计划中的 SQLite FTS5——FTS5 默认不切分中文，`排版` 无法命中 `论文排版`；二元组方案无需分词器即可稳定中文召回
- **新增 `lib/memory-gate.js`**：记忆准入边界。`admitMemory` 拒绝 rejected / ephemeral / 过期(`validTo`) / 已废弃(`supersededBy`) / 跨项目(非 global) / 低置信(`confidence` 低于阈值)；跨任务类型不拒绝而降权
- **重构 `tools/search.js`**：流程改为 `CJK 分词+同义词 → BM25 Top-K → Gate → relation+memoryStrength+scope 重排 → 低置信拒绝 → Top N`。新增 `project` 检索参数；结果新增 `scope` / `evidencePreview` / `gateReason` / `scoreBreakdown` 字段。低置信拒绝额外剔除「仅单字 CJK 巧合」匹配（如 `乱码` 误命中 `代码` 的 `码`），保留二元组召回
- **pattern 写入 scope**：`lib/observer.js` 在 flushTurn 推断 scope 并写入经验对象（取代硬编码的 `project: "general"`）；`lib/pattern-detector.js` 将 scope 标记到 workflow / preference / error pattern 上
- **`DEFAULT_CONFIG` 新增检索调优键**（仅高级，不在 manifest 暴露）：`retrievalCandidateLimit` / `minRetrievalRelative` / `crossTaskPenalty` / `minRetrievalConfidence`
- **新增 `tests/scope-gate.test.js`、`tests/retrieval-eval.test.js`**：作用域/Gate 单元测试 + 带标注语料的检索评估（Hit@1 / MRR / 跨项目泄漏率 / 误召回率）。测试总数 133 → 173
- 不引入向量库、不接外部服务（计划第 11.5 条）

## 0.8.2

发布前一致性与隐私默认收敛：

- **`includePendingPreferences` 默认改为 `false`**（隐私保守化）：未审核的用户纠正不再默认注入 SKILL.md，仅保留为可检索状态，需经审批或反复强化越过置信阈值后才注入。高级单用户可显式开启（`lib/common.js`、`manifest.json`、README 配置表新增该行说明）
- **新增 `tests/config-consistency.test.js`**：锁定 `DEFAULT_CONFIG` ↔ `manifest.json` ↔ README 配置表三处默认值一致，防止类似 `modelAdvisorMinIntervalMinutes`（60/180）在某一处漂移而其它处未同步。共享键默认值不一致即测试失败
- 复核确认两项计划中的修复已在既有版本落地，本次无需改动：`modelAdvisorMinIntervalMinutes` 三处已一致为 `60`（v0.8.0 由 180 改回）；日志清理已按 30 天窗口严格执行、不再有体积阈值（`index.js` `pruneDataFiles`）
- 测试总数 128 → 130

## 0.8.1

自我学习逻辑修复（13 处）：

深层修复（第二轮）：

- **剪枝后 seqCache 未清理导致忘却失效**（重大）：`pruneMemory` 删除工作流模式时未清除对应的 `seqCache`/`seqInsertOrder` 计数器；被衰减剪掉的工作流只要序列再现一次就从旧计数 `+1` 满分复活，使遗忘曲线形同虚设。新增 `_forgetPattern()` 统一清理三处剪枝路径（`pattern-detector.js`）
- **工作流 taskType 累积重复**：合并时把既有的逗号连接串当成单个不可分 token，导致 `"coding,research" + "coding" → "coding,research,coding"`。改为先按逗号拆分再去重（`pattern-detector.js`）
- **人工承认未清除 autoApproved**：用户经 control 承认自动批准过的模式时，`autoApproved` 残留致其仍被遗忘曲线剪枝。control 承认时 `delete autoApproved`，`syncDiskStatus` 同步吸收该清除避免被运行中插件回写（`control.js`、`index.js`）

第一轮修复（10 处）：

- **model advisor 门控**：以"模式 ID 新增数"替代"模式总数差"判断是否运行。此前总数因剪枝/换血下降会让 delta 变负，永久压制 advisor；现按上次运行的 ID 集合统计真正新增的模式，对剪枝免疫（`model-advisor.js`）
- **采纳窗口降权**：跨整个窗口累积记录已采纳的工作流（`adoptedIds`），窗口关闭时只降权"从未被采纳"的；此前只看最后一轮，会误降权早已采纳的工作流（`observer.js`）
- **pin_memory 入库**：只接受显式的字符串 `content`，不再 `JSON.stringify(args)` 兜底——避免缺参/空对象事件把 `"{}"` 存成永久已批准偏好（`observer.js`）
- **自动批准不再永生**：自动批准的模式标记 `autoApproved`，仍受遗忘曲线剪枝；只有 durable 与"人工批准"的模式永久保留（`index.js`、`pattern-detector.js`）
- **usage 路径补剪枝**：`recordUsage` 也调用 `pruneMemory()` 并在剪枝后重算快照；此前仅 turn flush 路径剪枝，高 usage/低 turn 会话会堆到上限（`index.js`）
- **flush 顺序**：先 `pruneMemory()` 再取 `all()` 传给 skill/advisor，避免本轮注入刚被剪掉的模式（`observer.js`）
- **isUsageFailure**：改为显式失败状态黑名单，`succeeded`/`stopped`/`finished` 等良性状态不再误生成 `usage:failed_request`（`helpers.js`）
- **工作流加分持久化**：正反馈/采纳奖励记入 `bonus`，ingest 用 `count*3 + bonus` 计分；此前 `Math.max(score, count*3)` 会随 count 增长吞掉奖励（`pattern-detector.js`、`observer.js`）
- **code_patch 提案 ID**：仅按 `pattern.id` 哈希，advisor 改写 fix 文案不再生成新提案，已拒绝的提案保持抑制（`proposals.js`）
- **跨消息纠正检测**：信号扫描窗口扩到 1000 字，存储仍截断到 300；此前 300 字截断会丢掉后续消息里的弱信号（`helpers.js`）
- SKILL.md 头部计数文案修正（轮数 vs 模式数）；两轮共新增 8 项回归测试（总计 128 项）

## 0.8.0

- 降噪：`maybeProposeCodeImprovements` 跳过 `approved` 模式，已处理过的 error/usage 不再重复提案
- 此前 v0.7.7~v0.7.9 的累积改进合并：错误分类细化（9 类+可重试区分）、model advisor 高风险→提案、usage:failed_request 过滤、advisor 间隔 180→60min

## 0.7.9

- 降噪：`usage:failed_request:*` 模式不再生成 code_patch 提案（网络问题非代码缺陷）

## 0.7.8

- model advisor 高风险建议自动转化为 code_patch 提案：低/中风险走 pattern.fix merge 路径流入技能文本，高风险生成可审查的 code_patch 并通知用户
- 消除 model advisor 输出与 proposal 系统的脱节

## 0.7.7

- 错误分类细化：`classifyError` 新增 `command_not_found`、`syntax_error`、`path_error` 三个细分类型，`tool_error` 增加退出码匹配
- `PatternDetector.ingestError` 根据错误类型区分可重试/不可重试，非可重试错误（权限拒绝、命令不存在、语法/路径错误等）明确禁止盲目重试
- 生成 skill 的安全部分改写为三级重试策略（不可重试/可重试/未知）

## 0.7.6

- 性能:`pruneProposals` 增加廉价的文件计数门槛,稳态(≤40 个提案)直接跳过解析全部 JSON 的扫描——消除上一版给提案写入热路径带来的开销
- 性能:`self_learning_search` 的 relation boost 用预建的 id→pattern Map 替代每条关系边的线性 `find`,评分复杂度从 O(候选×边×模式) 降到 O(候选×边)
- 性能:`buildSkillMdFromPatterns` 的超预算裁剪改为增量 token 记账(按字符可加的 `rawTokens` + 删除行时减去其代价),避免每删一行就重算整篇文档的 O(n²) 行为
- 新增裁剪路径测试(common 106 项)

## 0.7.5

- proposals 目录保留上限：终态提案（applied/rejected）按时间保留最近 40 个，旧的自动清理（每次 skill 刷新会产生新的 content-hash `applied` 提案，此前会无限堆积）；pending 提案为可操作项，始终保留
- 新增保留上限测试（proposals 105 项）

## 0.7.4

- 修复用量统计随重启重复累加：去重的 requestId 集合现持久化到 `usage_seen.json`，启动 bootstrap 不再把上次已计入 `usage_summary.json` 的请求重复计数
- 裁剪逻辑统一到 `PatternDetector.pruneMemory()`：移除 `pruneDataFiles` 中被即时覆盖的无效 patterns.json 重写（消除磁盘抖动与内存/磁盘不一致），并把 durable 偏好的数量上限并入 detector
- 持久化去抖：忙会话中的 patterns.json 写入合并为每 ~1.5s 最多一次，onunload 强制落盘
- `persistPatterns` 写盘前先吸收 control.js 的审批状态（`syncDiskStatus`），避免并发覆盖外部 approve/reject
- 模型顾问回写的建议在并入 `fix`/SKILL.md 前进行净化（剥离代码块/标题/角色标记、限长），且不再覆盖用户已 approve 的条目
- 纠正提取增加疑问句过滤，减少把普通提问误存为偏好的噪声
- 主动插入对话的 `workStatusEnabled`、`proposalChatNotificationsEnabled` 默认改为 `false`
- 新增 `tests/model-advisor.test.js`（8 项）：锁定「偏好/durable 不外发」过滤、限流门槛、`normalizeBaseUrl`；测试总数 96 → 104

## 0.7.3

- 隐私默认更保守：`modelAdvisorEnabled` 默认改为 `false`，模型顾问需用户显式开启才会外发数据
- 模型顾问候选过滤：`preference` 与 `durable` 模式（用户纠正原文、`pin_memory` 内容）不再进入发往外部小模型的 prompt，仅用于本地检索与注入
- `writeJson` 改为原子写（临时文件 + rename），避免并发工具/多实例读到半写入的 `patterns.json` / `config.json`
- README 新增「隐私」章节，集中披露读取的本地文件、本地留存内容、保留时长与外发条件

## 0.7.2

- `PatternDetector` 提取为独立模块 `lib/pattern-detector.js`，可独立测试
- 分类常量与函数 (`TASK_SIGS`/`ERR_PATTERNS`/`CORRECTION_*`/`classifyTask`/`classifyError`/`extractCorrectionFromUserText`) 迁移至 `lib/helpers.js`
- 新增 48 项测试：PatternDetector 26 项 + flushTurn 集成管道 22 项（SessionTurn 生命周期→错误分类→纠正提取→任务分类→完整三回合管道）
- 测试总数：38 → 86
- 工具函数 `shortHash`、`preferencePatternId`、`stableKey`、`isUsageFailure` 迁移至 `lib/helpers.js`
- `pin_memory` 偏好初始评分从 10 降至 5，避免一次性 pin 操作与长期验证偏好等权
- 新增 adoption 降级机制：搜索后 3 轮内未采纳的工作流执行 -1 衰减，防止自我强化回路
- SKILL.md token 裁剪策略从"整节删除"改为"逐条裁剪"，保留高分条目
- 修复 `modelAdvisorMinIntervalMinutes` 默认值不一致（60→180），与 manifest 和 README 同步

## 0.7.0

- 官方记忆桥接（official-memory-bridge）：只读接入 Hanako 官方记忆，搜索时自动纳入
- 改进提案引擎（proposals）：基于模式分析自动生成改进提案，支持审核与应用
- 工具层增强：control 提案管理、search 多路加权检索升级、stats/report/activity 功能完善
- README 重写，项目结构说明更新
- 新增 official-memory-bridge 和 proposals 测试覆盖

## 0.6.1

- 修复 `PatternDetector.restore` 与 `ingest` 中 seqCache key 不一致（Unicode `→` vs ASCII `->`），恢复的旧 workflow 不再丢失计数
- 修复 `PatternDetector.all()` 对 `error:tool_error` 的静默过滤，错误 pattern 现在正常持久化和注入
- 修复 `CORRECTION_PATTERNS` 中"不是"过度匹配所有中文否定句的问题，改为"不应该"
- 修复 `pruneDataFiles` 丢弃无 `date` 字段日志行的问题
- 修复 `persistPatterns` 与 `control.js` approve/reject 的磁盘/内存竞态——persistPatterns 写入前合并磁盘上的 status 字段
- config 在每次 flushTurn 时从磁盘重新加载，`set_config` 不再需要重启生效
- `model-advisor.js` fetch 加 30 秒超时控制
- usage boostrap 与实时订阅加 `requestId` 去重，避免计数重复
- `package.json` scripts.check 移除不存在的 `install.cjs`

## 0.6.0

- 知识树关系：`_linkRelations` 基于类别重叠和任务类型自动建立模式关联
- 反馈回路：`self_learning_search` 结果自动提升被搜索模式评分；`pin_memory` 内容作为偏好模式注入
- 采纳追踪：搜索返回的工作流模式在后续 3 轮中被 Agent 实际使用时自动加分
- Activity Log：所有模式发现、错误检测、会话摘要写入 `activity_log.jsonl`
- Model Advisor：小模型后台整理，支持官方/私有模型两种来源
- 艾宾浩斯遗忘曲线：`memoryStrength` 替代简单半衰期衰减，高频模式遗忘更慢
- Category-level 工作流检测：按工具类别而非原始工具名聚合，减少误匹配
- 数据裁剪：基于记忆强度的模式保留策略 + JSONL 日志 30 天窗口
- `definePlugin` / `defineTool` 兼容层

## 0.3.0

- 首个发布版本（三层管道：观察→学习→注入）
