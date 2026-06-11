# Changelog

## 4.3.0 LTS

- **API Freeze finalized**: `docs/API_FREEZE.md` updated to v4.3.0; added Self-Learning Control API to frozen contracts; added v4.0–v4.3 version history table and updated LTS rules (10 rules including v4.1 security additions).
- **Architecture document rewritten**: `ARCHITECTURE.md` updated from v2.7-era state to current v4.3.0 (81 modules in 6 subsystem groups, key design decisions, no more references to deleted files).
- **README rewritten for clarity**: restructured into a layered document — value proposition plus an automatic/governed/never boundary table for the learn → evolve → execute loop for end users; architecture, tool API, and frozen-docs reference for developers. Per-version hardening notes that had accumulated in the README were moved into this changelog. All release-readiness badge / clone-branch / test-count strings preserved.
- **CI fixture fix**: `tests/release-readiness.test.js` `makeProject` now also generates `README.md` and `manifest.json`, so the "coherent project" fixture satisfies the README-badge and manifest-version checks shipped in this release; the CI matrix (Node 22/24) was failing on the two stale `ready`/`blocked` assertions.
- **Code quality (carried)**: 81 lib modules, 496 tests, 17 benchmark scenarios, 40+ control actions.
- **Tests**: 496 passing; benchmark corpus 17/17; release readiness score 100.
- **Safety boundary preserved**: no runtime, automation, or security-boundary changes; the only non-documentation change is a test-fixture fix.
- **v4.x LTS commitment**: v4.3.0 marks roadmap completion. Future v4.x releases are maintenance-only.

## 4.2.0 LTS

- **Performance**: `decoratePatterns()` unified filter+decorate into a single pass, eliminating the intermediate filtered-array allocation in `PatternDetector.all()` (the hottest read path, called 1–2× per flush). Added optional `mutate` mode for callers that don't need cache isolation.
- **Performance (carried)**: `observer.js` `getTurn()` LRU eviction changed from O(n log n) `sort()` to O(n) linear scan over ≤64 sessions.
- **Code quality (carried)**: merged 6 single-consumer micro-modules (87 → 81 lib files); centralized `nowIso()` to `common.js`.
- **Tests**: 496 passing; benchmark corpus 17/17; release readiness score 100.
- **Safety boundary preserved**: no R4, external side-effect, or auto-execution surface widened.

## 4.1.0 LTS

- **v4.1.1 Project Script Trust Gate**: `command-allowlist.js` now records project script trust decisions (executed/rejected) in the audit event log when `learnerDir` is available; `trust_project_scripts` control action added so users can approve the current `package.json` scripts hash through `self_learning_control` instead of editing config manually.
- **v4.1.2 Filesystem Boundary Ancestor Realpath**: already implemented during v4.0.x hardening (workspace root realpath resolution, nearest-existing-parent checks, symlink escape prevention); confirmed with dedicated test suite `tests/filesystem-boundary-final-audit.test.js`.
- **v4.1.3 URL Redaction and HTTP Warning**: already implemented during v4.0.x (`audit-bundle.js` `redactUrl()` returns origin only; `model-advisor.js` `advisorEndpointWarning()` warns on non-local HTTP endpoints).
- **Code simplification (continued)**: merged 6 single-consumer micro-modules into their consumers (87 → 81 lib files); centralized `nowIso()` to `common.js` (3 duplicate definitions eliminated).
- **Performance**: `observer.js` `getTurn()` LRU eviction changed from O(n log n) `sort()` to O(n) linear scan over ≤64 sessions.
- **Install fix**: `install.cjs` JS_FILES list updated from 38 v2.7-era entries to the full 87-module v4.1 surface; removed reference to deleted `rank-fusion.js`.
- **Version consistency**: `manifest.json` version synced with `package.json`.
- **Tests**: 496 passing; benchmark corpus 17/17; release readiness score 100.
- **Safety boundary preserved**: all v4.0 LTS governance boundaries maintained; no R4, external side-effect, or auto-execution surface widened.

## 4.0.21 LTS

- **Repair path fix**: `executeActionPlan`'s classifier-driven repair called the async `attemptOneRepair` without `await`, so the returned Promise never had `.ok` and the non-explicit repair branch silently never applied a strategy. Explicit `repairPlan` repair was unaffected.
- **Patch fidelity fix**: `applyTextPatch` used `String.replace(oldText, newText)`, which expands `$&`/`$'`/`$$` patterns inside the replacement — a patch whose new text contained `$` sequences wrote corrupted content. Replacement now goes through a callback and is written literally (regression test added).
- **Scope gate boundary fix**: `allowedFiles` matched as a bare suffix (`evil-src/a.js` passed an entry `src/a.js`) and `allowedDirs` as a bare prefix (`src-evil/` passed `src`). Matching now respects path-segment boundaries (regression tests added).
- **Scope gate patch-size fix**: `oldText/newText` action patches are now counted by real payload lines instead of unified-diff markers, so `maxAddedLines` / `maxRemovedLines` cannot be bypassed by ordinary text replacements.
- **Scope gate path hardening**: absolute paths and `..` patch targets are rejected before transaction creation; repository-boundary files such as `.github/workflows/*` now require manual confirmation.
- **Transaction fail-closed**: a failed snapshot read in `createActionTransaction`/`writeTransactionFile` was silently swallowed, letting a later rollback overwrite the file with an empty string; snapshot failures now abort the transaction before any write.
- **skill_patch target hardening**: `verifyProposal` now requires a `skill_patch` target to be a file literally named `SKILL.md`, so a tampered proposal JSON cannot redirect the apply-write to an arbitrary path (regression test added).
- **Atomic write cleanup (continued)**: `proposals.js` (3 hand-rolled tmp+rename blocks plus the non-atomic config_patch write) and `index.js` config writes now use the shared atomic `writeJson()`.
- **Control tool**: `status` action now scans each store once and counts in memory instead of 12 directory re-scans; duplicated package-version readers consolidated.
- **Tests**: 502 → 510 tests (8 new regression tests), 506 pass + 4 symlink skips on Windows.
- **Release readiness**: added `docs/ACCEPTANCE-v4.0.21-LTS.md`, restoring the 17-scenario benchmark corpus and current-version release gate.
- **Safety boundary preserved**: all fixes tighten existing gates; no automation boundary was widened.

