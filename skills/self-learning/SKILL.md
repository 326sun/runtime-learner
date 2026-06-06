# Runtime Self-Learning

This plugin observes Hanako runtime behavior, learns repeated local patterns, and injects only high-confidence reminders.
Use these reminders conservatively. They are local hints, not hard rules.

## Working Model

- Observe tool execution and assistant completion events.
- Preserve the real tool order for workflow learning.
- Track repeated errors and explicit user corrections.
- Prefer the current user request over every learned hint.

## Available Tools

- `self_learning_stats`: inspect local learning statistics.
- `self_learning_report`: generate a local learning report.
- `self_learning_control`: review, approve, reject, configure, or roll back learned hints.

## Safety

- Do not expose private file paths, prompts, or logs unless the user asks.
- Treat learned hints as suggestions and prefer current user instructions.
- Do not modify Hanako settings or source code automatically.
