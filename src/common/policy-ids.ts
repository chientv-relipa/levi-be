// Stable ids for the firewall policies, shared by the Policy Center API and the analyzer/engine
// so that disabling a policy in the dashboard actually skips the matching guard at scoring time.
export const POLICY_IDS = {
  scamTarget: "scam-target-guard",
  promptInjection: "prompt-injection-guard",
  sensitiveIntent: "sensitive-intent-guard",
  spendLimit: "spend-limit-guard",
  verifiedAllowlist: "verified-target-allowlist",
  integrity: "integrity-guard",
  aiThreat: "ai-threat-analysis",
} as const;

export type PolicyId = (typeof POLICY_IDS)[keyof typeof POLICY_IDS];

export const ALL_POLICY_IDS: string[] = Object.values(POLICY_IDS);