## 4.0.20 LTS

- **Windows persistence fix (critical on win32)**: persisted file names for audit traces, agent task states, transfer candidates, and dashboard exports allowed `:` (the NTFS alternate-data-stream separator), so on Windows every save silently failed with `rename EINVAL` and the data was lost. Filename sanitization is now centralized in `safeFileSlug()` (`lib/common.js`) and excludes `:`. Linux/macOS installs that stored files with literal `:` in the name will re-create them under the sanitized name.
- **Atomic write consolidation**: `audit-trace`, `agent-task-store`, `transfer-registry`, `review-queue`, and `audit-dashboard` now reuse the shared atomic `writeJson()` (tmp + rename + cleanup) instead of five hand-rolled copies; dashboard JSON export was previously non-atomic.
- **Windows test fixes**: `tests/benchmark-corpus.test.js` resolved the project root via `URL.pathname`, which produces a broken drive-letter path on win32 (corpus appeared empty); it now uses `fileURLToPath`. Symlink-based filesystem-boundary tests skip cleanly when symlink creation is not permitted.
- **Dead code removal (audit round 4)**: removed 21 unreferenced exports across 15 lib modules, including the placeholder `checkUniqueCandidate`, a broken `verifyRepair` (read a `status` field that `execAsync` never returns), `shouldAcceptRepair`, and the never-used persistence half of `task-state.js`. The synchronized `hana-runtime-compat.js` surface was left untouched.
- **Robustness**: a malformed benchmark scenario JSON file now lands in the corpus `rejected` list instead of crashing `loadBenchmarkCorpus`.
- **Performance**: `appendAuditEvent` no longer deep-clones the entire event history on every append (O(events²) → O(events) per controller run); streaming `message_update` deltas skip re-normalization once the 1000-char assistant-text cap is reached.
- **Tests**: suite unchanged at 502 tests; on Windows 498 pass and 4 symlink tests skip (previously 7 failed on win32).
- **Safety boundary preserved**: no policy gate, scope gate, rollback, R4 automation, external side-effect, release, push, tag, or credential behavior was relaxed.

## 4.0.19 LTS

- **Code audit / simplification round 3**: extracted shared advisor-insight handling into `lib/advisor-insights.js`, removing duplicated proposal/advice merge logic from the runtime entrypoint and control tool.
- **Performance**: manual `run_model_advisor` now builds one pattern id lookup instead of scanning the full pattern array once per suggestion; high-risk advisor proposal generation also reuses the same indexed path for Map/Array pattern sources.
- **Entrypoint cleanup**: `index.js` now delegates repeated code-patch proposal generation and high-risk advisor proposal generation to the shared helper, reducing lifecycle-local branching.
- **Control tool cleanup**: removed a duplicated transfer-candidate validation guard in `tools/control.js`.
- **Tests**: added `tests/advisor-insights.test.js`; total coverage increased from 498 to 502 passing tests.
- **Safety boundary preserved**: no policy gate, scope gate, rollback, R4 automation, external side-effect, release, push, tag, or credential behavior was relaxed.

## 4.0.18 LTS

- **Release Readiness Gate**: added `lib/release-readiness.js` to machine-check the LTS release contract before distribution. It verifies package/package-lock version coherence, current acceptance report, CHANGELOG section, design matrix version, API freeze docs, required LTS docs, benchmark corpus validity, and benchmark baseline/threshold files.
- **CLI + control surface**: added `npm run release:check` and `self_learning_control action=release_readiness` to export `release-readiness.md/json` reports without changing policy, memory, skill, or source files.
- **Benchmark coverage**: added `quality.release_readiness_gate`, increasing the built-in benchmark corpus to 17 passing scenarios.
- **LTS maintenance boundary**: no core architecture changes and no expansion of R4/high-risk automation. This is a release governance hardening patch.
- **Tests**: added `tests/release-readiness.test.js`; total coverage increased from 494 to 498 passing tests.

## 4.0.17 LTS

- **LTS Docs + API Freeze**: added frozen API documents for Action, Policy, Transaction, Sandbox, Skill Promotion, Audit, Benchmarks, and v3→v4 migration.
- **Active Skills Injection Gate**: `active_skills.json` can now be surfaced in rendered `SKILL.md` only through explicit `activeSkillsInjectionEnabled` opt-in, minimum success evidence, regression gating, and `maxSkillTokens` trimming. Default remains off.
- **Benchmark coverage**: added `skill.active_skill_injection_gate` and `render_skill`, increasing the built-in benchmark corpus to 16 passing scenarios.
- **Manifest/config surface**: added active skill injection configuration keys with safe defaults.
- **Release contract**: added `docs/API_FREEZE.md` and `docs/ACCEPTANCE-v4.0.17-LTS.md` as final-candidate evidence.
- **Tests**: expanded `tests/common.test.js`; total coverage increased to 494 passing tests.

## 4.0.16 LTS

