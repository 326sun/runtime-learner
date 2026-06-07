import fs from "fs";
import path from "path";
import { learnerDir, readJson, writeJson } from "./common.js";
import { resolveOfficialUtilityAdvisorConfig } from "./official-utility-model.js";

export const MODEL_ADVICE_FILE = path.join(learnerDir(), "model_advice.json");
const MODEL_ADVICE_STATE_FILE = path.join(learnerDir(), "model_advice_state.json");

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.endsWith("/chat/completions")) return raw;
  if (raw.endsWith("/v1")) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}

function compactPattern(pattern) {
  return {
    id: pattern.id,
    type: pattern.type,
    status: pattern.status,
    count: pattern.count,
    score: pattern.decayedScore ?? pattern.score,
    desc: pattern.desc,
    fix: pattern.fix || "",
  };
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function shouldRun(config) {
  if (!config.modelAdvisorEnabled) return { ok: false, reason: "disabled" };
  const resolved = resolveAdvisorConfig(config);
  if (!resolved.ok) return resolved;

  const state = readJson(MODEL_ADVICE_STATE_FILE, {});
  const minMs = Math.max(1, Number(config.modelAdvisorMinIntervalMinutes || 60)) * 60_000;
  if (state.lastRunAt && Date.now() - Date.parse(state.lastRunAt) < minMs) {
    return { ok: false, reason: "rate limited" };
  }
  return { ok: true, config: resolved.config };
}

function resolveAdvisorConfig(config) {
  const source = config.modelAdvisorSource || "official";
  if (source === "off") return { ok: false, reason: "advisor source is off" };

  if (source === "official") {
    const official = resolveOfficialUtilityAdvisorConfig();
    if (official.ok) return { ok: true, config: { ...config, ...official.config } };
    if (!config.modelAdvisorBaseUrl && !config.modelAdvisorModel && !config.modelAdvisorApiKey) {
      return official;
    }
  }

  if (!config.modelAdvisorBaseUrl || !config.modelAdvisorModel) return { ok: false, reason: "model advisor endpoint incomplete" };
  if (!config.modelAdvisorApiKey) return { ok: false, reason: "model advisor api key missing" };
  return {
    ok: true,
    config: {
      ...config,
      modelAdvisorResolvedSource: source === "official" ? "private-fallback" : "private",
    },
  };
}

export async function runModelAdvisor({ config, patterns = [], usage = null, capabilities = null, reason = "scheduled" }) {
  const gate = shouldRun(config);
  if (!gate.ok) return { ok: false, skipped: true, reason: gate.reason };
  const runtimeConfig = gate.config;

  const candidates = patterns
    .filter((pattern) => pattern.status !== "rejected")
    .sort((a, b) => (b.decayedScore || b.score || 0) - (a.decayedScore || a.score || 0))
    .slice(0, 12)
    .map(compactPattern);

  if (candidates.length === 0) return { ok: false, skipped: true, reason: "no candidate patterns" };

  const prompt = [
    "You are a low-cost background advisor for a self-learning plugin.",
    "Summarize candidate improvements conservatively. Do not invent facts. Do not request private prompts or paths.",
    "Return JSON only with shape: {\"suggestions\":[{\"patternId\":\"...\",\"title\":\"...\",\"advice\":\"...\",\"risk\":\"low|medium|high\"}]}",
    "",
    JSON.stringify({
      reason,
      patterns: candidates,
      usage: usage ? {
        totalRequests: usage.totalRequests,
        totalTokens: usage.totalTokens,
        status: usage.status,
        topModels: Object.entries(usage.byModel || {}).slice(0, 5),
      } : null,
      capabilities: capabilities ? {
        count: capabilities.count,
        availableCount: capabilities.availableCount,
      } : null,
    }),
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let res;
  try {
    res = await fetch(normalizeBaseUrl(runtimeConfig.modelAdvisorBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.modelAdvisorApiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: runtimeConfig.modelAdvisorModel,
        messages: [
          { role: "system", content: "Return compact JSON only. Be conservative." },
          { role: "user", content: prompt },
        ],
        max_tokens: Math.max(64, Number(runtimeConfig.modelAdvisorMaxTokens || 500)),
        temperature: 0.2,
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`model advisor failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || data.output_text || "";
  const parsed = extractJson(text) || { suggestions: [] };
  const advice = {
    updatedAt: new Date().toISOString(),
    reason,
    source: runtimeConfig.modelAdvisorResolvedSource || config.modelAdvisorSource || "official",
    provider: runtimeConfig.modelAdvisorResolvedProvider || null,
    model: runtimeConfig.modelAdvisorModel,
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 12) : [],
  };
  writeJson(MODEL_ADVICE_FILE, advice);
  writeJson(MODEL_ADVICE_STATE_FILE, { lastRunAt: advice.updatedAt });
  return { ok: true, advice };
}

export function readModelAdvice() {
  if (!fs.existsSync(MODEL_ADVICE_FILE)) return null;
  return readJson(MODEL_ADVICE_FILE, null);
}
