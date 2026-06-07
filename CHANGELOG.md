# Changelog

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