- **Audit Dashboard / Report Surface**: added `lib/audit-dashboard.js` to consolidate benchmark reports, Agent Controller task state, audit traces, transfer registry state, skill promotion registries, governance boundaries, and recommended actions into one exportable dashboard.
- **User-readable dashboard exports**: `exportAuditDashboard()` writes `dashboard.json` and `dashboard.md` under `audit-dashboard/<name>/`.
- **Control tool integration**: `self_learning_control` now supports `generate_audit_dashboard` so users can generate the report surface without running ad hoc scripts.
- **Benchmark coverage**: added `audit.dashboard_surface` and `generate_audit_dashboard`, increasing the built-in benchmark corpus to 15 passing scenarios.
- **Safety boundary preserved**: dashboard generation is read-mostly and only writes report artifacts; it does not mutate source code, policy, transfer, skill, or agent state.
- **Tests**: added `tests/audit-dashboard.test.js`; total coverage increased to 492 passing tests.

## 4.0.15 LTS

- **Skill Promotion End-to-End Loop**: added `lib/skill-promotion-loop.js` to wire reflexion memory, failure clustering, skill candidates, action feedback, promotion decisions, effectiveness tracking, decay, and active-skill registry into one conservative pipeline.
- **Candidate persistence**: promotion state is now stored in `skill_candidates.json` with feedback id de-duplication and evidence counters.
- **Active skill registry**: validated candidates can advance to `active_skills.json` without directly mutating `SKILL.md`.
- **Safety boundary preserved**: direct `SKILL.md` writes remain blocked by default; active skills remain registry entries for later review/injection gates.
- **Benchmark coverage**: added `skill.promotion_e2e_loop` and `run_skill_promotion_loop`; exposed the loop through `self_learning_control`, increasing the built-in benchmark corpus to 14 passing scenarios.
- **Tests**: added `tests/skill-promotion-loop.test.js`; total coverage increased to 489 passing tests.

## 4.0.14 LTS

- **Agent Controller recovery branches**: `VerifyNode` / recoverable `ExecuteNode` failures can now route into explicit `RepairNode` or `RollbackNode` graph branches instead of only failing or pausing for human approval.
- **RepairNode execution path**: Controller repair branches can reuse executor repair evidence or execute a guarded `repairActionPlan` / `repairHandler`.
- **RollbackNode evidence path**: Controller rollback branches can validate executor/plugin rollback evidence or call an explicit `rollbackHandler`; they do not recreate transactions without evidence.
- **Verification deferral**: `ExecuteNode` verification envelopes are deferred to `VerifyNode` when the graph contains a verifier, preventing premature human interrupts while preserving fail-closed behavior.
- **Audit trace**: recovery routing now emits `node.recovery_branch` events for report and benchmark inspection.
- **Benchmark coverage**: added `controller.repair_branch` and `controller.rollback_branch`, increasing the built-in benchmark corpus to 13 passing scenarios.
- **Tests**: expanded `tests/agent-controller.test.js`; total coverage increased to 485 passing tests.

## 4.0.13 LTS

- **Plugin Process Isolation**: package-backed plugin `execute.js`, `verify.js`, and `rollback.js` now run in controlled child Node processes instead of being imported into the host runtime process.
- **Child-process guardrails**: added workspace `cwd`, sanitized environment, timeout kill, stdout/stderr byte caps, and structured result propagation for plugin module execution.
- **Execution boundary preserved**: file-backed plugin code still requires explicit `allowPluginCodeExecution: true`; R3/R4 plugin actions still cannot auto-execute.
- **Process metadata propagation**: plugin child-process metadata now surfaces through registry execution and `executeActionPlan()` for audit and benchmark assertions.
- **Benchmark coverage**: added `plugin.process_isolation`, increasing the built-in benchmark corpus to 11 passing scenarios.
- **Tests**: expanded `tests/action-registry.test.js`; total coverage increased to 483 passing tests.

## 4.0.12 LTS

- **Benchmark corpus expansion**: built-in benchmark coverage increased from 5 to 10 scenarios, adding repair, plugin verification, plugin rollback, transfer validation, and Agent Controller human-interrupt cases.
- **Transfer Validation Runner**: added `lib/transfer-validation-runner.js` so transferred memory candidates can run target-project validation commands and record pass/fail evidence in the transfer registry.
- **Evaluation runner extensions**: added `run_agent_controller` and `transfer_validate` benchmark steps plus `$WORKSPACE` placeholder resolution for fixture-local plugin packages and registries.
- **Assertion stability**: `assert_last_result` now keeps pointing to the latest non-assertion step, enabling multiple assertions against one action result.
- **Plugin rollback propagation**: registry-routed plugin action results now preserve rollback details through `executeActionPlan()`, so benchmark and controller layers can inspect rollback outcomes.
- **Tests**: added `tests/transfer-validation-runner.test.js`; total coverage increased to 481 passing tests.

## 4.0.11 LTS

- **Plugin verify execution**: package-backed registered actions now execute `verify.js` after `execute.js` when `allowPluginCodeExecution` is explicitly enabled.
- **Declared verification commands**: `verification.commands` run through the existing sandboxed command allowlist, using only commands declared by the action definition.
- **Structured verification checks**: registry execution now reports output, verify-module, and verify-command checks in a single verification envelope.
- **Plugin rollback execution**: rollback-required plugin actions now invoke `rollback.js` after verification failure or execution exception, and return `reverted` only when rollback succeeds.
- **Execution boundary preserved**: file-backed plugin execute/verify/rollback code still queues for human approval unless plugin code execution is explicitly allowed.
- **Tests**: expanded `tests/action-registry.test.js`; total coverage increased to 479 passing tests.

## 4.0.10 LTS

