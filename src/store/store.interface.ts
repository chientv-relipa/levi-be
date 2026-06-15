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
}
