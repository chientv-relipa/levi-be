// Analyzer contract + scoring scale shared by the rule-based and Claude analyzers.
//
// The analyzer maps an agent action to a `rawScore` on the contract's 0..100000 scale
// (the same scale `verdict_action` consumes). The on-chain decision is derived from that
// score via thresholds (escalate 40000 / block 70000); `classifyScore` mirrors that here
// so the backend can return a synchronous decision.

import type { ParsedTx } from "./ptb.util";
import type { KnowledgeBase } from "./knowledge-base.util";
import type { AllowedTarget } from "../common/levi-sdk";

export const SCORE_SCALE = 100_000;

export type Decision = "Approved" | "Escalated" | "Blocked";

export interface ScoreThresholds {
  escalate: number;
  block: number;
}

/** Matches the on-chain defaults (levi::config). */
export const DEFAULT_THRESHOLDS: ScoreThresholds = { escalate: 40_000, block: 70_000 };

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(SCORE_SCALE, Math.round(n)));
}

export function classifyScore(
  rawScore: number,
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS
): Decision {
  if (rawScore >= thresholds.block) return "Blocked";
  if (rawScore >= thresholds.escalate) return "Escalated";
  return "Approved";
}

/** Reputation snapshot the analyzer factors into the score. */
export interface AgentContext {
  agentWallet: string;
  spendLimit: bigint;
  /** EMA threat score 0..100000 (levi::agent). */
  threatScore: number;
  strikes: number;
  active: boolean;
}

export interface AnalysisInput {
  /** Decrypted natural-language intent. */
  prompt: string;
  /** Decoded intended transaction (best-effort). */
  tx: ParsedTx;
  /** Declared target package (action.targetProgram). */
  targetProgram: string;
  /** Declared value (action.value). */
  value: bigint;
  agent: AgentContext;
  allowedTargets: AllowedTarget[];
  thresholds: ScoreThresholds;
  knowledgeBase: KnowledgeBase;
  /** Policy ids the operator has disabled — the matching guard is skipped at scoring time. */
  disabledPolicies?: ReadonlySet<string>;
}

export interface AnalysisResult {
  /** 0..100000 — handed to verdict_action. */
  rawScore: number;
  /** Full human-readable justification (persisted; on-chain stores only its hash). */
  reasoning: string;
  /** Discrete risk signals that drove the score. */
  findings: string[];
  /** Which analyzer produced this ("rule-based" | "claude" | "claude→rule-based" | …). */
  analyzer: string;
}

export interface Analyzer {
  readonly name: string;
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
}
