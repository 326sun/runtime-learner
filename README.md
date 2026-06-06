# Runtime Self-Learning

[Hanako](https://github.com/liliMozi/openhanako) 桌面应用的本地自学习运行时。

## 功能

此插件为 Hanako 增加一个完全运行在本地的三层自学习管道。
它观察你与 Hanako 的协作方式，从重复模式与错误中学习，
并注入保守的技能提示以改善后续会话。

### 三层架构

```
┌─────────────────────────────────────────────────────┐
│ 第一层：观察（OBSERVE）                               │
│ 监听 Hanako 运行时事件（工具调用、错误、               │
│ 助手完成、用户纠正）                                   │
└────────────────────────┬────────────────────────────┘
                         │ turns.jsonl / error_log.jsonl
                         ▼
┌─────────────────────────────────────────────────────┐
│ 第二层：学习（LEARN）                                  │
│ PatternDetector 识别：                                │
│ · 重复工作流（同一工具序列出现 ≥3 次）                   │
│ · 重复错误（同一失败模式出现 ≥2 次）                     │
│ · 用户纠正（明确的"不对，这样做"指令）                   │
└────────────────────────┬────────────────────────────┘
                         │ patterns.json
                         ▼
┌─────────────────────────────────────────────────────┐
│ 第三层：注入（INJECT）                                 │
│ 高置信度模式 → SKILL.md 提示                          │
│ 可配置阈值：分数、次数、半衰期                          │
│ 人工审核：批准 / 拒绝 / 回滚                            │
└─────────────────────────────────────────────────────┘
```

**这是一个第二阶段学习器，而非不受控的自修改 Agent。**
它只更新自己的插件技能文件和本地日志。学习到的提示被视为建议，
永远不会覆盖当前用户指令。

## 安装

```powershell
git clone https://github.com/326sun/runtime-learner.git
cd runtime-learner
npm run install-plugin
```

重启 Hanako，在 **设置 → 插件** 中：

1. 打开 **允许全权限插件**
2. 启用 **Runtime Self-Learning**

插件零外部依赖（仅使用 Node.js 内置模块）。

## 工具

| 工具 | 说明 |
|------|------|
| `self_learning_stats` | 查看学习统计：轮次、模式数、可注入提示数、审核状态 |
| `self_learning_report` | 生成最近 N 天的学习报告：任务趋势、错误分布、待审核项 |
| `self_learning_control` | 批准/拒绝模式、更新注入配置、重新生成技能、回滚 |

### 控制指令

| 指令 | 说明 |
|------|------|
| `status` | 显示当前配置、模式数量、快照历史 |
| `list` | 列出 Top 20 模式及其分数和可注入状态 |
| `approve` | 批准一个模式（强制注入） |
| `reject` | 拒绝一个模式（永久排除） |
| `set_config` | 更新注入阈值、衰减速率、偏好纳入策略 |
| `regenerate_skill` | 从当前模式强制重新生成 SKILL.md |
| `rollback` | 将 SKILL.md 回滚到最近一次快照 |

## 数据

所有学习数据存储于 `~/.hanako/self-learning/`：

| 文件 | 内容 |
|------|------|
| `turns.jsonl` | 紧凑的运行时轮次记录 |
| `experience_log.jsonl` | 结构化学习记录，含任务分类 |
| `error_log.jsonl` | 工具与助手错误记录，含严重度评分 |
| `patterns.json` | 学习到的工作流、错误和偏好，含衰减分数 |
| `config.json` | 注入阈值（分数、次数、半衰期）与审核设置 |
| `skill_history/` | 带时间戳的 SKILL.md 快照，用于回滚 |

数据不离开你的机器。无遥测。无云同步。

## 模式工作机制

每个检测到的模式有一个随时间衰减的**分数**。默认半衰期为 30 天——
一个模式每 30 天不复发，分数减半。

模式在满足以下条件时变为**可注入**：

- 分数 ≥ `minInjectScore`（默认：8）
- 重复次数 ≥ `minInjectCount`（默认：2）
- 状态不为 `rejected`

**偏好型**模式（用户纠正类，如"以后这样做"）在
`includePendingPreferences` 启用时（默认启用）立即注入。

所有阈值均可通过 `self_learning_control` → `set_config` 调整。

## 安全边界

- 插件仅写入 `~/.hanako/self-learning/` 和自身的 `skills/self-learning/SKILL.md`
- **不会**修改 Hanako 源文件、设置或 `app.asar`
- 学习到的提示作为技能文件中的提醒注入，而非硬约束——Agent 被指示优先遵循当前用户指令
- 可随时禁用高置信度自动注入
- 删除 `~/.hanako/plugins/runtime-learner/` 即可完全卸载；
  学习数据目录独立存放，可单独删除

## 卸载

删除 `~/.hanako/plugins/runtime-learner/` 并重启 Hanako。

如需同时删除所有学习数据：

```powershell
rm -r ~/.hanako/self-learning/
```

## 参与贡献

此插件属于 [`hanako-supplement`](https://github.com/326sun/hanako-supplement) 系列。
欢迎提交贡献：

1. Fork 本仓库
2. 创建特性分支（`git checkout -b feat/你的特性`）
3. 提交修改（`git commit -m 'feat: 简短描述'`）
4. 推送到分支（`git push origin feat/你的特性`）
5. 发起 Pull Request

提交前请运行：

```powershell
npm run check
```

插件源码使用 ESM（`.js` 文件配合 `package.json` 中的 `"type": "module"`），
安装脚本使用 CommonJS（`.cjs` 扩展名）。

### 项目结构

```
runtime-learner/
├── install.cjs          # 插件安装器（CommonJS）
├── package.json         # ESM 声明（零外部依赖）
├── manifest.json        # Hanako 插件清单
├── index.js             # 插件入口：EventBus 订阅、PatternDetector、技能注入
├── lib/
│   └── common.js        # 共享工具函数：计分、衰减、注入逻辑
├── tools/
│   ├── stats.js         # Agent 工具：学习统计
│   ├── report.js        # Agent 工具：N 日学习报告
│   └── control.js       # Agent 工具：批准、拒绝、配置、回滚
└── skills/
    └── self-learning/
        └── SKILL.md     # 自动生成的技能提示（插件运行时更新）
```

### 扩展开发

新增模式类型：

1. 在 `index.js` 的 `PatternDetector.ingest()` 中定义新模式类别
2. 在 `lib/common.js` 中添加新的计分逻辑
3. 在 `buildSkillMd()` 中格式化新模式类型的输出
4. 如新模式需要不同的审核或报告行为，更新 `self_learning_control` 和
   `self_learning_report`

新增工具：

1. 在 `tools/` 下新建文件，导出 `name`、`description`、`parameters` 和
   `async function execute()`
2. 从 `../lib/common.js` 导入共享工具函数
3. Hanako Agent 自动从 `tools/` 目录发现新工具

## 许可证

MIT