- **Runtime Action Registry integration**: added `lib/action-registry-runtime.js` so Controller and Executor paths resolve registered non-core actions through a shared runtime registry layer.
- **Executor integration**: `executeActionPlan()` can execute registered plugin/in-memory actions instead of failing as unsupported action types, while non-auto-executable actions are queued rather than silently run.
- **Agent Controller integration**: `PolicyNode` now uses registry metadata for registered non-core actions, and `ExecuteNode` routes them through the registry executor.
- **Plugin execution boundary preserved**: file-backed plugin code still requires explicit `allowPluginCodeExecution`; without it, Controller pauses through human approval.
- **Result-envelope verification**: registered action execution now returns a minimal verification envelope so Controller `VerifyNode` can reason about registry execution results.
- **Tests**: added `tests/action-registry-runtime.test.js`; total coverage increased to 477 passing tests.

## 4.0.9 LTS

- **Benchmark Scenario Corpus**: added a built-in benchmark corpus under `benchmarks/scenarios/` covering runtime diagnosis, large-context task decomposition, safe command execution, rollback on failed verification, and out-of-scope write blocking.
- **Benchmark corpus API**: added `lib/benchmark-corpus.js` for scenario validation, corpus loading, baseline comparison, regression detection, and Markdown/JSON report generation.
- **Isolated fixture workspaces**: upgraded `lib/evaluation-runner.js` so benchmark scenarios can materialize temporary fixture workspaces, assert files, assert last-step results, and accept expected safety outcomes such as `reverted` or `rejected`.
- **Regression thresholds and baseline**: added `benchmarks/baseline-v4.0.9.json` and `benchmarks/thresholds.json` so benchmark runs can fail on meaningful regressions rather than only unit-test failures.
- **CLI and control integration**: added `npm run benchmark` through `scripts/run-benchmarks.js`, and added `run_benchmarks` to `self_learning_control` for local runtime execution with persisted reports.
- **Tests**: added `tests/benchmark-corpus.test.js`; total coverage increased to 473 passing tests.

## 4.0.8 LTS

- **Cross-project Transfer Registry**: added `lib/transfer-registry.js` to persist transferred memory candidates, validation history, lifecycle events, and manual promotion readiness.
- **Target validation tracking**: transfer candidates can record passed/failed target-project validation evidence; failed validation blocks promotion, and passed validation only enables manual promotion review.
- **Expiration lifecycle**: transfer candidates can be expired, after which further validation is blocked.
- **Control tool integration**: `self_learning_control` now supports listing, showing, registering, validating, and expiring transfer candidates.
- **Audit bundle integration**: exported audit bundles now include transfer candidate counts, status distribution, and promotion-readiness summaries.
- **Tests**: added `tests/transfer-registry.test.js`; total coverage increased to 469 passing tests.

## 4.0.7 LTS

- **Agent Controller resume tooling**: added persisted agent task state storage and guarded approval/resume helpers.
- **Persistent task state**: controller runs now save serializable task state under `agent_tasks/` alongside existing audit traces.
- **Human approval workflow**: added approve, reject, cancel, and resume flows for tasks paused at `waiting_for_human`. Approval marks the interrupted node as completed and resumes at the next graph node; rejection fails the task; cancellation makes it terminal.
- **Control tool integration**: `self_learning_control` now supports listing, showing, approving, rejecting, cancelling, and resuming agent tasks.
- **Audit continuity**: approval, rejection, cancellation, and resumed completion append audit events and preserve the original trace.
- **Tests**: added `tests/agent-resume.test.js`; total coverage increased to 462 passing tests.

## 4.0.6 LTS

- **Action Registry / Marketplace baseline**: added `lib/action-registry.js` and `lib/action-loader.js` for plugin action registration, package loading, validation, and guarded execution.
- **Core safety preservation**: plugin actions cannot override core action types, unregister core actions, request network/external side effects, bypass policy/scope/verifier/rollback/sandbox, or declare unsafe commands.
- **Risk and rollback enforcement**: write-capable plugin actions must be R2 or higher; R2+ write actions must require rollback; R3/R4 plugin actions are queued for manual confirmation instead of auto-execution.
- **Plugin package loading**: `action.json` packages are loaded from an `actions/`-style directory with `execute.js`, `verify.js`, and `rollback.js` presence checks tied to declared verification/rollback requirements.
- **Execution boundary**: file-backed plugin code requires an explicit `allowPluginCodeExecution` context flag; registration and validation are separated from code execution.
- **Tests**: added `tests/action-registry.test.js`; total coverage increased to 458 passing tests.

## 4.0.5 LTS

- **Cross-project Memory Transfer baseline**: added project profiles, transfer candidates, confidence reduction, mandatory target revalidation, and cross-project scope validation.
- **Project profile**: `lib/project-profile.js` infers language, framework, validation commands, known patterns, and stable project IDs from file lists and package metadata.
- **Transfer safety**: `lib/memory-transfer.js` creates `transferred_candidate` objects only; transferred memory cannot auto-promote or write `SKILL.md` directly.
- **Target policy enforcement**: `lib/cross-project-scope.js` rejects safety-policy weakening, forces manual confirmation for high-risk or weakly validated candidates, and respects target project boundaries.
- **Tests**: added `tests/cross-project-transfer.test.js`; total coverage increased to 448 passing tests.


## 4.0.4 LTS

- **Agent Controller baseline**: added explicit task graph, state machine, controller runner, human interrupt handling, and audit trace persistence.
- **Runtime graph states**: introduced Observe → Plan → Policy → Scope → Execute → Verify → Feedback → Learn → Finalize flow with serializable state and guarded transitions.
- **Human-in-the-loop boundary**: R3/R4 risk, manual scope decisions, budget overflow, verification failure, conflicts, external side effects, and preference requirements now produce structured approval requests instead of silent continuation.
- **Audit trace**: controller runs produce node-level start/completion/interruption events and can persist an audit JSON under the learner directory.
- **Tests**: added `tests/agent-controller.test.js`; total coverage increased to 439 passing tests.

