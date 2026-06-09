// Governance policy profiles for Runtime Self-Learning.
// Profiles are intentionally local-only switches: they adjust review/injection
// defaults without enabling external model or embedding endpoints.

export const POLICY_PROFILES = {
  conservative: {
    name: "conservative",
    label: "Conservative / review-first",
    description: "Prefer explicit review. Pending memories stay local; low-risk auto-apply proposals must be reviewed before apply.",
    values: {
      governanceProfile: "conservative",
      autoInjectHighConfidence: false,
      autoApproveHighConfidence: false,
      includePendingPreferences: false,
      requireReviewForAutoApply: true,
      proposalChatNotificationsEnabled: false,
      workStatusEnabled: false,
      modelAdvisorEnabled: false,
      semanticSearchEnabled: false,
    },
  },
  balanced: {
    name: "balanced",
    label: "Balanced / default",
    description: "Keep the original low-friction local workflow: high-confidence non-preference patterns can auto-approve and low-risk skill refreshes can auto-apply.",
    values: {
      governanceProfile: "balanced",
      autoInjectHighConfidence: true,
      autoApproveHighConfidence: true,
      includePendingPreferences: false,
      requireReviewForAutoApply: false,
      proposalChatNotificationsEnabled: false,
      workStatusEnabled: false,
      modelAdvisorEnabled: false,
      semanticSearchEnabled: false,
    },
  },
  autonomous: {
    name: "autonomous",
    label: "Autonomous / single-user fast path",
    description: "More aggressive local learning for trusted single-user setups. External model/embedding features still remain off unless explicitly configured.",
    values: {
      governanceProfile: "autonomous",
      autoInjectHighConfidence: true,
      autoApproveHighConfidence: true,
      includePendingPreferences: true,
      requireReviewForAutoApply: false,
      proposalChatNotificationsEnabled: true,
      workStatusEnabled: false,
      modelAdvisorEnabled: false,
      semanticSearchEnabled: false,
    },
  },
};

export function listPolicyProfiles() {
  return Object.values(POLICY_PROFILES).map((profile) => ({
    name: profile.name,
    label: profile.label,
    description: profile.description,
    values: profile.values,
  }));
}

export function applyPolicyProfile(config = {}, profileName = "balanced") {
  const key = String(profileName || "balanced").trim().toLowerCase();
  const profile = POLICY_PROFILES[key];
  if (!profile) {
    return {
      ok: false,
      error: `unknown governance profile: ${profileName}`,
      available: Object.keys(POLICY_PROFILES),
    };
  }

  const before = { ...config };
  const next = { ...config, ...profile.values };
  const changed = {};
  for (const [k, v] of Object.entries(profile.values)) {
    if (before[k] !== v) changed[k] = { from: before[k], to: v };
  }
  return { ok: true, profile: profile.name, label: profile.label, config: next, changed };
}
