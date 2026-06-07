# Runtime Self-Learning

不会装？先看 [`INSTALL.md`](./INSTALL.md)。

**让 Hanako 从自己的运行日志里学东西。** 自动发现你重复做的工作流、常犯的错误、口头纠正过的偏好，下次对话时提醒 Agent 不要再踩同样的坑。

## 一句话解释

Hanako 每次对话都是无状态的。同一个错误可能重复犯，同样的流程每次都要从头描述。这个插件给它加了一层本地长期记忆——不需要你手动 `pin_memory`，它自己从工具调用序列里找规律。

## 怎么工作的

```
对话进行中 → EventBus 监听工具调用 → 会话结束触发学习 →
→ 检测跨类别工作流 + 错误模式 + 你的纠正语句 →
→ 艾宾浩斯遗忘曲线评分（重复越多的记得越牢）→
→ Agent 需要时用 self_learning_search 检索相关经验
```

**不占 token。** 学习到的模式存在本地，Agent 按需搜索，每次只注入几条相关的。存的越多，检索越准，但注入量不变。

## 装

```powershell
git clone https://github.com/326sun/hanako-runtime-learner.git
cd hanako-runtime-learner
npm run install-plugin
```

## 工具（Agent 可调用）

| 工具 | 做什么 |
|------|--------|
| `self_learning_search` 查询 | 按关键词搜经验（文本 + 上下文 + 关系 + 记忆四路加权） |
| `self_learning_activity` | 最近学了什么 |
| `self_learning_stats` | 学了多少、可注入几条 |
| `self_learning_report` | N 天学习报告 |
| `self_learning_control` | 批准/拒绝某条经验、调参数、回滚 |
| `self_learning_open_dir` | 打开数据目录 |

## 测试

```powershell
npm run test        # 25 个单元测试（衰减算法、注入判断、搜索评分）
```

## 配置要点

| 参数 | 默认 | 说明 |
|------|------|------|
| 自动注入 | 开 | 高置信经验自动可用，低分需手动批 |
| 自动批准 | 开 | 高置信模式无需人工审批 |
| 记忆半衰期 | 30 天 | 超过此天数分数减半，不活跃的经验自动遗忘 |
| 后台整理 | 开 | 用小模型定期分析经验，生成结构化建议 |

## 与官方记忆的关系

- **官方记忆**（`pin_memory`）：你说"记住这个"，它记住。适合明确的重要事实。
- **本插件**：你不用说，它自己看。适合重复模式、常见错误、隐性偏好。

两者互补。而且你 `pin_memory` 的内容会自动被本插件吸收，搜索时一起找到。

## 数据

所有数据在 `~/.hanako/self-learning/`，不离开你的电脑。30 天自动清理过期日志。

## 卸

删 `~/.hanako/plugins/hanako-runtime-learner/`，重启。学习数据在 `~/.hanako/self-learning/` 单独可删。

MIT
