import fs from "fs";
import path from "path";
import crypto from "crypto";
import { learnerDir, readJson } from "./common.js";

const DEFAULT_MAX_EVENTS = 5000;

export function eventLogPath(baseDir = learnerDir()) {
  return path.join(baseDir, "event_log.jsonl");
}

function eventId(event) {
  const seed = JSON.stringify({
    date: event.date,
    type: event.type,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
  });
  return `evt_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function eventWithoutHashes(event = {}) {
  const { hash, prevHash, ...rest } = event;
  return rest;
}

export function hashEvent(event = {}, prevHash = "") {
  return crypto
    .createHash("sha256")
    .update(`${prevHash || ""}${canonicalJson(eventWithoutHashes(event))}`)
    .digest("hex");
}

function lastEventHash(baseDir) {
  const file = eventLogPath(baseDir);
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (typeof row.hash === "string" && row.hash) return row.hash;
      return "";
    } catch {}
  }
  return "";
}

export function appendEvent(baseDir, event = {}) {
  fs.mkdirSync(baseDir, { recursive: true });
  const base = {
    id: event.id || eventId({ ...event, date: event.date || new Date().toISOString() }),
    date: event.date || new Date().toISOString(),
    actor: event.actor || "runtime",
    type: event.type || "unknown",
    entityType: event.entityType || "unknown",
    entityId: event.entityId || null,
    summary: event.summary || "",
    data: event.data || {},
  };
  const prevHash = lastEventHash(baseDir);
  const next = {
    ...base,
    prevHash,
    hash: hashEvent(base, prevHash),
  };
  fs.appendFileSync(eventLogPath(baseDir), `${JSON.stringify(next)}\n`, "utf-8");
  return next;
}

export function verifyEventLog(baseDir = learnerDir()) {
  const file = eventLogPath(baseDir);
  if (!fs.existsSync(file)) {
    return { ok: true, events: 0, rootHash: null, headHash: null, brokenAt: null };
  }
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  let expectedPrev = null;
  let rootHash = null;
  let headHash = null;

  for (let i = 0; i < lines.length; i++) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch (err) {
      return { ok: false, events: lines.length, rootHash, headHash, brokenAt: i, reason: `invalid json: ${err.message}` };
    }

    if (!row.hash) {
      return { ok: false, events: lines.length, rootHash, headHash, brokenAt: i, reason: "missing hash" };
    }

    const actualPrev = row.prevHash || "";
    if (i === 0) {
      expectedPrev = actualPrev;
      rootHash = actualPrev || "";
    } else if (actualPrev !== expectedPrev) {
      return { ok: false, events: lines.length, rootHash, headHash, brokenAt: i, reason: "prevHash mismatch" };
    }

    const expectedHash = hashEvent(row, actualPrev);
    if (row.hash !== expectedHash) {
      return { ok: false, events: lines.length, rootHash, headHash, brokenAt: i, reason: "hash mismatch" };
    }

    headHash = row.hash;
    expectedPrev = row.hash;
  }

  return { ok: true, events: lines.length, rootHash, headHash, brokenAt: null };
}

export function readEvents(baseDir = learnerDir(), { limit = 200, type = null, entityId = null } = {}) {
  const file = eventLogPath(baseDir);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (const line of lines.slice(-Math.max(limit * 4, limit))) {
    try {
      const row = JSON.parse(line);
      if (type && row.type !== type) continue;
      if (entityId && row.entityId !== entityId) continue;
      rows.push(row);
    } catch {}
  }
  return rows.slice(-limit).reverse();
}

export function pruneEventLog(baseDir = learnerDir(), { keep = DEFAULT_MAX_EVENTS } = {}) {
  const file = eventLogPath(baseDir);
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  if (lines.length <= keep) return 0;
  const kept = lines.slice(-keep);
  fs.writeFileSync(file, `${kept.join("\n")}\n`, "utf-8");
  return lines.length - kept.length;
}

export function eventSummary(baseDir = learnerDir()) {
  const events = readEvents(baseDir, { limit: DEFAULT_MAX_EVENTS });
  return replayEventState(events);
}

export function replayEventState(events = []) {
  const ordered = [...(events || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const entities = {};
  const byType = {};
  for (const evt of ordered) {
    if (!evt?.type) continue;
    byType[evt.type] = (byType[evt.type] || 0) + 1;
    const entityType = evt.entityType || "unknown";
    const entityId = evt.entityId || "unknown";
    const key = `${entityType}:${entityId}`;
    const current = entities[key] || { entityType, entityId, status: "unknown", events: 0 };
    const suffix = String(evt.type).split(".").pop();
    const nextStatus = evt.data?.status || ({
      created: "pending",
      updated: current.status || "updated",
      queued: "queued",
      blocked: "blocked",
      validated: current.status || "validated",
      previewed: current.status || "previewed",
      approved: "approved",
      rejected: "rejected",
      applied: "applied",
      rolled_back: "rolled_back",
    }[suffix] || current.status || suffix);
    entities[key] = {
      ...current,
      status: nextStatus,
      events: current.events + 1,
      lastEventType: evt.type,
      lastEventAt: evt.date || null,
      lastSummary: evt.summary || current.lastSummary || "",
    };
  }
  return { count: ordered.length, byType, entities };
}
