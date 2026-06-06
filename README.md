# Runtime Self-Learning

A local, optional self-learning runtime for the [Hanako](https://github.com/liliMozi/openhanako) desktop app.

## What It Does

This plugin adds a three-layer self-learning pipeline that runs entirely on your
machine. It observes how you and Hanako work together, learns from repeated
patterns and mistakes, and injects conservative skill hints to improve future
sessions.

### Three Layers

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: OBSERVE                                     │
│ Listen to Hanako runtime events (tool calls, errors, │
│ assistant completions, user corrections)             │
└────────────────────────┬────────────────────────────┘
                         │ turns.jsonl / error_log.jsonl
                         ▼
┌─────────────────────────────────────────────────────┐
│ Layer 2: LEARN                                       │
│ PatternDetector identifies:                          │
│ • Repeated workflows (same tool sequence ≥3×)        │
│ • Recurring errors (same failure mode ≥2×)           │
│ • User corrections (explicit "no, do it this way")   │
└────────────────────────┬────────────────────────────┘
                         │ patterns.json
                         ▼
┌─────────────────────────────────────────────────────┐
│ Layer 3: INJECT                                      │
│ High-confidence patterns → SKILL.md hints            │
│ Configurable thresholds: score, count, half-life     │
│ Manual review: approve / reject / rollback           │
└─────────────────────────────────────────────────────┘
```

**This is a Phase 2 learner, not an uncontrolled self-modifying agent.**
It only updates its own plugin skill file and local logs. Learned hints are
treated as suggestions and never override the current user instruction.

## Install

```powershell
git clone https://github.com/326sun/runtime-learner.git
cd runtime-learner
npm run install-plugin
```

Then restart Hanako and enable from **Settings → Plugins**:

1. Toggle **Allow full-access plugins**
2. Enable **Runtime Self-Learning**

The plugin requires zero external dependencies (Node.js built-in modules only).

## Tools

| Tool | Description |
|------|-------------|
| `self_learning_stats` | View learning statistics: turns, patterns, injectable hints, review states |
| `self_learning_report` | Generate a report for the last N days: task trends, error distribution, pending reviews |
| `self_learning_control` | Approve/reject patterns, update injection config, regenerate skill, roll back |

### Control Actions

| Action | Description |
|--------|-------------|
| `status` | Show current config, pattern counts, snapshot history |
| `list` | List top 20 patterns with scores and injectable status |
| `approve` | Approve a pattern (forces injection) |
| `reject` | Reject a pattern (permanently excluded) |
| `set_config` | Update injection thresholds, decay rate, preference inclusion |
| `regenerate_skill` | Force-regenerate the SKILL.md from current patterns |
| `rollback` | Roll back SKILL.md to the latest snapshot |

## Data

All learning data stays local under `~/.hanako/self-learning/`:

| File | Content |
|------|---------|
| `turns.jsonl` | Compact runtime turn records |
| `experience_log.jsonl` | Structured learning records with task classification |
| `error_log.jsonl` | Tool and assistant error records with severity scoring |
| `patterns.json` | Learned workflows, errors, and preferences with decayed scores |
| `config.json` | Injection thresholds (score, count, half-life) and review settings |
| `skill_history/` | Timestamped SKILL.md snapshots for rollback |

No data leaves your machine. No telemetry. No cloud sync.

## How Patterns Work

Each detected pattern has a **score** that decays over time. The default half-life
is 30 days — a pattern loses half its score every 30 days without recurrence.

A pattern becomes **injectable** when:

- Score ≥ `minInjectScore` (default: 8)
- Repeat count ≥ `minInjectCount` (default: 2)
- Status is not `rejected`

**Preference-type** patterns (user corrections like "do it this way") are
injected immediately if `includePendingPreferences` is enabled (default: `true`).

You can change all thresholds via `self_learning_control` → `set_config`.

## Safety Boundary

- The plugin only writes to `~/.hanako/self-learning/` and its own
  `skills/self-learning/SKILL.md`
- It does **not** modify Hanako source files, settings, or `app.asar`
- Learned hints are injected as reminders in the skill file, not as hard
  constraints — the agent is instructed to prefer current user instructions
- You can disable automatic high-confidence injection at any time
- You can delete `~/.hanako/plugins/runtime-learner/` to fully uninstall;
  the learning data directory is separate and can be deleted independently

## Uninstall

Delete `~/.hanako/plugins/runtime-learner/` and restart Hanako.

To also remove all learning data:

```powershell
rm -r ~/.hanako/self-learning/
```

## Contributing

This plugin is part of the [`hanako-supplement`](https://github.com/326sun/hanako-supplement)
monorepo. Contributions are welcome:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Commit your changes (`git commit -m 'feat: description'`)
4. Push to the branch (`git push origin feat/your-feature`)
5. Open a Pull Request

Before submitting, run:

```powershell
npm run check
```

The plugin source is ESM (`.js` with `"type": "module"` in `package.json`).
The install script uses CommonJS (`.cjs` extension).

### Project Structure

```
runtime-learner/
├── install.cjs          # Plugin installer (CommonJS)
├── package.json         # ESM declaration (zero external dependencies)
├── manifest.json        # Hanako plugin manifest
├── index.js             # Plugin entry point: EventBus subscription, PatternDetector, skill injection
├── lib/
│   └── common.js        # Shared utilities: scoring, decay, injection logic
├── tools/
│   ├── stats.js         # Agent tool: learning statistics
│   ├── report.js        # Agent tool: N-day learning report
│   └── control.js       # Agent tool: approve, reject, configure, rollback
└── skills/
    └── self-learning/
        └── SKILL.md     # Auto-generated skill hints (updated by the plugin at runtime)
```

### Extending

To add new pattern types:

1. Define a new pattern category in `PatternDetector.ingest()` in `index.js`
2. Add any new scoring logic to `lib/common.js`
3. Update `buildSkillMd()` to format the new pattern type in the generated skill
4. Update `self_learning_control` and `self_learning_report` if the new pattern
   needs different review or reporting behavior

To add new tools:

1. Create a new file in `tools/` with `export const name`, `description`,
   `parameters`, and `async function execute()`
2. Import shared utilities from `../lib/common.js`
3. The Hanako agent automatically discovers tools from the `tools/` directory

## License

MIT