## 4.0.3 LTS

- **Task Decomposition Runtime baseline**: added task decomposition, dependency-aware subtask queue, task state helpers, result merger, and task verifier. `split_context` now returns a concrete decomposition artifact instead of only compacted text.
- **Evaluation baseline**: added evaluation runner and metrics for task success, auto-execution success, rollback success, repair success, false auto-apply, manual escalation, token overhead, latency overhead, and skill effectiveness.
- **Reflexion / Skill baseline**: added failure analysis, reflexion memory, failure clustering, skill candidate creation, evidence update, promotion decision, and decay helpers. Reflexions remain `memory_only` and do not directly mutate `SKILL.md`.
- **Design-goal governance**: added a completion matrix that distinguishes package version from actual autonomous-runtime maturity.
- **Stable utility APIs**: added `lib/diff-preview.js` and `lib/impact-analyzer.js` as standalone import points.
- **Tests**: total coverage increased to 434 passing tests.

## 4.0.2 LTS

- **Final audit hardening**: fixed manifest/package version mismatch, added `lib/diff-preview.js` and `install.cjs` to syntax checks, removed stale nested source tree from release zip, hardened sandbox command allowlist against shell metacharacters/command substitution/redirection, and made filesystem boundaries symlink-aware.
- **No core architecture changes**: this release only tightens release consistency and safety gates.

## 4.0.1 LTS

- **LTS 收尾硬化**：在 v4.0.0 LTS 基础上修正剩余工程缺口，版本统一到 `4.0.1-lts`。
- **Benchmark Runner 去模拟化** (`lib/evaluation-runner.js`)：`execute_action` 现在调用真实 `executeActionPlan`，`verify/run_command` 通过 sandbox 执行，支持文件断言和未知步骤 fail-closed。
- **稳定 Diff Preview API** (`lib/diff-preview.js`)：新增 standalone import point，供 action plugin、review execution、audit report、benchmark 使用。
- **命令安全硬化** (`lib/command-allowlist.js`, `lib/action-executor.js`)：denylist 改为 token/segment-aware，避免误伤 `formatter.js` 等正常路径，同时继续拦截 `rm -rf`、`git push`、`npm publish` 等危险命令。
- **测试覆盖**：新增 `tests/command-allowlist-hardening.test.js` 和 `tests/diff-preview-api.test.js`，benchmark 测试升级为真实运行链；总计 542 个测试全部通过。

## 4.0.0 LTS

- **v4.0 LTS: Autonomous Runtime Learner Stable**
- **Reflexion Memory** (`lib/reflexion-memory.js`)：任务执行后自动生成反思摘要，区分"做对了什么"、"做错了什么"、"下次怎么做不同"。
- **Skill Promotion Pipeline** (`lib/skill-promotion.js`)：skill candidate 的完整晋升管道：candidate → evidence → reviewed → promoted → frozen。
- **Model Router** (`lib/model-router.js`)：根据任务类型、风险等级、成本约束自动选择模型层级。
- **Agent Controller** (`lib/agent-controller.js`)：显式状态机封装 Hanako 行为，支持人工中断和恢复。
- **Sandbox Execution Environment** (`lib/sandbox-runner.js`, `lib/sandbox-policy.js`, `lib/command-allowlist.js`, `lib/filesystem-boundary.js`)：真正的执行沙箱，限制文件系统、命令、网络、时间和输出。
- **Audit Dashboard** (`lib/dashboard-data.js`, `lib/audit-summary.js`, `lib/execution-timeline.js`, `lib/risk-report.js`)：审计数据聚合、Markdown/JSON 报告导出、执行时间线、风险分布。
- **Cross-project Memory Transfer** (`lib/project-profile.js`, `lib/memory-transfer.js`, `lib/cross-project-scope.js`)：跨项目经验迁移，自动降低置信度、要求重新验证、保守策略。
- **Action Marketplace** (`lib/action-registry.js`, `lib/action-loader.js`)：action 插件化注册和加载，R2+ action 强制要求 rollback。
- **Benchmark Suite** (`lib/evaluation-runner.js`, `lib/evaluation-metrics.js`)：benchmark 场景运行、指标计算、基线比较、回归检测。
- **Scope Gate 集成到 Action Executor**：所有 R2+ 写入动作执行前自动经过 diff preview + scope gate。
- **Repair Classifier 集成到 Action Executor**：失败验证结果自动分类，驱动一次受控修复。
- **测试覆盖**：新增 91 个测试，总计 538 个测试全部通过。

## 3.5.0

- **Benchmark and Evaluation Suite**：新增 benchmark 运行器和指标计算模块。

## 3.4.0

- **Action Marketplace**：action 插件化注册、加载和验证。

## 3.3.0

- **Cross-project Memory Transfer**：项目 profile、迁移规则和范围验证。

## 3.2.0

- **Audit Dashboard**：审计数据聚合、报告导出、时间线构建、风险报告。

## 3.1.0

- **Sandbox Execution Environment**：沙箱策略、命令白名单、文件系统边界、统一沙箱运行器。

## 3.0.0

- **Agent Controller**：显式状态机、状态转换验证、人工中断/批准/拒绝、审计跟踪。

## 2.8.0

- **Model Router**：任务类型和风险驱动的模型层级选择、上下文长度升级、预算降级、成本估算。

## 2.7.0

- **Skill Promotion Pipeline**：skill candidate 晋升管道、evidence 累积、reviewed/promoted/frozen 阶段管理。

## 2.6.0

- **Reflexion Memory**：执行后反思摘要生成、置信度评估、洞察提取。

## 2.5.0

