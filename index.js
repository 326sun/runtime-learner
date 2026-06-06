/**
 * Runtime Self-Learning plugin for Hanako.
 *
 * Three layers:
 * 1. Observe: capture real Hanako runtime events per session.
 * 2. Learn: detect repeated workflows, errors, and explicit user corrections.
 * 3. Inject: update this plugin's self-learning skill with conservative hints.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { DEFAULT_CONFIG, ageDays, decayedScore, patternStatus, isInjectable } from "./lib/common.js";

const DATA_DIR = path.join(os.homedir(), ".hanako", "self-learning");
const EXPERIENCE_LOG = path.join(DATA_DIR, "experience_log.jsonl");
const ERROR_LOG = path.join(DATA_DIR, "error_log.jsonl");
const PATTERNS_FILE = path.join(DATA_DIR, "patterns.json");
const TURNS_FILE = path.join(DATA_DIR, "turns.jsonl");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const HISTORY_DIR = path.join(DATA_DIR, "skill_history");
const MAX_SESSIONS = 64;
const MAX_TEXT = 500;
const SKILL_REFRESH_MIN_MS = 10_000;
const MAX_SKILL_HISTORY = 20;

const TOOL_SHORT = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  grep: "grep",
  find: "find",
  ls: "ls",
  web_search: "web_search",
  web_fetch: "web_fetch",
  browser: "browser",
  todo_write: "todo_write",
  pin_memory: "pin_memory",
  search_memory: "search_memory",
  subagent: "subagent",
  subagent_reply: "subagent_reply",
  subagent_close: "subagent_close",
  workflow: "workflow",
  notify: "notify",
  cron: "cron",
  stage_files: "stage_files",
  install_skill: "install_skill",
  computer: "computer",
  terminal: "terminal",
  current_status: "current_status",
};

const TASK_SIGS = {
  file_management: { tools: ["read", "write", "edit", "find", "grep", "ls"], min: 1 },
  coding: { tools: ["bash", "write", "edit", "grep"], min: 2 },
  document_processing: { tools: ["read", "write"], min: 1 },
  research: { tools: ["web_search", "web_fetch", "browser"], min: 1 },
  planning: { tools: ["todo_write", "subagent", "workflow"], min: 1 },
};

const ERR_PATTERNS = {
  file_not_found: [/ENOENT/i, /no such file/i, /file not found/i],
  permission_denied: [/EACCES/i, /permission denied/i, /access is denied/i],
  network_error: [/ECONNREFUSED/i, /ETIMEDOUT/i, /fetch failed/i, /network/i],
  auth_error: [/401/i, /403/i, /unauthorized/i, /invalid api key/i],
  model_error: [/context length/i, /token limit/i, /stopReason=length/i],
  tool_error: [/failed/i, /error/i],
};

const CORRECTION_PATTERNS = [
  /(?:不对|错了|不是|应该|以后|下次|记住|按我说的|不要这样|别这样|改成|纠正)/i,
  /(?:wrong|incorrect|actually|remember|next time|do not|don't|should have)/i,
];

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf-8");
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {}
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  return { ...DEFAULT_CONFIG };
}

function safeText(value, max = MAX_TEXT) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeToolName(name) {
  if (!name) return null;
  const text = String(name);
  return TOOL_SHORT[text] || text.replace(/^runtime-learner_/, "");
}

function classifyTask(tools) {
  let best = "general";
  let bestScore = 0;
  for (const [type, sig] of Object.entries(TASK_SIGS)) {
    const matches = tools.filter((tool) => sig.tools.includes(tool)).length;
    if (matches >= sig.min && matches > bestScore) {
      best = type;
      bestScore = matches;
    }
  }
  return best;
}

function classifyError(msg) {
  for (const [type, patterns] of Object.entries(ERR_PATTERNS)) {
    if (patterns.some((p) => p.test(msg))) return type;
  }
  return "unknown";
}

function resultStatus(turn, stopReason) {
  if (turn.errors.length > 0) return "partial";
  if (stopReason && stopReason !== "stop") return "partial";
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
  if (Array.isArray(message.content)) {
    return safeText(message.content.map((part) => part?.text || part?.content || "").join(" "), 1000);
  }
  return "";
}

function extractAssistantText(event) {
  return messageText(event?.message);
}

function extractCorrectionFromUserText(text) {
  const clean = safeText(text, 300);
  if (!clean) return "";
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(clean)) ? clean : "";
}

class SessionTurn {
  constructor(sessionPath) {
    this.sessionPath = sessionPath || "unknown";
    this.startedAt = new Date().toISOString();
    this.lastTouched = Date.now();
    this.tools = [];
    this.pendingTools = new Map();
    this.toolCallCount = 0;
    this.errors = [];
    this.userTexts = [];
    this.assistantText = "";
    this.stopReason = null;
  }

  touch() {
    this.lastTouched = Date.now();
  }

  addTool(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    this.tools.push(name);
    this.toolCallCount += 1;
    this.touch();
  }

  markToolStart(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    this.addTool(name);
    this.pendingTools.set(name, (this.pendingTools.get(name) || 0) + 1);
  }

  markToolEnd(toolName) {
    const name = normalizeToolName(toolName);
    if (!name) return;
    const pending = this.pendingTools.get(name) || 0;
    if (pending > 0) {
      if (pending === 1) this.pendingTools.delete(name);
      else this.pendingTools.set(name, pending - 1);
      this.touch();
      return;
    }
    this.addTool(name);
  }

  addError(message) {
    const text = safeText(message);
    if (text) this.errors.push(text);
    this.touch();
  }

  addUserText(text) {
    const clean = safeText(text, 300);
    if (clean) this.userTexts.push(clean);
    this.touch();
  }
}

class PatternDetector {
  constructor(config) {
    this.config = config;
    this.patterns = new Map();
    this.seqCache = new Map();
    this.turnCount = 0;
  }

  setConfig(config) {
    this.config = config;
  }

  restore(saved) {
    for (const pattern of saved || []) {
      if (!pattern?.id) continue;
      this.patterns.set(pattern.id, pattern);
      if (pattern.type === "workflow" && Array.isArray(pattern.tools)) {
        this.seqCache.set(pattern.tools.join("->"), pattern.count || 1);
      }
    }
  }

  ingest(exp) {
    this.turnCount += 1;
    if (exp.toolsUsed.length >= 2) {
      const key = exp.toolsUsed.join("->");
      const count = (this.seqCache.get(key) || 0) + 1;
      this.seqCache.set(key, count);
      if (count >= 3) {
        const pid = `workflow:${key}`;
        const desc = `Repeated workflow: ${exp.toolsUsed.join(" -> ")} (${exp.taskType})`;
        const existing = this.patterns.get(pid);
        if (existing) {
          existing.count = count;
          existing.lastSeen = exp.date;
          existing.score = Math.max(existing.score || 0, count * 2);
        } else {
          this.patterns.set(pid, {
            id: pid,
            type: "workflow",
            status: "pending",
            desc,
            count,
            firstSeen: exp.date,
            lastSeen: exp.date,
            score: count * 2,
            tools: [...exp.toolsUsed],
            fix: "Before repeating this workflow, check whether the same sequence already failed or can be shortened.",
          });
        }
      }
    }

    if (exp.correction) {
      const ck = `pref:${exp.correction.slice(0, 80)}`;
      const existing = this.patterns.get(ck);
      if (existing) {
        existing.count += 1;
        existing.lastSeen = exp.date;
        existing.score += 3;
      } else {
        this.patterns.set(ck, {
          id: ck,
          type: "preference",
          status: "pending",
          desc: `User correction: ${exp.correction}`,
          count: 1,
          firstSeen: exp.date,
          lastSeen: exp.date,
          score: 6,
          tools: [],
          fix: exp.correction,
        });
      }
    }
  }

  ingestError(err) {
    const ek = `error:${err.errorType}`;
    const existing = this.patterns.get(ek);
    const inc = Math.max(1, err.severity || 1);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = err.date;
      existing.score += inc;
      if (err.candidateSkill && !existing.fix) existing.fix = err.candidateSkill;
      return existing;
    }
    const pattern = {
      id: ek,
      type: "error",
      status: "pending",
      desc: `Repeated error: ${err.errorType} - ${err.errorDesc}`,
      count: 1,
      firstSeen: err.date,
      lastSeen: err.date,
      score: inc,
      tools: err.tool ? [err.tool] : [],
      fix: err.candidateSkill || "Check this failure mode before retrying the same action.",
    };
    this.patterns.set(ek, pattern);
    return pattern;
  }

  all() {
    return [...this.patterns.values()]
      .map((pattern) => ({
        ...pattern,
        status: patternStatus(pattern),
        decayedScore: Number(decayedScore(pattern, this.config).toFixed(2)),
        injectable: isInjectable(pattern, this.config),
      }))
      .sort((a, b) => (b.decayedScore || 0) - (a.decayedScore || 0));
  }

  highConfidence() {
    return this.all().filter((p) => p.injectable).slice(0, 8);
  }

  prefs() {
    return this.all().filter((p) => p.type === "preference" && p.fix && p.injectable).slice(0, 8);
  }
}

function buildSkillMd(detector, config) {
  const prefs = detector.prefs();
  const hints = detector.highConfidence();
  const lines = [
    "# Runtime Self-Learning",
    "",
    "This plugin observes Hanako runtime behavior, learns repeated local patterns, and injects only high-confidence reminders.",
    "Use these reminders conservatively. They are local hints, not hard rules.",
    "",
  ];

  if (prefs.length) {
    lines.push("## User Preferences");
    for (const pref of prefs) lines.push(`- ${pref.fix}`);
    lines.push("");
  }

  if (hints.length) {
    lines.push("## Learned Runtime Hints");
    for (const hint of hints) {
      lines.push(`- [${hint.type}, ${hint.status}, count=${hint.count}, score=${hint.decayedScore}] ${hint.desc}${hint.fix ? ` -> ${hint.fix}` : ""}`);
    }
    lines.push("");
  }

  lines.push(
    "## Available Tools",
    "- `self_learning_stats`: inspect local learning statistics.",
    "- `self_learning_report`: generate a local learning report.",
    "- `self_learning_control`: review, approve, reject, configure, or roll back learned hints.",
    "",
    "## Safety",
    "- Do not expose private file paths, prompts, or logs unless the user asks.",
    "- Treat learned hints as suggestions and prefer current user instructions.",
    "",
    `Config: autoInjectHighConfidence=${config.autoInjectHighConfidence}, minInjectScore=${config.minInjectScore}, minInjectCount=${config.minInjectCount}`,
    `Data dir: ${DATA_DIR}`,
    `Updated: ${new Date().toISOString()}`,
    "",
  );
  return lines.join("\n");
}

export default class RuntimeLearnerPlugin {
  async onload() {
    const ctx = this.ctx;
    ensureDir();

    let config = loadConfig();
    const detector = new PatternDetector(config);
    const sessions = new Map();
    let lastSkillRefresh = 0;

    const persistPatterns = () => {
      fs.writeFileSync(PATTERNS_FILE, JSON.stringify(detector.all(), null, 2), "utf-8");
    };

    const snapshotSkill = (skillPath) => {
      if (!fs.existsSync(skillPath)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(skillPath, path.join(HISTORY_DIR, `${stamp}-SKILL.md`));
      const entries = fs.readdirSync(HISTORY_DIR)
        .filter((name) => name.endsWith("-SKILL.md"))
        .sort();
      for (const old of entries.slice(0, Math.max(0, entries.length - MAX_SKILL_HISTORY))) {
        fs.rmSync(path.join(HISTORY_DIR, old), { force: true });
      }
    };

    const refreshSkill = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSkillRefresh < SKILL_REFRESH_MIN_MS) return;
      const skillDir = path.join(ctx.pluginDir, "skills", "self-learning");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      snapshotSkill(skillPath);
      fs.writeFileSync(skillPath, buildSkillMd(detector, config), "utf-8");
      lastSkillRefresh = now;
    };

    try {
      if (fs.existsSync(PATTERNS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf-8"));
        detector.restore(saved);
        ctx.log.info(`runtime-learner: restored ${saved.length} patterns`);
      }
    } catch (err) {
      ctx.log.warn(`runtime-learner: load failed: ${err.message}`);
    }

    const getTurn = (sessionPath) => {
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
    };

    const flushTurn = (sessionPath, event = {}) => {
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

      const correction = turn.userTexts.map(extractCorrectionFromUserText).find(Boolean) || "";
      const tools = [...turn.tools];
      const date = new Date().toISOString();
      const taskId = `${path.basename(key)}:${Date.now()}`;
      const exp = {
        date,
        taskId,
        sessionPath: key,
        taskType: classifyTask(tools),
        project: "general",
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

      try {
        appendJsonl(TURNS_FILE, {
          date,
          sessionPath: key,
          tools,
          errors: turn.errors,
          stopReason,
          correction,
        });
        appendJsonl(EXPERIENCE_LOG, exp);
      } catch (err) {
        ctx.log.warn(`runtime-learner: write experience failed: ${err.message}`);
      }

      for (const errMsg of turn.errors) {
        const ee = {
          date,
          taskId,
          sessionPath: key,
          taskType: exp.taskType,
          errorType: classifyError(errMsg),
          errorDesc: safeText(errMsg, 200),
          rootCauseGuess: "unknown",
          userCorrection: correction || "none",
          fixApplied: "none",
          repeatCountEstimate: 1,
          severity: stopReason === "error" ? 4 : 2,
          isMechanical: false,
          isContextual: true,
          candidateSkill: null,
          tool: tools.at(-1) || null,
        };
        try {
          appendJsonl(ERROR_LOG, ee);
          detector.ingestError(ee);
        } catch (err) {
          ctx.log.warn(`runtime-learner: write error failed: ${err.message}`);
        }
      }

      detector.ingest(exp);
      try {
        persistPatterns();
        refreshSkill();
      } catch (err) {
        ctx.log.warn(`runtime-learner: refresh failed: ${err.message}`);
      }

      sessions.delete(key);
    };

    let unsub = null;
    try {
      unsub = ctx.bus.subscribe((event, sessionPath) => {
        if (!event?.type) return;
        const turn = getTurn(sessionPath);

        if (event.type === "user_message" || event.type === "message_start") {
          if (event.message?.role === "user") turn.addUserText(messageText(event.message));
          return;
        }

        if (event.type === "message_end" && event.message?.role === "user") {
          turn.addUserText(messageText(event.message));
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
          if (event.isError) turn.addError(extractToolError(event));
          return;
        }

        if (event.type === "message_end" && event.message?.role === "assistant") {
          flushTurn(sessionPath, event);
          return;
        }

        // Backward compatibility for older or differently shaped runtimes.
        if (event.type === "assistantMessageEvent") {
          const ame = event.assistantMessageEvent || {};
          if (ame.toolName) turn.addTool(ame.toolName);
          if (ame.toolError) turn.addError(ame.toolError);
          if (ame.type === "done" || ame.type === "complete") flushTurn(sessionPath, event);
        }
      });
    } catch (err) {
      ctx.log.warn(`runtime-learner: EventBus subscribe failed: ${err.message}`);
    }

    this._detector = detector;
    this._sessions = sessions;
    this._unsub = unsub;
    this._persistPatterns = persistPatterns;
    this._refreshSkill = refreshSkill;

    try {
      persistPatterns();
      refreshSkill(true);
    } catch (err) {
      ctx.log.warn(`runtime-learner: initial refresh failed: ${err.message}`);
    }

    ctx.log.info("runtime-learner: started three-layer self-learning runtime");
  }

  async onunload() {
    if (this._unsub) this._unsub();
    if (this._detector && this._persistPatterns) {
      try { this._persistPatterns(); } catch {}
    }
    if (this._refreshSkill) {
      try { this._refreshSkill(true); } catch {}
    }
  }
}
