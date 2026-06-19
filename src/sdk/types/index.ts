// Parsed shapes of the on-chain objects (the `content.fields` of a Sui object).
// Numeric Move fields come back as strings/numbers over JSON-RPC; we normalize to
// number/bigint in the readers (see utils/objects.ts).

export interface AllowedTarget {
  target: string;
  allowed: boolean;
}

export interface LeviConfig {
  id: string;
  operator: string;
  relayer: string;
  relayerEncryptionKey: Uint8Array;
  escalateThreshold: number;
  blockThreshold: number;
  maxStrikes: number;
  emaAlpha: number;
  emaScale: number;
  totalAgents: bigint;
  maintenance: boolean;
}

export interface LeviAgent {
  id: string;
  agentWallet: string;
  owner: string;
  spendLimit: bigint;
  threatScore: number;
  strikes: number;
  active: boolean;
  registeredAt: bigint;
  actionCounter: bigint;
  totalActions: bigint;
  totalApproved: bigint;
  totalBlocked: bigint;
  totalEscalated: bigint;
}

export interface LeviAction {
  id: string;
  agent: string;
  actionId: bigint;
  targetProgram: string;
  value: bigint;
  commitment: Uint8Array;
  status: number;
  decision: number;
  rawScore: number;
  reasoningHash: Uint8Array;
  encryptedPayload: Uint8Array;
}