- **Task Decomposition Runtime**：新增从"自动执行 action"到"自动推进 task"的能力。
- **任务分解** (`lib/task-decomposition.js`)：创建任务、分解复杂任务为子任务、任务复杂度估算、拆分建议。
- **任务图执行引擎** (`lib/task-graph.js`)：管理任务依赖关系、执行任务节点、处理状态转换、支持回滚。
- **高级任务执行器** (`lib/task-executor.js`)：提供简化 API 执行任务、自动任务分解、错误处理、进度追踪、任务持久化。
- **任务状态管理**：PENDING → RUNNING → COMPLETED/FAILED/CANCELLED。
- **任务依赖处理**：自动检测可执行的待处理任务（依赖已满足）。
- **任务持久化**：任务状态保存在 `tasks/` 目录。
- **测试覆盖**：新增 `tests/task-decomposition.test.js`、`tests/task-graph.test.js`、`tests/task-executor.test.js`；测试数 447。

## 2.4.0

- **Repair Engine 强化**：：新增错误分类驱动的自动修复。
- **错误分类器** (`lib/repair-classifier.js`)：将错误分类为 lint_format、import_missing、export_missing、schema_invalid、duplicate_definition、test_assertion、snapshot_mismatch、permission_error、auth_error、timeout、security_policy_violation、unknown 共 12 种类型。
- **修复策略** (`lib/repair-strategies.js`)：为每种错误类型定义修复策略，包括唯一候选要求、最大尝试次数(1次)。
- **自动修复决策**：`lint_format`、`import_missing`、`export_missing`、`schema_invalid` 可自动修复；`test_assertion`、`snapshot_mismatch`、`permission_error`、`auth_error`、`security_policy_violation` 必须人工确认。
- **修复目标提取**：从错误消息中自动提取修复目标（如模块路径、变量名）。
- **修复工作流**：`attemptOneRepair` 函数实现一次受控修复，失败后返回 shouldRollback 标记。
- **禁止行为**：不自动更新 snapshot、不自动改测试断言、不自动放宽 validation gate、不自动第二次 repair。
- **测试覆盖**：新增 `tests/repair-classifier.test.js` 和 `tests/repair-strategies.test.js`；测试数 409。
- **兼容性**：`classifyActionError` 和 `buildRepairActionPlan` 从旧版 API 兼容导出。

## 2.3.0

- **Diff Preview 增强**：：新增 `buildDiffPreview` 函数，提供结构化的变更预览，输出变更摘要、文件列表、是否涉及安全关键文件、是否需要文档/测试更新。
- **Scope Gate 独立模块**：新增 `lib/scope-gate.js`，实现执行前的边界检查。
- **Scope Gate 决策**：`allow` / `manual_confirm` / `reject` 三级决策。
- **强制升级规则**：安全关键文件（.env 等）→ REJECT；package.json 等强制人工确认文件 → MANUAL_CONFIRM；超出 allowedFiles/allowedDirs 范围 → REJECT；删除操作 → MANUAL_CONFIRM。
- **强制拒绝文件**：.env、.secrets、credentials、.ssh、.git/credentials 等安全关键文件永不自动修改。
- **Impact Analyzer**：新增 `lib/impact-analyzer.js`，分析 proposal 对 API、配置、安全策略、测试、文档的影响。
- **影响分析建议**：自动生成基于影响分析的建议，如"API 变更：需要更新相关文档和测试"。
- **快速人工审核判断**：`requiresHumanReview` 函数快速判断是否需要人工审核。
- **测试覆盖**：新增 `tests/scope-gate-new.test.js` 和 `tests/impact-analyzer.test.js`；测试数 365。

## 2.2.0

- **Review Queue 与 Executor 打通**：新增 `proposal-execution.js` 和 `review-executor.js`，建立统一的执行链路。
- **统一执行链路**：所有 approved proposal 必须通过 `executeApprovedProposal` 执行，确保不绕过 transaction、verifier 和 feedback。
- **Proposal 类型映射**：
  - `action_plan` → 直接交给 action-executor
  - `code_patch` → 转换为 `apply_patch_sandboxed`
  - `config_patch` → 转换为事务性配置写入
  - `skill_patch` → 转换为 skill_candidate，不直接污染 SKILL
- **执行状态机**：`pending → approved → executing → verifying → executed → failed → reverted → escalated`
- **Feedback 闭环**：执行结果自动写入 `action_feedback.jsonl`，包括成功、失败、回滚状态。
- **Review 状态追踪**：执行完成后自动更新 review 状态为 applied/failed/reverted。
- **执行记录持久化**：每个执行创建 `executions/` 目录下的执行记录。
- **测试覆盖**：新增 `tests/proposal-execution.test.js` 和 `tests/review-executor.test.js`；测试数 324。

## 2.1.0

- **R2 事务写入增强**：`apply_patch_sandboxed` 支持 `filePatches` 精确文本补丁，默认要求 `oldText` 唯一匹配，避免误改多处。
- **验证命令闭环**：R2 patch 可配置 `verifyCommands`，执行后由 allowlist 命令验证，例如 `node --check`、`npm test`、`npm run check`。
- **失败自动回滚**：verification 失败时自动恢复 transaction snapshot，保证小补丁失败不污染工作区。
- **一次受控 repair**：支持 `repairPlan.filePatches` / `repairPlan.fileWrites`，失败后最多修复一次并重新验证；仍失败则回滚。
- **新增 verifier 指标**：`patch_applied`、`verification_commands_pass`、`rollback_clean`。
- **测试覆盖**：新增 `tests/action-r2-write-repair.test.js`，覆盖成功 patch、验证失败回滚、repair 后成功、ambiguous oldText 拒绝；测试数 297 → 301。

## 2.0.0

