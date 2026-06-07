# Runtime Self-Learning

不会安装时先看 [`INSTALL.md`](./INSTALL.md)。

Hanako 桌面应用的本地自学习运行时插件。观察交互习惯，归纳重复模式和用户偏好，按需检索而非全量注入，控制 token 开销。

## 为什么做

Hanako 每次对话都是无状态的——同一个错误可能重复犯，同样的工作流每次都要从头描述，用户的偏好说了就忘。这个插件给 Hanako 加了一层本地长期记忆，让它能从自己的运行日志中提取可复用的经验。

最初只是一个被动日志（v0.1），现在已经演进为三层主动学习管道：观测（EventBus）→ 学习（分类检测 + 艾宾浩斯遗忘曲线 + 模型整理）→ 注入（按需检索 + 保守提示）。

## 与 Hanako 官方记忆的区别

官方记忆（`pin_memory` / `search_memory`）提供手动触发、永久保留的键值存储。它的设计前提是"你告诉它该记什么"——适合你明确要求"记住这件事"的场景。

本插件填补的是另一个需求：**不需要你主动说，它自己从运行日志里找规律**。两者的差异不在于"谁更能存"，而在于触发方式、去噪策略、检索效率三个维度：

| | 官方记忆 | Runtime Self-Learning |
|---|---|---|
| 触发方式 | 用户手动 pin | EventBus 自动观测 |
| 内容来源 | 用户显式指令 | 工具调用序列、错误、纠正语句 |
| 存储策略 | 永久保留 | 艾宾浩斯遗忘曲线 + 低分衰减淘汰 |
| 检索方式 | 文本关键词 | 文本+上下文+类别+关系四路加权 |
| 去噪机制 | 无 | 跨类别过滤、错误分类、遗忘淘汰 |
| 与 Agent 的交互 | 注入系统提示 | 按需 search，不占用上下文窗口 |

两者互补而非竞争。重要事实用官方记忆手动 pin，重复模式和偏好交给本插件自动学习。

## 设计要点

**按需检索，不占 token。** 学习到的模式存在本地图结构中，对话时通过 `self_learning_search` 按关键词、类型、上下文检索，只注入相关的几条。模式越多，检索越有价值，但每次注入量不变。

**遗忘曲线保真去噪。** 基于艾宾浩斯遗忘规律的记忆强度模型：重复越多、时间越近的模式权重越高；低分模式自动衰减淘汰；approved 模式永久保留。避免无效模式堆积占用存储和检索质量。

**后台小模型整理。** 启用 `modelAdvisor` 后，用小模型定期分析沉淀的模式，生成结构化的归纳建议替代原始用户文本。不需要大模型参与，利用 Hanako 自带的 utility model 即可。

**跨类别工作流检测。** 工具序列按 8 个语义类别归类（文件探索、代码编写、网络研究等），只有跨 ≥2 个类别的序列才会被记录为工作流模式——过滤掉单步操作噪音。

**零外部依赖。** 仅使用 Node.js 内置模块（fs、path、os），不安装任何第三方包。

## 安装

```powershell
git clone https://github.com/326sun/hanako-runtime-learner.git
cd hanako-runtime-learner
npm run install-plugin
```

## 工具

| 工具 | 说明 |
|------|------|
| `self_learning_search` | 按关键词、类型、任务上下文搜索模式（文本+上下文+关系+记忆四路加权） |
| `self_learning_activity` | 最近学习活动时间线 |
| `self_learning_stats` | 运行时统计：轮次、模式、可注入数 |
| `self_learning_report` | N 日学习报告 |
| `self_learning_control` | 审批、配置、回滚 |
| `self_learning_open_dir` | 打开数据目录 |
| `self_learning_chart` | 每日 Token 消耗柱状图（SVG，由宿主 skill 层提供） |

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoInjectHighConfidence` | boolean | true | 自动注入高置信提示 |
| `autoApproveHighConfidence` | boolean | true | 自动批准（无需手动审批） |
| `minInjectScore` | number | 8 | 注入最低评分 |
| `minInjectCount` | number | 2 | 注入最少重复次数 |
| `decayHalfLifeDays` | number | 30 | 记忆半衰期 |
| `includePendingPreferences` | boolean | true | 未审核偏好也参与注入 |
| `learnFromUsage` | boolean | true | 从 LLM 用量中学习 |
| `modelAdvisorEnabled` | boolean | true | 启用后台整理 |
| `modelAdvisorSource` | string | official | 整理模型（official / private / off） |
| `workStatusEnabled` | boolean | true | 显示工作状态 |

设置页面中带 📊 📁 🧠 图标的展示字段为运行时只读数据，由插件动态更新，非用户可编辑配置。

## 数据

所有数据存储于 `~/.hanako/self-learning/`，不离开本地。

| 文件 | 内容 |
|------|------|
| `patterns.json` | 图结构模式（含 context、relations） |
| `experience_log.jsonl` | 结构化学习记录 |
| `turns.jsonl` | 紧凑轮次记录 |
| `error_log.jsonl` | 工具错误记录 |
| `activity_log.jsonl` | 学习活动时间线 |
| `skill_history/` | SKILL.md 快照（最多 20） |

所有日志文件保留 30 天，自动清理。

## 卸载

删除 `~/.hanako/plugins/hanako-runtime-learner/`，重启。学习数据在 `~/.hanako/self-learning/`，可单独删除。

## 许可证

MIT
