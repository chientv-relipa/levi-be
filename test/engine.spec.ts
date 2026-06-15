// Engine flow without a network: a stateful fake Sui + fake analyzer exercise
// decrypt → verify commitment → analyze → verdict → persist, plus the integrity-guard
// (tamper / commitment mismatch → forced Block) and idempotency paths.

import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";

import { EngineService, type EngineSui } from "../src/engine/engine.service";
import { JsonStore } from "../src/store/json-store.service";
import { buildKnowledgeBase } from "../src/analyzer/knowledge-base.util";
import type { Analyzer, AnalysisResult } from "../src/analyzer/analyzer.types";
import type { AnalyzerService } from "../src/analyzer/analyzer.service";
import type { KnowledgeBaseService } from "../src/analyzer/knowledge-base.service";
import type { RelayerConfig } from "../src/config/relayer-config";
import type { LeviConfig, LeviAgent, LeviAction, AllowedTarget } from "../src/common/levi-sdk";
import {
  actionStatus,
  generateX25519Keypair,
  encryptForRelayer,
  commitmentHash,
  encodeActionPayload,
} from "../src/common/levi-sdk";

const KB = buildKnowledgeBase({ verifiedTargets: { "0x2": "Sui Framework" } });
const kbService = { get: () => KB } as unknown as KnowledgeBaseService;

const paths: string[] = [];
function tmpStore(): JsonStore {
  const p = join(tmpdir(), `levi-engine-${process.pid}-${paths.length}.json`);
  paths.push(p);
  return new JsonStore(p);
}
afterEach(() => {
  for (const p of paths) if (existsSync(p)) rmSync(p);
  paths.length = 0;
});

const relayer = generateX25519Keypair();
const SECRET_HEX = bytesToHex(relayer.secretKey);
const cfgWith = (secret?: string) => ({ relayerX25519Secret: secret }) as unknown as RelayerConfig;

const CONFIG: LeviConfig = {
  id: "0xconfig",
  operator: "0xop",
  relayer: "0xrelayer",
  relayerEncryptionKey: new Uint8Array(32),
  escalateThreshold: 40_000,
  blockThreshold: 70_000,
  maxStrikes: 5,
  emaAlpha: 300,
  emaScale: 1000,
  totalAgents: 1n,
  maintenance: false,
};

const AGENT: LeviAgent = {
  id: "0xagent",
  agentWallet: "0xwallet",
  owner: "0xowner",
  spendLimit: 1_000_000n,
  threatScore: 0,
  strikes: 0,
  active: true,
  registeredAt: 0n,
  actionCounter: 1n,
  totalActions: 1n,
  totalApproved: 0n,
  totalBlocked: 0n,
  totalEscalated: 0n,
};

/** Stateful fake: serves the pending action, then the finalized status after a verdict. */
class FakeSui implements EngineSui {
  submitVerdictCalls: { agentId: string; actionId: string; rawScore: number; reasoning: string }[] = [];
  private verdicted = false;
  private lastScore = 0;

  constructor(
    private action: LeviAction,
    private readonly finalStatus: number,
    private readonly agent: LeviAgent = AGENT,
    private readonly allowed: AllowedTarget[] = []
  ) {}

  async getConfig(): Promise<LeviConfig> {
    return CONFIG;
  }
  async getAction(): Promise<LeviAction> {
    return this.verdicted
      ? { ...this.action, status: this.finalStatus, rawScore: this.lastScore }
      : this.action;
  }
  async getAgent(): Promise<LeviAgent> {
    return this.agent;
  }
  async getAllowedTargets(): Promise<AllowedTarget[]> {
    return this.allowed;
  }
  async submitVerdict(p: { agentId: string; actionId: string; rawScore: number; reasoning: string }): Promise<string> {
    this.submitVerdictCalls.push(p);
    this.verdicted = true;
    this.lastScore = p.rawScore;
    return "0xverdictdigest";
  }
}

const fakeAnalyzer = (rawScore: number, reasoning = "fake reasoning"): Analyzer => ({
  name: "fake",
  async analyze(): Promise<AnalysisResult> {
    return { rawScore, reasoning, findings: ["fake finding"], analyzer: "fake" };
  },
});