- **Runtime Auto Action 全自动闭环**：新增 Trigger → Action Plan → Policy Gate → Execute → Verify → Feedback → Learn 流程。低风险动作可自动执行，中风险动作要求 verification/rollback，高风险动作进入 Review Queue。
- **新增 action 模块族**：`action-types`、`action-triggers`、`action-planner`、`action-risk`、`action-policy`、`action-budget`、`action-transaction`、`action-executor`、`action-verifier`、`action-feedback`、`action-learning`、`action-repair`。
- **安全边界**：R4 高风险动作不自动执行；删除、发布、push/tag、外部写请求、凭证修改等破坏性动作被 Policy Gate/Validation Gate 阻断。
- **反馈学习**：自动执行结果写入 `action_feedback.jsonl`，并可聚合为 `action_policy_weights.json`，连续成功/失败会影响后续优先级但不能绕过风险门禁。
- **测试覆盖**：新增 runtime action、feedback learning、transaction/auto pipeline 测试；测试数 287 → 297。

## 1.8.1

- **skill_patch 内容去重门禁**：`refreshSkill` 和 `writeSkillIfChanged` 现在比较 SKILL.md 时剔除自动递增的 `Observed N turns` 行。仅在 hints/工作流/偏好等实质性内容变化时才生成 skill_patch proposal 和备份，消除每次 session 边界的无效 I/O 噪音。

## 1.8.0

接入 Hanako 0.305+ 官方插件接口（旧版本全部优雅回退，无行为破坏）：

- **Model advisor 改走官方 `model:sample-text` 采样**：宿主具备该 EventBus 能力时（Hanako ≥ 0.305），后台整理直接让宿主调用用户配置的 utility 模型——provider 凭证不再经过插件。原有链路（解析 `preferences.json` / `added-models.yaml` 抓取 OpenAI 兼容端点凭证）降级为旧版本回退；总线采样失败时单次回退到 HTTP 路径（官方凭证 → 备用私有端点）。`model_advice.json` 的 `source` 新增 `official-bus` 取值。
- **提案通知附带单轮隐形上下文**：`session:send` 在宿主声明支持 `context` 时（按 capability inputSchema 探测），通知消息附带 `context.beforeUser` 的结构化提案摘要（仅 id/type/risk/title/reason/triggerPatternIds，绝不含原始用户文本），代理可在同轮解释提案而无需工具往返；旧宿主自动省略。
- **manifest 对齐当前插件契约**：`capabilities` 从无效的对象写法改为文档规定的数组写法并声明 `model.sample`；`minAppVersion` 从 `0.0.0` 校准为文档承诺的 `0.293.0`。
- **`diagnose_bus` 增强**：诊断输出新增 `sampleTextCap`，便于确认宿主是否暴露官方采样能力。
- **收紧 high-risk `code_patch` 提案门槛**：仅明确的 error pattern 可生成 code patch；`error:unknown` 与全部 usage advisory（如 large-context / failed-request）只保留为诊断或工作流提示，避免低证据误报污染 Review Queue。
- 新增总线采样与 code patch gate 测试（能力解析、零凭证采样、HTTP 回退、无回退时透传错误、unknown error / usage advisory 不生成 code patch）。

## 1.7.1

代码审查后的一致性与健壮性修复（无行为破坏，纯增量）：

- **修复手动 advisor 蒸馏被覆盖**：`syncDiskStatus` 现在通过新的 `absorbDiskPatternState()` 吸收 control.js 写入的更新的 advisor `fix`（按 `advisorUpdatedAt` 时间戳，绝不覆盖用户已批准 pattern 的文案）。此前 `control.js action=run_model_advisor` 合并的建议会被运行中插件的下一次内存态持久化清掉。
- **损坏的 config.json 不再被静默覆盖**：解析失败时先重命名为 `config.json.corrupt.<ts>.bak` 再写默认值，保留用户可恢复的设置。
- **`event_log` 头哈希改为尾部读取**：`appendEvent` 不再每次整文件读取求上一条哈希，改为读 8 KiB 尾部（超大事件回退整读），追加从 O(n) 降为 O(1)。
- **整洁度**：`estimateTokens` 抽出共享的 `estimateTokensRaw()`，消除 `buildSkillMdFromPatterns` 内重复的 CJK 区间表；`PatternDetector.all()` 复用 `decoratePatterns()`，两处装饰逻辑不再各写一份；观察者仅为已处理事件类型创建 `SessionTurn`。
- 新增 `tests/disk-sync.test.js` 及 common/event-log 测试；测试总数 264 → 278。

## 1.7.0

治理收口、Runtime E2E 与审计增强：

- **`apply_proposal` 治理收口**：`self_learning_control action=apply_proposal` 现在尊重 `requireReviewForAutoApply`；`conservative` 策略下禁止旁路，必须走 `approve_review → apply_review`。
- **`config_patch` Validation Gate 强化**：新增 `validateConfigPatch()`，执行 DEFAULT_CONFIG key 白名单、类型校验、数值范围校验、高风险配置 warning，以及 conservative profile 下的外部服务/审核开关 blocking。
- **config patch 应用语义修正**：`config_patch` 现在按 patch 合并当前配置，而不是用 proposal payload 替换整个 `config.json`。
- **Doctor policy consistency**：新增 `policy_inconsistent` 诊断，发现 `governanceProfile` 与关键治理开关不一致时给出 high 级建议。
- **Runtime E2E fixture**：新增 `tests/fixtures/fake-hanako-runtime.js` 与 `tests/runtime-e2e.test.js`，覆盖重复工作流、用户纠正、重复工具错误生成 code_patch、conservative 严格审核链路。
- **Error proposal 行为修正**：机器 `autoApproved` 的 error/usage pattern 仍会生成 high-risk `code_patch` proposal；只有人工 approved 的 pattern 才抑制重复提案。
- **Event Log hash chain**：`appendEvent()` 为每条事件写入 `prevHash` / `hash`；新增 `hashEvent()`、`verifyEventLog()` 与 `self_learning_control action=verify_event_log`，可检测 payload 篡改、断链和 legacy 无 hash 行。
- **Control UX 增强**：关键 `self_learning_control` action 返回 `nextAction` / `recommendedNextActions`；Doctor 输出新增按严重度排序的 `priorityActions`。
- **README 发布准备**：新增 CI badge、推荐安全配置、治理操作示例，并同步版本与测试数。
- 新增 `tests/config-validation.test.js`、`tests/event-log.test.js`、`tests/runtime-e2e.test.js`；测试总数 241 → 264。

