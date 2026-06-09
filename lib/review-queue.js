import fs from "fs";
import path from "path";
import { previewProposalDiff } from "./proposals.js";
import { validateProposal } from "./validation-gate.js";
import { appendEvent } from "./event-log.js";

function safeName(value) {
  return String(value || "review").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

export function reviewsDir(learnerDir) { return path.join(learnerDir, "reviews"); }
export function reviewPath(learnerDir, id) { return path.join(reviewsDir(learnerDir), `${safeName(id)}.json`); }
export function reviewIdForProposal(proposal) { return `review:${proposal?.id || "unknown"}`; }

export function readReview(learnerDir, id) {
  const file = reviewPath(learnerDir, id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

export function writeReview(learnerDir, review) {
  fs.mkdirSync(reviewsDir(learnerDir), { recursive: true });
  const next = { schemaVersion: 1, createdAt: new Date().toISOString(), ...review, updatedAt: new Date().toISOString() };
  fs.writeFileSync(reviewPath(learnerDir, next.id), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function enqueueReviewForProposal(learnerDir, proposal, { configPath = null, config = {}, doctorReport = null } = {}) {
  if (!proposal?.id) return null;
  const id = reviewIdForProposal(proposal);
  const existing = readReview(learnerDir, id);
  if (existing && ["approved", "rejected", "applied"].includes(existing.status)) return existing;
  const diffPreview = previewProposalDiff(proposal, { configPath });
  const validation = validateProposal(proposal, { config, doctorReport });
  const review = writeReview(learnerDir, {
    ...(existing || {}),
    id,
    type: proposal.type,
    status: validation.ok ? "queued" : "blocked",
    risk: proposal.risk || "unknown",
    proposalId: proposal.id,
    sourcePatternIds: proposal.triggerPatternIds || proposal.sourcePatternIds || [],
    evidenceIds: proposal.evidenceIds || [],
    title: proposal.title || proposal.reason || proposal.id,
    reason: proposal.reason || "",
    diffPreview,
    validation,
  });
  appendEvent(learnerDir, {
    type: existing ? "review.updated" : "review.queued",
    entityType: "review",
    entityId: review.id,
    summary: `${review.status}: ${review.title}`,
    data: { proposalId: proposal.id, risk: review.risk, validationOk: validation.ok },
  });
  return review;
}

export function listReviews(learnerDir, { status = null, limit = 50 } = {}) {
  const dir = reviewsDir(learnerDir);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      if (!status || row.status === status) rows.push(row);
    } catch {}
  }
  rows.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

export function updateReviewStatus(learnerDir, id, status, extra = {}) {
  const existing = readReview(learnerDir, id);
  if (!existing) throw new Error(`review not found: ${id}`);
  const next = writeReview(learnerDir, { ...existing, ...extra, status, reviewedAt: new Date().toISOString() });
  appendEvent(learnerDir, {
    type: `review.${status}`,
    entityType: "review",
    entityId: id,
    summary: `Review ${status}: ${id}`,
    data: { proposalId: next.proposalId, ...extra },
  });
  return next;
}

export function markReviewForProposal(learnerDir, proposalId, status, extra = {}) {
  return updateReviewStatus(learnerDir, reviewIdForProposal({ id: proposalId }), status, extra);
}

export function isProposalReviewApproved(learnerDir, proposalId) {
  const review = readReview(learnerDir, reviewIdForProposal({ id: proposalId }));
  return review?.status === "approved" || review?.status === "applied";
}

export function reviewPanel(learnerDir, { proposals = [], doctorReport = null } = {}) {
  const reviews = listReviews(learnerDir, { limit: 100 });
  const pendingStatuses = new Set(["queued", "blocked", "approved"]);
  return {
    ok: true,
    doctorStatus: doctorReport?.status || null,
    counts: {
      reviews: reviews.length,
      pendingReviews: reviews.filter((r) => pendingStatuses.has(r.status)).length,
      blockedReviews: reviews.filter((r) => r.status === "blocked").length,
      pendingProposals: proposals.filter((p) => p.status === "pending").length,
    },
    pendingReviews: reviews.filter((r) => pendingStatuses.has(r.status)).slice(0, 30).map((r) => ({
      id: r.id,
      status: r.status,
      type: r.type,
      risk: r.risk,
      proposalId: r.proposalId,
      title: r.title,
      validationOk: !!r.validation?.ok,
      diff: r.diffPreview ? { target: r.diffPreview.target, addedLines: r.diffPreview.addedLines, removedLines: r.diffPreview.removedLines } : null,
      updatedAt: r.updatedAt,
    })),
    recommendedActions: doctorReport?.suggestedActions || [],
  };
}
