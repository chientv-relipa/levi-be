import type { EventId } from "@mysten/sui/client";

/** DI token for the RelayerStore implementation. */
export const RELAYER_STORE = "RELAYER_STORE";

export interface ActionRecord {
  actionObjectId: string;
  agentId: string;
  /** on-chain action_id (u64) as a decimal string. */
  onchainActionId: string;
  targetProgram: string;
  /** value (u64) as a decimal string. */
  value: string;
  /** ActionStatus code (levi::action). */
  status: number;
  /** "Approved" | "Escalated" | "Blocked" | "Rejected" | "Pending". */
  decision: string;
  rawScore: number;
  analyzer: string;
  /** hex of blake3(reasoning) — matches the on-chain reasoning_hash. */
  reasoningHash: string;
  verdictDigest?: string;
  createdAt: string;
  processedAt?: string;
}

export interface RelayerStore {
  getCursor(): EventId | null;
  setCursor(cursor: EventId | null): void;
  isProcessed(actionObjectId: string): boolean;
  markProcessed(actionObjectId: string): void;
  saveAction(record: ActionRecord): void;
  getAction(actionObjectId: string): ActionRecord | undefined;
  listActions(): ActionRecord[];
  saveReasoning(hashHex: string, reasoning: string): void;
  getReasoning(hashHex: string): string | undefined;

  /** Off-chain, cosmetic agent display name (the contract stores no name). */
  setAgentName(agentId: string, name: string): void;
  getAgentName(agentId: string): string | undefined;

  /** Off-chain "archived" flag — hides an agent from dashboard listings (the contract
   *  has no delete; this is a UI-level soft delete). */
  setAgentArchived(agentId: string, archived: boolean): void;
  isAgentArchived(agentId: string): boolean;

  /** Off-chain enable/disable flag for a firewall policy (default enabled). */
  setPolicyEnabled(policyId: string, enabled: boolean): void;
  isPolicyDisabled(policyId: string): boolean;

  /** User-created (custom) policies — advisory labels; enforcement stays with built-in guards. */
  listCustomPolicies(): StoredPolicy[];
  addCustomPolicy(policy: StoredPolicy): void;
  deleteCustomPolicy(policyId: string): boolean;

  /** "Removed" built-in policies — hidden from the dashboard AND skipped by the engine. */
  setPolicyRemoved(policyId: string, removed: boolean): void;
  isPolicyRemoved(policyId: string): boolean;

  // ---- Per-agent policy overlay ("workspace 1 agent" model) ----
  // Each agent has its own enable/disable + removed set + custom policies. The engine, when
  // scoring an action, applies the union of the global overlay AND the action's agent overlay,
  // so a guard turned off for agent A is skipped only for agent A.

  /** Enable/disable a built-in guard for a single agent (default enabled). */
  setAgentPolicyEnabled(agentId: string, policyId: string, enabled: boolean): void;
  isAgentPolicyDisabled(agentId: string, policyId: string): boolean;
  /** "Remove" (hide + skip) a built-in guard for a single agent. */
  setAgentPolicyRemoved(agentId: string, policyId: string, removed: boolean): void;
  isAgentPolicyRemoved(agentId: string, policyId: string): boolean;
  /** Custom (advisory) policies scoped to one agent. */
  listAgentCustomPolicies(agentId: string): StoredPolicy[];
  addAgentCustomPolicy(agentId: string, policy: StoredPolicy): void;
  deleteAgentCustomPolicy(agentId: string, policyId: string): boolean;
}

/** Per-agent policy overlay persisted under `agentPolicies[agentId]`. */
export interface AgentPolicyState {
  disabled: string[];
  removed: string[];
  custom: StoredPolicy[];
}

export type PolicySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface StoredPolicyRule {
  name: string;
  detector: string;
  value: string;
  action: "block" | "escalate" | "flag";
}

export interface StoredPolicy {
  id: string;
  name: string;
  severity: PolicySeverity;
  category: string;
  description: string;
  rules: StoredPolicyRule[];
  createdAt: string;
}
