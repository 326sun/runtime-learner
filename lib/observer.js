/**
 * SessionObserver — event subscription and turn lifecycle for Runtime Self-Learning.
 * Extracted from index.js to reduce plugin entry size and enable independent testing.
 *
 * Responsibilities:
 *   - Event bus subscription (session/message/tool/error events)
 *   - SessionTurn lifecycle (getTurn, flushTurn)
 *   - Tool-end semantic handlers (pin_memory → preference, self_learning_search → adoption)
 *   - Experience/error/turn JSONL logging
 *
 * Post-flush processing (auto-approve, sync, persist, skill refresh, model advisor) is
 * delegated to the onTurnComplete callback provided by the plugin entry.
 */

import path from "path";
import fs from "fs";
import { SessionTurn } from "./session-turn.js";
import {
  normalizeToolName,
  safeText,
  toolCategory,
  classifyTask,
  classifyError,
  extractCorrectionFromUserText,
  preferencePatternId,
} from "./helpers.js";
import { readJson } from "./common.js";
import { inferScope } from "./scope.js";

/**
 * @param {object} deps
 * @param {import("./pattern-detector.js").PatternDetector} deps.detector
 * @param {Map<string, SessionTurn>} deps.sessions
 * @param {object} deps.runtimeState — mutable state shared with plugin entry
 * @param {() => void} deps.persistPatterns
 * @param {(force?: boolean, sessionPath?: string, cachedAll?: any[]) => void} deps.refreshSkill
 * @param {(sessionPath?: string, cachedAll?: any[]) => { count: number, allPatterns: any[] }} deps.autoApprovePatterns
 * @param {() => void} deps.syncDiskStatus
 * @param {() => Promise<void>} deps.pruneDataFiles
 * @param {(reason: string, sessionPath?: string, allPatterns?: any[]) => Promise<void>} deps.maybeRunModelAdvisor
 * @param {(entry: object) => void} deps.appendJsonl
 * @param {(event: object) => void} deps.logActivity
 * @param {(entry: object, sessionPath?: string) => void} deps.recordUsage
 * @param {{ current: object }} deps.configRef — mutable config reference
 * @param {object} deps.ctx — plugin context for logging
 * @param {object} deps.paths — { TURNS_FILE, EXPERIENCE_LOG, ERROR_LOG, CONFIG_FILE }
 * @param {number} deps.MAX_SESSIONS
 */
