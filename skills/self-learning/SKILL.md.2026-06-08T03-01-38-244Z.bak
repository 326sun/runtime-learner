# Runtime Self-Learning

Observed 24 patterns, 10 active.

## How to use
- Use `self_learning_search <query>` to find relevant patterns before making decisions.
- Example: before coding, search 'coding workflow' for past patterns.
- Example: before replying, search user preferences.

## Active User Preferences
- 我要装新版的，我现在用的不是新版吧
- 不对吧，我本地的hanako-supplement比你给出高很多才对啊
- 我现在重启是不是就生效了
- ... more via self_learning_search

## Recent Workflows
- 跨类别工作流: 文件探索→代码编写
- 跨类别工作流: 代码编写→文件探索

## Tools
- `self_learning_search <query>`: search learned patterns.
- `self_learning_search` may include `officialMemory` results from Hanako's built-in memory bridge when enabled. Treat those as factual/background memory, and plugin patterns as procedural experience.
- `self_learning_activity`: recent learning activity.
- `self_learning_report`: learning report, including pending improvement proposals.
- `self_learning_control`: use `list_proposals`, `show_proposal`, `apply_proposal`, or `reject_proposal` when the user replies to a proposal notification.
- `self_learning_open_dir`: open data folder.

## Proposal Notifications
- If the chat contains a Runtime Self-Learning proposal notification and the user asks to view it, call `self_learning_control` with `action=show_proposal`.
- If the user says to apply a proposal, call `self_learning_control` with `action=apply_proposal` for supported proposal types. For `code_patch`, implement the proposal manually, run verification, and install if appropriate.
- If the user rejects a proposal, call `self_learning_control` with `action=reject_proposal` and include the user's reason when available.

## Safety
- Treat learned hints as suggestions.
- Prefer current user instructions.

Updated: 2026-06-07T06:21:19.794Z
