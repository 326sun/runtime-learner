# Changelog

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
