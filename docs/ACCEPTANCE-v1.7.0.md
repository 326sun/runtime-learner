# Acceptance Report v1.7.0

## 环境

| 项 | 值 |
|---|---|
| Node | v24.15.0 |
| 系统 | Windows 11 (10.0.26200) |
| Hanako | v0.293+ |
| 架构 | x64 |

## 语法检查

```
npm run check
```

40 个 JS 文件全部通过 `node --check`。

## 测试

```
npm test
```

| 指标 | 值 |
|---|---|
| 测试文件 | 24 |
| 测试用例 | 264 |
| 通过 | 264 |
| 失败 | 0 |
| 耗时 | ~420ms |

## 安装

```
npm run install-plugin
```

- [1/4] 语法检查：40 文件 OK
- [2/4] 清理旧版：已移除
- [3/4] 复制：`C:\Users\24089\.hanako\plugins\hanako-runtime-learner`
- [4/4] 校验：40 文件全部就位，manifest.json 合法，版本 1.7.0 一致

## 运行时工具验证

| 工具 | 结果 |
|---|---|
| `self_learning_stats` | ✅ 返回 2776 turns / 22 patterns / 3445 requests |
| `self_learning_doctor` | ✅ 只读诊断正常 |
| `self_learning_search` | ✅ 作用域感知检索正常 |
| `self_learning_activity` | ✅ 活动时间线正常 |
| `self_learning_control` | ✅ status/list/proposals 正常 |
| `self_learning_open_dir` | ✅ 打开数据目录 |
| `self_learning_report` | ✅ 结构化报告生成 |

## 代码规模

| 指标 | v1.6.0 | v1.7.0 |
|---|---|---|
| lib 文件 | 29 | 28 |
| tools 文件 | 8 | 9 |
| index.js 行数 | 864 | 788 |
| 总行数 | ~6,750 | ~7,192 |
| 测试用例 | 241 | 264 |

## 已知问题

- 2 个待处理 `code_patch` 提案（高风险，需人工审批，不会自动写代码）
- `modelAdvisorEnabled` 当前为 `true`，会将归纳后的 workflow/error/usage 模式发往 deepseek-v4-flash。该状态为用户本机运行配置，不代表插件默认配置；插件默认 `modelAdvisorEnabled=false`
