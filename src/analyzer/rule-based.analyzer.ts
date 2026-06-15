// Deterministic, offline analyzer. Sums weighted risk signals into a 0..100000 score.
// Always available (no API key, no network) — the fallback when Claude is unavailable, and
// the oracle the unit tests pin behavior against.
//
// Weights are tuned so a single dominant signal lands in the intended band:
//   - clean / verified target               → Approved   (< 40000)
//   - unknown target OR over spend-limit     → Escalated  (40000..69999)
//   - known scam target OR prompt-injection  → Blocked    (>= 70000)

import {
  clampScore,
  classifyScore,
  type AnalysisInput,
  type AnalysisResult,
  type Analyzer,
} from "./analyzer.types";
import {
  normalizeAddr,
  scamReason,
  isVerifiedTarget,
  matchInjection,
  matchSensitiveIntent,
} from "./knowledge-base.util";

const WEIGHTS = {
  baseline: 2_000,
  scamTarget: 95_000, // alone → Blocked
  promptInjection: 75_000, // alone → Blocked
  sensitiveIntent: 50_000, // alone → Escalated; compounds toward Blocked
  overSpendLimit: 45_000, // alone → Escalated
  valueMismatch: 35_000, // tx moves more than the declared value (declared-value spoofing)
  unknownTarget: 40_000, // alone → Escalated
  targetMismatch: 20_000, // tx touches a package other than the declared target
  unparseableTx: 15_000, // intent can't be inspected
  inactiveAgent: 30_000,
  reputationFactor: 0.1, // threatScore (0..100000) * 0.1 → up to 10000
  strikePenalty: 4_000, // per prior strike
} as const;

const unique = (xs: string[]): string[] => Array.from(new Set(xs));

export function analyzeRuleBased(input: AnalysisInput): AnalysisResult {
  const kb = input.knowledgeBase;
  const findings: string[] = [];
  let score = WEIGHTS.baseline;

  const target = normalizeAddr(input.targetProgram);
  const txPackages = input.tx.moveCalls.map((m) => normalizeAddr(m.package)).filter(Boolean);
  const allowed = new Set(
    input.allowedTargets.filter((t) => t.allowed).map((t) => normalizeAddr(t.target))
  );
  const verifiedLabel = isVerifiedTarget(kb, target);

  // 1) Known scam / drainer target (declared or invoked).
  const scams = unique([target, ...txPackages])
    .map((a) => [a, scamReason(kb, a)] as const)
    .filter(([, r]) => r);
  if (scams.length) {
    score += WEIGHTS.scamTarget;
    findings.push(`Target ${scams[0][0]} is flagged malicious: ${scams[0][1]}`);
  }

  // 2) Prompt injection against the relayer/LLM.
  const inj = matchInjection(kb, input.prompt);
  if (inj.length) {
    score += WEIGHTS.promptInjection;
    findings.push(`Prompt-injection pattern(s) detected: ${inj.join("; ")}`);
  }

  // 3) Sensitive / wallet-draining intent.
  const sens = matchSensitiveIntent(kb, input.prompt);
  if (sens.length) {
    score += WEIGHTS.sensitiveIntent;
    findings.push(`Sensitive/high-risk intent: ${sens.join("; ")}`);
  }

  // 4) Value checks — compare against the LARGER of the declared value and the amount the
  //    decoded tx actually moves (SplitCoins), so a small declared value can't hide a large
  //    transfer.
  const observed = input.tx.splitAmounts ?? [];
  const observedMax = observed.reduce((m, a) => (a > m ? a : m), 0n);
  const effectiveValue = observedMax > input.value ? observedMax : input.value;
  if (input.agent.spendLimit > 0n && effectiveValue > input.agent.spendLimit) {
    score += WEIGHTS.overSpendLimit;
    findings.push(`Value ${effectiveValue} exceeds agent spend limit ${input.agent.spendLimit}`);
  }
  if (observedMax > input.value) {
    score += WEIGHTS.valueMismatch;
    findings.push(`Transaction moves ${observedMax} but the action declared only ${input.value}`);
  }

  // 5) Any executable package — the declared target OR a package the decoded tx actually
  //    calls — that is neither verified nor allow-listed is an unverified target. Scoring the
  //    tx packages (not just the declared target) defeats declared-target spoofing.
  const executables = unique([target, ...txPackages]);
  const unknownExecs = executables.filter(
    (p) => !isVerifiedTarget(kb, p) && !allowed.has(p) && !scamReason(kb, p)
  );
  if (unknownExecs.length) {
    score += WEIGHTS.unknownTarget;
    findings.push(`Unverified target/package(s) (not verified, not allow-listed): ${unknownExecs.join(", ")}`);
  }

  // 6) tx invokes a package other than the declared target — spoofing signal (added on top).
  const spoofed = unique(
    txPackages.filter((p) => p !== target && !isVerifiedTarget(kb, p) && !allowed.has(p))
  );
  if (spoofed.length) {
    score += WEIGHTS.targetMismatch;
    findings.push(`Transaction invokes unexpected package(s) other than the declared target: ${spoofed.join(", ")}`);
  }

  // 7) Payload present but undecodable — we can't verify what it does.
  if (!input.tx.parsed && input.tx.byteLength > 0) {
    score += WEIGHTS.unparseableTx;
    findings.push(
      `Transaction payload could not be decoded for inspection${input.tx.error ? ` (${input.tx.error})` : ""}`
    );
  }

  // 8) Inactive agent.
  if (!input.agent.active) {
    score += WEIGHTS.inactiveAgent;
    findings.push("Agent is currently inactive");
  }

  // 9) Standing reputation: EMA threat score + prior strikes.
  if (input.agent.threatScore > 0) {
    const rep = Math.round(input.agent.threatScore * WEIGHTS.reputationFactor);
    if (rep > 0) {
      score += rep;
      findings.push(`Elevated agent reputation risk (EMA threat score ${input.agent.threatScore})`);
    }
  }
  if (input.agent.strikes > 0) {
    score += input.agent.strikes * WEIGHTS.strikePenalty;
    findings.push(`Agent has ${input.agent.strikes} prior strike(s)`);
  }

  const rawScore = clampScore(score);
  const decision = classifyScore(rawScore, input.thresholds);

  if (findings.length === 0) {
    findings.push(
      verifiedLabel ? `Target verified (${verifiedLabel}); no risk signals.` : "No risk signals detected."
    );
  }

  return {
    rawScore,
    findings,
    analyzer: "rule-based",
    reasoning: buildReasoning("rule-based", decision, rawScore, findings, input),
  };
}

export function buildReasoning(
  analyzer: string,
  decision: string,
  rawScore: number,
  findings: string[],
  input: AnalysisInput
): string {
  const calls = input.tx.parsed
    ? input.tx.moveCalls.map((m) => m.target).join(", ") || "(no moveCalls)"
    : "(unparsed)";
  return [
    `[${analyzer}] Decision: ${decision} (score ${rawScore}/100000).`,
    `Findings:`,
    ...findings.map((f) => `  - ${f}`),
    `Context: target=${normalizeAddr(input.targetProgram)} value=${input.value} ` +
      `calls=[${calls}] agent.active=${input.agent.active} ` +
      `threatScore=${input.agent.threatScore} strikes=${input.agent.strikes}`,
    `Prompt: ${JSON.stringify(input.prompt)}`,
  ].join("\n");
}

export class RuleBasedAnalyzer implements Analyzer {
  readonly name = "rule-based";
  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    return analyzeRuleBased(input);
  }
}