## 1.6.1

系统审计修复（8 项）+ 模块合并（3 个碎片模块消除）：

**审计修复**
- **observer.js**：`self_learning_search` handler 改用防御式 JSON 解析。
- **common.js + index.js**：新增 `cleanupTempFiles()`，启动时清理 crash 残留 `*.tmp` 文件。
- **control.js**：`status` action 输出时对 API key 做脱敏。
- **index.js**：从 `recordUsage` 移除冗余 `pruneDataFiles()` 调用。
- **pattern-detector.js**：`_forgetPattern` 清理孤儿关系边；workflow 检测过滤纯未知工具类别噪音。
- **observer.js**：`flushTurn` 中 userTexts 拼接限制长度。
- **common.js**：提取共享 `estimateTokens()`，消除三处重复的 CJK token 估算代码。

**模块合并（减负）**
- `skill-registry.js` → 合并到 `skill-lifecycle.js`
- `diff-preview.js` → 合并到 `proposals.js`
- `usage.js` → 合并到 `helpers.js`
- `index.js` usage 管道提取为 `lib/usage-pipeline.js`（`usageModelKey` / `usageTotalTokens` / `summarizeUsageEntry` / `updateUsageSummary` / `snapshotHostCapabilities`）
- lib 目录：29 → 27 文件，index.js：864 → 786 行

## 1.6.0

策略配置档与本地审计包：

- **新增 `governanceProfile` 配置**：默认 `balanced`；新增 conservative / balanced / autonomous 三种治理策略，集中调整自动注入、自动批准、pending preference、严格审核与通知等行为。外部模型顾问与语义检索在所有配置档中仍保持关闭，必须显式配置才会外发。
- **新增 `lib/policy-profiles.js`**：提供 `listPolicyProfiles()` 与 `applyPolicyProfile()`，保证策略切换可测试、可审计、可复用。
- **`self_learning_control` 新增 `list_policy_profiles` / `set_policy_profile`**：可直接列出当前策略与可用模式，或一键切换治理策略；切换时写入 append-only `policy.applied` 事件。
- **新增 `lib/audit-bundle.js` 与 `export_audit_bundle`**：导出本地审计包（`audit-bundle.json` + `audit-report.md`），汇总 doctor、scope 分布、proposal/review 状态、event replay summary，并自动脱敏 API key/token/secret/password 字段。
- 新增 `tests/policy-audit.test.js`，测试总数 237 → 241。

## 1.5.0

严格审核模式与事件回放收口：

- **新增 `requireReviewForAutoApply` 配置**：默认关闭以保持现有自动刷新体验；开启后，低风险 `skill_patch` 不再直接 auto-apply，而是进入 Review Queue，必须先批准 review。
- **`applyProposal` 支持 `requireReview` 门禁**：需要审核时，未批准的 review 会阻止 proposal 应用；`code_patch` 仍始终禁止自动应用。
- **`self_learning_control` 新增 `apply_review`**：把 Review Queue 从“只读审核列表”升级为可执行入口，只有 `approved` review 才能应用对应 proposal。
- **`self_learning_control` 新增 `event_summary`**：基于 append-only `event_log.jsonl` 回放 proposal/review/skill 等实体最新状态。
- **`lib/event-log.js` 新增 `replayEventState`**：从事件流重建实体状态摘要，为后续 doctor 深度一致性检查和 GUI 面板打基础。
- README / manifest / package 版本更新到 `1.5.0`，配置表增加严格审核模式说明。

## 1.4.0

学习治理链路（Review Queue + Diff Preview + Validation Gate）：

- **新增 `lib/review-queue.js`**：proposal 创建后自动进入 review queue，记录来源 pattern、风险、diffPreview、validation 状态；新增 review_panel / list_reviews / approve_review / reject_review 控制入口
- **新增 `lib/diff-preview.js`**：在 apply 前预览 skill_patch / config_patch / code_patch 的变更；code_patch 仅显示计划，不自动改代码
- **新增 `lib/validation-gate.js`**：proposal apply 前必须通过验证门禁；skill_patch 检查头部与 token budget，config_patch 检查 payload，code_patch 明确阻止自动 apply
- **新增 `lib/event-log.js`**：append-only `event_log.jsonl` 审计流，记录 proposal/review/skill 状态变化，便于追踪与回放
- **新增 `lib/skill-registry.js`**：记录 SKILL.md 的 active 状态、来源 proposal、来源 pattern 和最近 validation
- **新增 `lib/tool-repair.js`**：对 file_not_found / path_error / permission_denied / command_not_found / syntax_error / auth_error / network_error / model_error 等生成结构化 repairPlan；error pattern 和 search 结果会携带 repairPlan
- **语义缓存收口**：`semanticCacheMaxEntries` 默认 1000，防止 `embeddings_cache.json` 长期无限增长
- **Doctor 增强**：增加 review_backlog、validation_blocked_reviews、event_log_missing 等治理检查
- **新增 `tests/review-governance.test.js`、`tests/tool-repair.test.js`**；测试总数 227 → 235

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