/** Build an Action whose encrypted payload + commitment are internally consistent. */
function makeAction(over: Partial<LeviAction> = {}, opts: { prompt?: string } = {}): LeviAction {
  const payloadBytes = encodeActionPayload({ prompt: opts.prompt ?? "swap 10 SUI", tx: new Uint8Array() });
  const commitment = commitmentHash(payloadBytes);
  const { payload } = encryptForRelayer({ plaintext: payloadBytes, relayerPublicKey: relayer.publicKey });
  return {
    id: "0xaction",
    agent: "0xagent",
    actionId: 1n,
    targetProgram: "0x2",
    value: 1_000n,
    commitment,
    status: actionStatus.pending,
    decision: 0,
    rawScore: 0,
    reasoningHash: new Uint8Array(32),
    encryptedPayload: payload,
    ...over,
  };
}

function makeEngine(sui: EngineSui, analyzer: Analyzer, secret = SECRET_HEX): { engine: EngineService; store: JsonStore } {
  const store = tmpStore();
  const engine = new EngineService(
    sui,
    analyzer as unknown as AnalyzerService,
    store,
    cfgWith(secret),
    kbService
  );
  return { engine, store };
}

describe("EngineService.processAction", () => {
  it("decrypts, verifies, analyzes, lands a verdict, and persists reasoning", async () => {
    const sui = new FakeSui(makeAction(), actionStatus.approved);
    const { engine, store } = makeEngine(sui, fakeAnalyzer(1500, "looks clean"));

    const res = await engine.processAction("0xaction");

    expect(res.skipped).toBe(false);
    expect(sui.submitVerdictCalls).toHaveLength(1);
    expect(sui.submitVerdictCalls[0].rawScore).toBe(1500);
    expect(sui.submitVerdictCalls[0].reasoning).toBe("looks clean");
    expect(res.decision).toBe("Approved");
    expect(store.getReasoning(res.reasoningHash)).toBe("looks clean");
    expect(store.getAction("0xaction")?.verdictDigest).toBe("0xverdictdigest");
  });

  it("force-blocks a tampered payload (decrypt failure)", async () => {
    const action = makeAction();
    action.encryptedPayload[action.encryptedPayload.length - 1] ^= 0xff;
    const sui = new FakeSui(action, actionStatus.blocked);
    const { engine } = makeEngine(sui, fakeAnalyzer(0));

    const res = await engine.processAction("0xaction");

    expect(sui.submitVerdictCalls[0].rawScore).toBe(100_000);
    expect(res.analyzer).toBe("integrity-guard");
    expect(res.decision).toBe("Blocked");
  });

  it("force-blocks on commitment mismatch", async () => {
    const sui = new FakeSui(makeAction({ commitment: new Uint8Array(32) }), actionStatus.blocked);
    const { engine } = makeEngine(sui, fakeAnalyzer(0));

    const res = await engine.processAction("0xaction");

    expect(sui.submitVerdictCalls[0].rawScore).toBe(100_000);
    expect(res.reasoning).toMatch(/commitment mismatch/i);
  });

  it("skips an action that is not pending (no second verdict)", async () => {
    const sui = new FakeSui(makeAction({ status: actionStatus.approved }), actionStatus.approved);
    const { engine } = makeEngine(sui, fakeAnalyzer(0));

    const res = await engine.processAction("0xaction");

    expect(res.skipped).toBe(true);
    expect(sui.submitVerdictCalls).toHaveLength(0);
  });

  it("is idempotent — a re-processed action lands no second verdict", async () => {
    const sui = new FakeSui(makeAction(), actionStatus.approved);
    const { engine } = makeEngine(sui, fakeAnalyzer(1500));

    await engine.processAction("0xaction");
    const again = await engine.processAction("0xaction");

    expect(again.skipped).toBe(true);
    expect(sui.submitVerdictCalls).toHaveLength(1);
  });

  it("throws an operator fault when the relayer secret is missing", async () => {
    const sui = new FakeSui(makeAction(), actionStatus.approved);
    // Construct directly with no secret (passing undefined to makeEngine would hit its default).
    const engine = new EngineService(
      sui,
      fakeAnalyzer(0) as unknown as AnalyzerService,
      tmpStore(),
      cfgWith(undefined),
      kbService
    );

    await expect(engine.processAction("0xaction")).rejects.toThrow(/RELAYER_X25519_SECRET/);
  });
});