export function createObserver(deps) {
  const {
    detector,
    sessions,
    runtimeState,
    persistPatterns,
    refreshSkill,
    autoApprovePatterns,
    syncDiskStatus,
    pruneDataFiles,
    maybeRunModelAdvisor,
    appendJsonl,
    logActivity,
    recordUsage,
    configRef,
    ctx,
    paths,
    MAX_SESSIONS,
  } = deps;

  // ── Config reload with mtime cache: skip disk read when unchanged ──
  let _configMtime = 0;

  function reloadConfigIfStale() {
    try {
      const mtime = fs.statSync(paths.CONFIG_FILE).mtimeMs;
      if (mtime !== _configMtime) {
        _configMtime = mtime;
        configRef.current = { ...configRef.current, ...readJson(paths.CONFIG_FILE, {}) };
        detector.setConfig(configRef.current);
      }
    } catch {
      // File missing or unreadable — skip, keep current config
    }
  }

  // ── Turn helpers ──

  // Normal terminal stop reasons. "end_turn" is as much a clean completion as
  // "stop" (see the message_end handler below, which flushes on both); treating
  // only "stop" as success mislabels every end_turn turn as partial and starves
  // the positive-feedback workflow boost. "length"/"error" remain partial.
  const SUCCESS_STOP_REASONS = new Set(["stop", "end_turn"]);

  function resultStatus(turn, stopReason) {
    if (turn.errors.length > 0) return "partial";
    if (stopReason && !SUCCESS_STOP_REASONS.has(stopReason)) return "partial";
    return "success";
  }

  function extractToolError(event) {
    const raw = event?.error || event?.result?.error || event?.result?.message || event?.message;
    const msg = typeof raw === "string" ? raw : raw?.message || "";
    const tool = normalizeToolName(event?.toolName || event?.name) || "tool";
    return msg ? `${tool}: ${safeText(msg)}` : `${tool}: failed`;
  }

  function messageText(message) {
    if (!message) return "";
    if (typeof message.content === "string") return safeText(message.content, 1000);
    if (typeof message.text === "string") return safeText(message.text, 1000);
    if (Array.isArray(message.content)) {
      return safeText(message.content.map((part) => part?.text || part?.content || "").join(" "), 1000);
    }
    return "";
  }

  function extractAssistantText(event) {
    return messageText(event?.message);
  }

  // ── Turn lifecycle ──

  function getTurn(sessionPath) {
    const key = sessionPath || "unknown";
    let turn = sessions.get(key);
    if (!turn) {
      turn = new SessionTurn(key);
      sessions.set(key, turn);
    }
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    return turn;
  }

  function flushTurn(sessionPath, event = {}) {
    const key = sessionPath || "unknown";
    const turn = sessions.get(key);
    if (!turn) return;

    const stopReason = event?.message?.stopReason ?? turn.stopReason ?? null;
    const finalError = safeText(event?.message?.errorMessage || event?.message?.error?.message || event?.error);
    if (finalError) turn.addError(finalError);
    turn.assistantText = extractAssistantText(event) || turn.assistantText;
    turn.stopReason = stopReason;

    if (turn.tools.length === 0 && turn.errors.length === 0 && !turn.assistantText) {
      sessions.delete(key);
      return;
    }

    // Concatenate all user messages before correction detection so that
    // cross-message weak signals (e.g. "改成这样" in msg 1 + "下次记住" in msg 2)
    // are scored together rather than independently. Truncate to 2000 chars to
    // bound memory for long-running sessions.
    const allUserText = turn.userTexts.slice(-8).join(" ").slice(0, 2000);
    const correction = extractCorrectionFromUserText(allUserText) || "";
    const tools = [...turn.tools];
    const date = new Date().toISOString();
    const taskId = `${path.basename(key)}:${Date.now()}`;
    const taskType = classifyTask(tools);
    // Infer the activity scope (project / taskType) so learned patterns are
    // bounded to where they apply. project is derived from the session/workspace
    // path; it falls back to "general" (unscoped) when no project is discernible.
    const scope = inferScope({ sessionPath: key, userText: allUserText, taskType });
    const exp = {
      date,
      taskId,
      sessionPath: key,
      taskType,
      project: scope.project,
      scope,
      userIntent: turn.userTexts.at(-1) || "",
      taskSummary: tools.length ? `tools: ${tools.join(" -> ")}` : "assistant turn without tool use",
      toolsUsed: tools,
      toolCallCount: turn.toolCallCount,
      resultStatus: resultStatus(turn, stopReason),
      stopReason,
      userFeedback: correction ? "correction" : "unknown",
      userExplicitCorrection: !!correction,
      errorType: turn.errors.length ? classifyError(turn.errors[0]) : "none",
      failurePoint: turn.errors.length ? turn.errors[0] : "none",
      correction,
      impactLevel: turn.errors.length ? 2 : 1,
      repeatability: tools.length >= 2 ? "medium" : "low",
      oneOff: false,
      skillCandidate: false,
      suggestedSkill: null,
      notes: "",
    };

    // Write logs
    try {
      appendJsonl(paths.TURNS_FILE, { date, sessionPath: key, tools, errors: turn.errors, stopReason, correction });
      appendJsonl(paths.EXPERIENCE_LOG, exp);
      // Compact, structured episode for provenance/audit (feeds v1.2 MemFS and
      // is the canonical target an evidence record points back to).
      if (paths.EPISODES_FILE) {
        appendJsonl(paths.EPISODES_FILE, {
          id: taskId,
          date,
          sessionPath: key,
          scope,
          tools,
          taskType,
          hasCorrection: !!correction,
          resultStatus: exp.resultStatus,
          summary: exp.taskSummary,
        });
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: write experience failed: ${err.message}`);
    }

    // Ingest errors
    for (const errMsg of turn.errors) {
      const ee = {
        date,
        taskId,
        sessionPath: key,
        taskType: exp.taskType,
        scope,
        errorType: classifyError(errMsg),
        errorDesc: safeText(errMsg, 200),
        severity: stopReason === "error" ? 4 : 2,
        tool: tools.at(-1) || null,
      };
      try {
        appendJsonl(paths.ERROR_LOG, ee);
        const { isNew } = detector.ingestError(ee);
        if (isNew) {
          logActivity({
            type: "error_discovered",
            summary: `New error pattern: ${ee.errorType} — ${ee.errorDesc}`,
            sessionPath: key,
          });
          runtimeState.sessionActivityCount += 1;
        }
      } catch (err) {
        ctx.log.warn(`runtime-learner: write error failed: ${err.message}`);
      }
    }

    // Ingest experience
    const newPatterns = detector.ingest(exp);

    // Positive feedback: successful turn without correction → boost workflow
    if (exp.resultStatus === "success" && !correction && tools.length >= 2) {
      const cats = tools.map(t => toolCategory(normalizeToolName(t)));
      const uniqueCats = [...new Set(cats)].sort();
      if (uniqueCats.length >= 2) {
        const wfId = `workflow:${uniqueCats.join("→")}`;
        const wf = detector.patterns.get(wfId);
        if (wf) {
          wf.bonus = (wf.bonus || 0) + 1;
          wf.score = (wf.score || 0) + 1;
          wf.lastSuccessAt = date;
          wf.successCount = (wf.successCount || 0) + 1;
          detector.invalidate();
        }
      }
    }

    for (const np of newPatterns) {
      logActivity({
        type: "pattern_discovered",
        summary: `New ${np.type} pattern: ${np.desc}`,
        sessionPath: key,
      });
      runtimeState.sessionActivityCount += 1;
      ctx.log.info(`runtime-learner: discovered ${np.type} pattern: ${np.desc}`);
    }

    if (newPatterns.length > 0 || correction) {
      const parts = [];
      if (newPatterns.length > 0) parts.push(`${newPatterns.length} new pattern(s) detected`);
      if (correction) parts.push(`user correction captured`);
      logActivity({
        type: "turn_complete",
        summary: `Turn completed: ${tools.join(" -> ") || "no tools"}${parts.length ? ` — ${parts.join(", ")}` : ""}`,
        sessionPath: key,
        detail: newPatterns.map((p) => p.desc).join("; ") || null,
      });
    }

    // ── Post-flush processing (delegated to plugin entry via closures) ──

    try {
      reloadConfigIfStale();
      syncDiskStatus();
      autoApprovePatterns(key);
      detector.pruneMemory();
      // Recompute after pruning so SKILL.md and the advisor never receive
      // patterns that were just evicted this cycle.
      const allPatterns = detector.all();
      persistPatterns();
      pruneDataFiles().catch(() => {});
      refreshSkill(false, key, allPatterns);
      maybeRunModelAdvisor("turn", key, allPatterns).catch(() => {});
    } catch (err) {
      ctx.log.warn(`runtime-learner: refresh failed: ${err.message}`);
    }

    // Adoption check
    const pending = runtimeState.pendingAdoptionChecks.get(key);
    if (pending) {
      pending.remaining -= 1;
      // Track which searched workflows have been adopted at any point in the
      // window — not just this turn. Otherwise a workflow adopted early gets
      // wrongly degraded at window close if the final turn happened not to
      // re-adopt it.
      pending.adoptedIds = pending.adoptedIds || new Set();
      let adopted = 0;
      for (const s of pending.searches) {
        if (s.tools.length === 0) continue;
        const matchCount = s.tools.filter(t => tools.includes(t)).length;
        if (matchCount >= Math.ceil(s.tools.length * 0.5)) {
          const stored = detector.patterns.get(s.patternId);
          if (stored && !pending.adoptedIds.has(s.patternId)) {
            stored.bonus = (stored.bonus || 0) + 3;
            stored.score = (stored.score || 0) + 3;
            stored.lastAdoptedAt = new Date().toISOString();
            pending.adoptedIds.add(s.patternId);
            adopted += 1;
            ctx.log.info(`runtime-learner: adopted workflow ${s.patternId}, score +3`);
          }
        }
      }
      if (adopted > 0) {
        detector.invalidate();
        persistPatterns();
        refreshSkill(true, key);
      }
      if (pending.remaining <= 0) {
        // Only degrade workflows never adopted at any point during the window.
        let degraded = 0;
        for (const s of pending.searches) {
          if (!s.patternId || pending.adoptedIds.has(s.patternId)) continue;
          const stored = detector.patterns.get(s.patternId);
          if (stored && (stored.score || 0) > 1) {
            stored.bonus = Math.max(0, (stored.bonus || 0) - 1);
            stored.score = Math.max(1, (stored.score || 0) - 1);
            degraded += 1;
          }
        }
        if (degraded > 0) {
          detector.invalidate();
          persistPatterns();
          refreshSkill(true, key);
          ctx.log.info(`runtime-learner: adoption window closed, degraded ${degraded} unadopted workflow(s)`);
        }
        runtimeState.pendingAdoptionChecks.delete(key);
      }
    }

    sessions.delete(key);
  }

  // ── Tool-end semantic handlers ──

  const toolEndHandlers = new Map();

  toolEndHandlers.set("pin_memory", (event, sessionPath) => {
    try {
      const args = event.args || event.input || {};
      // Only ingest an explicit string `content`. Falling back to
      // JSON.stringify(args) meant an end event without args (or with `{}`)
      // stored the literal "{}" as a durable, approved preference.
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (content && content.length < 500) {
        const pid = preferencePatternId(content);
        const now = new Date().toISOString();
        const existing = detector.patterns.get(pid);
        if (existing) {
          existing.count = (existing.count || 1) + 1;
          existing.score = (existing.score || 0) + 2;
          existing.lastSeen = now;
        } else {
          detector.patterns.set(pid, {
            id: pid,
            type: "preference",
            knowledgeTier: "durable",
            status: "approved",
            desc: content,
            fix: content,
            count: 1,
            score: 5,
            firstSeen: now,
            lastSeen: now,
            context: { taskType: "general", categories: ["记忆操作"] },
          });
        }
        detector.invalidate();
        persistPatterns();
        refreshSkill(false, sessionPath);
        ctx.log.info("runtime-learner: ingested pin_memory as durable preference");
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: pin_memory ingestion skipped: ${err.message}`);
    }
  });

  toolEndHandlers.set("self_learning_search", (event, sessionPath) => {
    try {
      const raw = event.result;
      if (raw == null) return;
      // Defensive: the tool may return a pre-parsed object or a JSON string.
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      const ids = results.map(r => r.id).filter(Boolean);

      if (ids.length > 0) {
        let touched = 0;
        for (const id of ids) {
          const stored = detector.patterns.get(id);
          if (stored) {
            stored.lastSearchedAt = new Date().toISOString();
            touched += 1;
          }
        }
        if (touched > 0) {
          persistPatterns();
          ctx.log.info(`runtime-learner: search exposed ${touched} pattern(s)`);
        }
      }

      const wfResults = results.filter(r => r.type === "workflow" && r.id);
      if (wfResults.length > 0 && sessionPath) {
        const searches = wfResults.map(r => {
          const stored = detector.patterns.get(r.id);
          return { patternId: r.id, tools: stored?.tools || [] };
        }).filter(s => s.tools.length > 0);
        if (searches.length > 0) {
          runtimeState.pendingAdoptionChecks.set(sessionPath, { searches, remaining: 3 });
        }
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: feedback loop skipped: ${err.message}`);
    }
  });

  // ── Subscribe / unsubscribe ──

  let unsubs = [];

  function subscribe(ctxBus, config) {
    unsubs = [];

    // Main event subscription
    try {
      unsubs.push(ctxBus.subscribe((event, sessionPath) => {
        if (!event?.type) return;
        const turn = getTurn(sessionPath);

        if (event.type === "session_user_message") {
          turn.addUserText(messageText(event.message));
          return;
        }

        if (event.type === "user_message" || event.type === "message_start") {
          if (event.message?.role === "user") turn.addUserText(messageText(event.message));
          return;
        }

        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            turn.assistantText = safeText(`${turn.assistantText} ${sub.delta || ""}`, 1000);
          }
          return;
        }

        if (event.type === "tool_execution_start") {
          turn.markToolStart(event.toolName || event.name);
          return;
        }

        if (event.type === "tool_execution_end") {
          turn.markToolEnd(event.toolName || event.name);
          if (event.isError) { turn.addError(extractToolError(event)); return; }

          const handler = toolEndHandlers.get(normalizeToolName(event.toolName || event.name));
          if (handler) handler(event, sessionPath);
          return;
        }

        // Only flush the turn when the assistant has truly finished its response,
        // not on every intermediate message_end (e.g. after each tool call in a
        // multi-step reply).  Intermediate messages have stopReason "tool_calls"
        // or no stopReason; terminal messages have "stop", "end_turn", "length",
        // or "error".
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const sr = event.message?.stopReason;
          if (sr && sr !== "tool_calls") {
            flushTurn(sessionPath, event);
          }
          return;
        }

        if (event.type === "assistantMessageEvent") {
          const ame = event.assistantMessageEvent || {};
          // toolName tracking is handled by tool_execution_start — do NOT call
          // addTool here to avoid double-counting the same tool invocation.
          if (ame.toolError) turn.addError(ame.toolError);
          if (ame.type === "done" || ame.type === "complete") flushTurn(sessionPath, event);
        }
      }));
    } catch (err) {
      ctx.log.warn(`runtime-learner: EventBus subscribe failed: ${err.message}`);
    }

    // LLM usage subscription
    try {
      if (config.learnFromUsage) {
        unsubs.push(ctxBus.subscribe((event, sessionPath) => {
          if (event?.type === "llm_usage" && event.entry) recordUsage(event.entry, sessionPath);
        }, { types: ["llm_usage"] }));
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: usage subscribe failed: ${err.message}`);
    }
  }

  function unsubscribe() {
    for (const unsub of unsubs) {
      try { unsub?.(); } catch {}
    }
    unsubs = [];
  }

  return { subscribe, unsubscribe };
}
