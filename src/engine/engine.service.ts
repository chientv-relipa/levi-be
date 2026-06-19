// The verdict engine — the heart of the relayer. For one submitted action it:
//   1. reads the Action + Agent on-chain,
//   2. decrypts the payload with the relayer x25519 secret,
//   3. verifies the blake3 commitment (tamper detection),
//   4. decodes the intended PTB and scores it (Claude / rule-based),
//   5. lands the verdict on-chain via verdict_action (RelayerCap), and
//   6. persists the full reasoning + an action-log record.
//
// Idempotent + race-safe: an action that is no longer `pending` (already verdicted, or seen
// before) is recorded and skipped; concurrent calls for the same action are collapsed.
// Tamper / decryption failure is a strong threat signal → Blocked; operator faults (missing
// key, RPC down) throw so the caller can retry.

import { Inject, Injectable } from "@nestjs/common";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

import { RELAYER_CONFIG, type RelayerConfig } from "../config/relayer-config";
import type { LeviConfig, LeviAgent, LeviAction, AllowedTarget } from "../common/levi-sdk";
import { actionStatus, decryptFromAgent, commitmentHash, decodeActionPayload } from "../common/levi-sdk";
import { SuiService } from "../sui/sui.service";
import { parseActionTx } from "../analyzer/ptb.util";
import { AnalyzerService } from "../analyzer/analyzer.service";
import { KnowledgeBaseService } from "../analyzer/knowledge-base.service";
import { classifyScore, type AnalysisInput, type AnalysisResult } from "../analyzer/analyzer.types";
import { RELAYER_STORE, type RelayerStore, type ActionRecord } from "../store/store.interface";
import { POLICY_IDS, ALL_POLICY_IDS } from "../common/policy-ids";

/** The subset of SuiService the engine needs (kept narrow so the engine is unit-testable). */
export interface EngineSui {
  getConfig(): Promise<LeviConfig>;
  getAction(id: string): Promise<LeviAction>;
  getAgent(id: string): Promise<LeviAgent>;
  getAllowedTargets(id: string): Promise<AllowedTarget[]>;
  submitVerdict(p: {
    agentId: string;
    actionId: string;
    rawScore: number;
    reasoning: string;
  }): Promise<string>;
}

export interface EngineResult {
  actionObjectId: string;
  agentId: string;
  decision: string;
  rawScore: number;
  reasoning: string;
  reasoningHash: string;
  analyzer: string;
  status: number;
  verdictDigest?: string;
  /** True when no verdict was landed (already decided or previously processed). */
  skipped: boolean;
}

const STATUS_LABEL: Record<number, string> = {
  [actionStatus.pending]: "Pending",
  [actionStatus.approved]: "Approved",
  [actionStatus.escalated]: "Escalated",
  [actionStatus.blocked]: "Blocked",
  [actionStatus.rejected]: "Rejected",
};

@Injectable()
export class EngineService {
  private config?: LeviConfig;
  /** Collapse concurrent calls for the same action (API submit + watcher) into one. */
  private readonly inFlight = new Map<string, Promise<EngineResult>>();
  private readonly relayerSecret?: Uint8Array;

  constructor(
    @Inject(SuiService) private readonly sui: EngineSui,
    private readonly analyzer: AnalyzerService,
    @Inject(RELAYER_STORE) private readonly store: RelayerStore,
    @Inject(RELAYER_CONFIG) cfg: RelayerConfig,
    private readonly kb: KnowledgeBaseService
  ) {
    this.relayerSecret = cfg.relayerX25519Secret ? hexToBytes(cfg.relayerX25519Secret) : undefined;
  }

  private async getConfig(): Promise<LeviConfig> {
    if (!this.config) this.config = await this.sui.getConfig();
    return this.config;
  }

  /** Process one action by its Sui object ID. Safe to call repeatedly + concurrently. */
  processAction(actionObjectId: string): Promise<EngineResult> {
    const existing = this.inFlight.get(actionObjectId);
    if (existing) return existing;
    const p = this.doProcess(actionObjectId).finally(() => this.inFlight.delete(actionObjectId));
    this.inFlight.set(actionObjectId, p);
    return p;
  }

