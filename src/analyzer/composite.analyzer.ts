// Defense-in-depth wrapper. The LLM (Claude) is a great nuance judge but it reads the
// agent's *attacker-controlled* prompt, so it can in principle be talked down by prompt
// injection. A security firewall must never let the model lower the verdict below what
// deterministic, unambiguous deny-rules already establish.
//
// CompositeAnalyzer runs the primary analyzer, then raises the score to a hard floor derived
// from signals an LLM is not allowed to override: a known scam/drainer target (declared or in
// the decoded tx), a prompt-injection attempt, or a value over the agent's spend limit.
// Result = max(primary score, hard floor).

import {
  classifyScore,
  type AnalysisInput,
  type AnalysisResult,
  type Analyzer,
} from "./analyzer.types";
import { normalizeAddr, scamReason, matchInjection } from "./knowledge-base.util";

const FLOOR = {
  scamTarget: 100_000, // known malicious target → Blocked, always
  promptInjection: 80_000, // attacking the firewall itself → Blocked
  overSpendLimit: 50_000, // policy breach → at least Escalated
} as const;

export interface HardFloor {
  score: number;
  findings: string[];
}

/** Deterministic minimum score from unambiguous deny signals (never overridable by the LLM). */
export function hardDenyFloor(input: AnalysisInput): HardFloor {
  const kb = input.knowledgeBase;
  const findings: string[] = [];
  let score = 0;

  const target = normalizeAddr(input.targetProgram);
  const txPackages = input.tx.moveCalls.map((m) => normalizeAddr(m.package)).filter(Boolean);

  const scams = Array.from(new Set([target, ...txPackages]))
    .map((a) => [a, scamReason(kb, a)] as const)
    .filter(([, r]) => r);
  if (scams.length) {
    score = Math.max(score, FLOOR.scamTarget);
    findings.push(`Known malicious target ${scams[0][0]}: ${scams[0][1]}`);
  }

  const inj = matchInjection(kb, input.prompt);
  if (inj.length) {
    score = Math.max(score, FLOOR.promptInjection);
    findings.push(`Prompt-injection attempt against the relayer: ${inj.join("; ")}`);
  }

  // Use the larger of the declared value and the amount the decoded tx actually moves.
  const observed = input.tx.splitAmounts ?? [];
  const observedMax = observed.reduce((m, a) => (a > m ? a : m), 0n);
  const effectiveValue = observedMax > input.value ? observedMax : input.value;
  if (input.agent.spendLimit > 0n && effectiveValue > input.agent.spendLimit) {
    score = Math.max(score, FLOOR.overSpendLimit);
    findings.push(`Value ${effectiveValue} exceeds agent spend limit ${input.agent.spendLimit}`);
  }

  return { score, findings };
}

export class CompositeAnalyzer implements Analyzer {
  readonly name: string;

  constructor(private readonly primary: Analyzer) {
    this.name = `${primary.name}+floor`;
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const floor = hardDenyFloor(input);
    const res = await this.primary.analyze(input);

    if (floor.score <= res.rawScore) return res;

    // The model under-scored a hard-deny signal — raise to the deterministic floor.
    const decision = classifyScore(floor.score, input.thresholds);
    return {
      rawScore: floor.score,
      analyzer: `${res.analyzer}+floor`,
      findings: [...floor.findings, ...res.findings],
      reasoning:
        `[${res.analyzer}+floor] Decision floored to ${decision} (score ${floor.score}/100000) ` +
        `by deterministic deny rules — the model's score (${res.rawScore}) was overridden.\n` +
        `Deny signals:\n${floor.findings.map((f) => `  - ${f}`).join("\n")}\n\n` +
        `Model assessment:\n${res.reasoning}`,
    };
  }
}