  private async doProcess(actionObjectId: string): Promise<EngineResult> {
    const { sui, store } = this;

    // Fast idempotency path: already handled.
    if (store.isProcessed(actionObjectId)) {
      const rec = store.getAction(actionObjectId);
      if (rec) return recordToResult(rec, true);
    }

    const action = await sui.getAction(actionObjectId);

    // Only pending actions get a verdict; anything else is recorded and skipped.
    if (action.status !== actionStatus.pending) {
      const rec = await this.persistFromChain(action, "(no verdict — action not pending)");
      store.markProcessed(actionObjectId);
      return recordToResult(rec, true);
    }

    const config = await this.getConfig();
    const thresholds = { escalate: config.escalateThreshold, block: config.blockThreshold };

    const agent = await sui.getAgent(action.agent);
    const allowedTargets = await sui.getAllowedTargets(action.agent);

    // Disabled/removed policies — the matching guard is skipped at scoring time. We union the
    // global overlay with this agent's per-agent overlay, so a guard turned off for this agent
    // (workspace model) is skipped only for its own actions.
    const disabledPolicies = new Set(
      ALL_POLICY_IDS.filter(
        (id) =>
          store.isPolicyDisabled(id) ||
          store.isPolicyRemoved(id) ||
          store.isAgentPolicyDisabled(action.agent, id) ||
          store.isAgentPolicyRemoved(action.agent, id),
      ),
    );

    // Decrypt + verify commitment → analyze, or force-block on tamper/decrypt failure.
    const analysis = this.analyzeOrBlock(action, agent, allowedTargets, thresholds, disabledPolicies);
    const result = analysis instanceof Promise ? await analysis : analysis;

    // Land the verdict on-chain (RelayerCap). reasoning_hash on-chain == blake3(reasoning).
    // Race-safe: the Watcher and the API submit can both reach a fresh action; whoever lands the
    // verdict first wins, and the other's verdict_action aborts with `assert_pending` (the action
    // is no longer pending). Treat that as "already decided" — re-read and return the landed
    // verdict instead of surfacing an error to the caller.
    let verdictDigest: string;
    try {
      verdictDigest = await sui.submitVerdict({
        agentId: action.agent,
        actionId: actionObjectId,
        rawScore: result.rawScore,
        reasoning: result.reasoning,
      });
    } catch (e) {
      const current = await sui.getAction(actionObjectId);
      if (current.status !== actionStatus.pending) {
        const rec = await this.persistFromChain(current, "(verdict already landed by another path)");
        store.markProcessed(actionObjectId);
        return recordToResult(rec, true);
      }
      throw e; // genuine fault (RPC, operator key, …) — let the caller retry
    }

    const reasoningHash = bytesToHex(blake3(new TextEncoder().encode(result.reasoning)));

    // Re-read for the authoritative on-chain status/decision the contract assigned.
    const finalized = await sui.getAction(actionObjectId);

    store.saveReasoning(reasoningHash, result.reasoning);
    const record: ActionRecord = {
      actionObjectId,
      agentId: action.agent,
      onchainActionId: action.actionId.toString(),
      targetProgram: action.targetProgram,
      value: action.value.toString(),
      status: finalized.status,
      decision: STATUS_LABEL[finalized.status] ?? classifyScore(result.rawScore, thresholds),
      rawScore: result.rawScore,
      analyzer: result.analyzer,
      reasoningHash,
      verdictDigest,
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
    };
    store.saveAction(record);
    store.markProcessed(actionObjectId);

    return recordToResult({ ...record }, false, result.reasoning);
  }

  /** Record an action whose verdict already exists on-chain (no new verdict landed). */
  private async persistFromChain(action: LeviAction, note: string): Promise<ActionRecord> {
    const reasoningHash = bytesToHex(action.reasoningHash);
    const record: ActionRecord = {
      actionObjectId: action.id,
      agentId: action.agent,
      onchainActionId: action.actionId.toString(),
      targetProgram: action.targetProgram,
      value: action.value.toString(),
      status: action.status,
      decision: STATUS_LABEL[action.status] ?? "Unknown",
      rawScore: action.rawScore,
      analyzer: note,
      reasoningHash,
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
    };
    this.store.saveAction(record);
    return record;
  }

  /** Decrypt + verify + analyze; on tamper/decrypt failure return a forced Blocked result. */
  private analyzeOrBlock(
    action: LeviAction,
    agent: LeviAgent,
    allowedTargets: AllowedTarget[],
    thresholds: { escalate: number; block: number },
    disabledPolicies: ReadonlySet<string>
  ): Promise<AnalysisResult> | AnalysisResult {
    if (!this.relayerSecret) {
      // Operator fault — we cannot decrypt anything. Surface, don't punish the agent.
      throw new Error(
        "relayer x25519 secret not configured (RELAYER_X25519_SECRET) — run `npm run set-key`"
      );
    }

    let plaintext: Uint8Array;
    try {
      const dec = decryptFromAgent({
        payload: action.encryptedPayload,
        relayerSecretKey: this.relayerSecret,
      });
      plaintext = dec.plaintext;
    } catch (e) {
      return forcedBlock(
        `Payload failed to decrypt (tampered or wrong key): ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // Commitment must match the decrypted plaintext (unless the integrity policy is disabled).
    const recomputed = commitmentHash(plaintext);
    if (!disabledPolicies.has(POLICY_IDS.integrity) && !bytesEqual(recomputed, action.commitment)) {
      return forcedBlock(
        `Commitment mismatch: blake3(plaintext) != on-chain commitment — payload was altered.`
      );
    }

    let prompt: string;
    let txBytes: Uint8Array;
    try {
      const decoded = decodeActionPayload(plaintext);
      prompt = decoded.prompt;
      txBytes = decoded.tx;
    } catch (e) {
      return forcedBlock(
        `Decrypted payload is not a valid ActionPayload: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    const input: AnalysisInput = {
      prompt,
      tx: parseActionTx(txBytes),
      targetProgram: action.targetProgram,
      value: action.value,
      agent: {
        agentWallet: agent.agentWallet,
        spendLimit: agent.spendLimit,
        threatScore: agent.threatScore,
        strikes: agent.strikes,
        active: agent.active,
      },
      allowedTargets,
      thresholds,
      knowledgeBase: this.kb.get(),
      disabledPolicies,
    };
    return this.analyzer.analyze(input);
  }
}

function forcedBlock(reason: string): AnalysisResult {
  return {
    rawScore: 100_000,
    findings: [reason],
    analyzer: "integrity-guard",
    reasoning: `[integrity-guard] Decision: Blocked (score 100000/100000).\n${reason}`,
  };
}

function recordToResult(rec: ActionRecord, skipped: boolean, reasoning?: string): EngineResult {
  return {
    actionObjectId: rec.actionObjectId,
    agentId: rec.agentId,
    decision: rec.decision,
    rawScore: rec.rawScore,
    reasoning: reasoning ?? "(reasoning stored by hash; fetch via /reasoning/:hash)",
    reasoningHash: rec.reasoningHash,
    analyzer: rec.analyzer,
    status: rec.status,
    verdictDigest: rec.verdictDigest,
    skipped,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
