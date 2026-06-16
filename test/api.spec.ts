// HTTP routes via NestFastify inject (no network): fake Sui/engine/store exercise every
// endpoint, serialization (no bigint leaks), error shaping ({error}), guards (auth + rate
// limit), the N1 dry-run gate, and escalation links.

import { afterEach, describe, it, expect } from "vitest";
import { APP_GUARD } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { toBase64 } from "@mysten/sui/utils";

import { SystemController } from "../src/api/system/system.controller";
import { AgentsController } from "../src/api/agents/agents.controller";
import { ActionsController } from "../src/api/actions/actions.controller";
import { ReasoningController } from "../src/api/reasoning/reasoning.controller";
import { EscalationController } from "../src/api/escalation/escalation.controller";
import { StatsController } from "../src/api/stats/stats.controller";
import { AgentsManagementController } from "../src/api/agents/agents-management.controller";
import { HealthController } from "../src/api/health.controller";
import { SuiService } from "../src/sui/sui.service";
import { EngineService } from "../src/engine/engine.service";
import { RELAYER_STORE } from "../src/store/store.interface";
import { RELAYER_CONFIG } from "../src/config/relayer-config";
import { RateLimitGuard } from "../src/common/guards/rate-limit.guard";
import { ApiKeyGuard } from "../src/common/guards/api-key.guard";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";
import { actionStatus } from "../src/common/levi-sdk";
import type { LeviConfig, LeviAgent, LeviAction } from "../src/common/levi-sdk";
import type { EngineResult } from "../src/engine/engine.service";
import type { ActionRecord } from "../src/store/store.interface";

const CFG = {
  port: 8787,
  publicBaseUrl: "http://test.local",
  apiKey: undefined as string | undefined,
  rateLimitMax: 100_000,
  rateLimitWindowMs: 60_000,
  addresses: {
    packageId: "0xpkg",
    configId: "0xcfg",
    registryId: "0xreg",
    adminCapId: "0xadmin",
    relayerCapId: "0xrelcap",
  },
};

const CONFIG: LeviConfig = {
  id: "0xcfg",
  operator: "0xop",
  relayer: "0xrelayer",
  relayerEncryptionKey: new Uint8Array(32).fill(7),
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
  actionCounter: 5n,
  totalActions: 5n,
  totalApproved: 4n,
  totalBlocked: 1n,
  totalEscalated: 0n,
};

const approvedVerdict = (): EngineResult => ({
  actionObjectId: "0xaction",
  agentId: "0xagent",
  decision: "Approved",
  rawScore: 1500,
  reasoning: "looks clean",
  reasoningHash: "abcd",
  analyzer: "rule-based",
  status: actionStatus.approved,
  verdictDigest: "0xverdict",
  skipped: false,
});

const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  for (const a of apps) await a.close().catch(() => {});
  apps.length = 0;
});

async function makeApp(over: Record<string, any> = {}): Promise<NestFastifyApplication> {
  const cfg = { ...CFG, ...(over.cfg ?? {}) };
  const fakeSui = {
    address: "0xrelayer",
    async getConfig(): Promise<LeviConfig> {
      return CONFIG;
    },
    async getAgentIdByWallet(addr: string) {
      return addr === "0xwallet" ? "0xagent" : null;
    },
    async getAgent(): Promise<LeviAgent> {
      return AGENT;
    },
    async getAllowedTargets() {
      return over.allowedTargets ?? [];
    },
    async getAction(): Promise<LeviAction> {
      if (over.action) return over.action;
      throw new Error("not found");
    },
    async buildSponsoredSubmit() {
      return new Uint8Array([1, 2, 3, 4]);
    },
    async buildSponsoredApprove() {
      return new Uint8Array([9, 9]);
    },
    async buildSponsoredReject() {
      return new Uint8Array([8, 8]);
    },
    async executeSponsored() {
      return (
        over.executeResult ?? {
          digest: "0xdigest",
          effects: { status: { status: "success" } },
          objectChanges: [{ type: "created", objectType: "0xpkg::action::Action", objectId: "0xaction" }],
        }
      );
    },
    assertSponsorable() {},
    submitTarget: () => "0xpkg::submit_action::submit_action",
    resolutionTargets: () => ["0xpkg::approve_action::approve_action", "0xpkg::reject_action::reject_action"],
    agentManagementTargets: () => [
      "0xpkg::register_agent::register_agent",
      "0xpkg::activate_agent::activate_agent",
      "0xpkg::deactivate_agent::deactivate_agent",
      "0xpkg::update_agent_program_target::update_agent_program_target",
    ],
    async buildSponsoredRegister() {
      return new Uint8Array([7, 7]);
    },
    async buildSponsoredActivate() {
      return new Uint8Array([7, 1]);
    },
    async buildSponsoredDeactivate() {
      return new Uint8Array([7, 2]);
    },
    async buildSponsoredUpdateTarget() {
      return new Uint8Array([7, 3]);
    },
    async dryRunSponsored() {
      return over.dryRun ?? { success: true };
    },
  };
  const fakeEngine = {
    async processAction(): Promise<EngineResult> {
      return over.verdict ?? approvedVerdict();
    },
  };
  const fakeStore = {
    getAction: (_id: string) => over.record as ActionRecord | undefined,
    getReasoning: (_h: string) => over.reasoning as string | undefined,
    listActions: () => (over.records as ActionRecord[] | undefined) ?? [],
    saveAction() {},
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [
      SystemController,
      AgentsController,
      ActionsController,
      ReasoningController,
      EscalationController,
      StatsController,
      AgentsManagementController,
      HealthController,
    ],
    providers: [
      { provide: SuiService, useValue: fakeSui },
      { provide: EngineService, useValue: fakeEngine },
      { provide: RELAYER_STORE, useValue: fakeStore },
      { provide: RELAYER_CONFIG, useValue: cfg },
      { provide: APP_GUARD, useClass: RateLimitGuard },
      { provide: APP_GUARD, useClass: ApiKeyGuard },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix("api/v1", { exclude: ["health"] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  apps.push(app);
  return app;
}

describe("HTTP API", () => {
  it("GET /health", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, relayer: "0xrelayer" });
  });

  it("GET /api/v1/system/config exposes encryption key + thresholds", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/system/config" });
    const body = res.json();
    expect(body.packageId).toBe("0xpkg");
    expect(body.relayerAddress).toBe("0xrelayer");
    expect(body.relayerEncryptionKey).toBe("0x" + "07".repeat(32));
    expect(body.thresholds).toEqual({ escalate: 40_000, block: 70_000 });
  });

  it("GET check-registration: registered, unregistered, and missing param", async () => {
    const app = await makeApp();
    const ok = await app.inject({ url: "/api/v1/agents/check-registration?agentAddress=0xwallet" });
    expect(ok.json()).toMatchObject({ registered: true, agentId: "0xagent", spendLimit: "1000000" });

    const no = await app.inject({ url: "/api/v1/agents/check-registration?agentAddress=0xother" });
    expect(no.json()).toEqual({ registered: false, agentAddress: "0xother" });

    const bad = await app.inject({ url: "/api/v1/agents/check-registration" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/agentAddress/);
  });

  it("POST build-submit defaults action_id to counter+1", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/build-submit",
      payload: {
        agentWallet: "0xwallet",
        targetProgram: "0x2",
        value: "1000",
        encryptedPayload: toBase64(new Uint8Array([1, 2, 3])),
        commitmentHash: toBase64(new Uint8Array(32)),
      },
    });
    const body = res.json();
    expect(body.actionId).toBe("6"); // agent.actionCounter (5) + 1
    expect(body.gasOwner).toBe("0xrelayer");
    expect(typeof body.transaction).toBe("string");
  });

  it("POST build-submit 404s for an unregistered agent", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/build-submit",
      payload: { agentWallet: "0xnope", targetProgram: "0x2", value: "1", encryptedPayload: "AA==", commitmentHash: "AA==" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST submit broadcasts and returns a synchronous verdict (Approved → no escalation)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/submit",
      payload: { transaction: toBase64(new Uint8Array([1])), signature: "sig" },
    });
    const body = res.json();
    expect(body.digest).toBe("0xdigest");
    expect(body.actionId).toBe("0xaction");
    expect(body.verdict.decision).toBe("Approved");
    expect(body.verdict.escalation).toBeNull();
  });

  it("POST submit surfaces escalation links when Escalated", async () => {
    const verdict: EngineResult = { ...approvedVerdict(), decision: "Escalated", status: actionStatus.escalated, rawScore: 50_000 };
    const app = await makeApp({ verdict });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/submit",
      payload: { transaction: toBase64(new Uint8Array([1])), signature: "sig" },
    });
    const esc = res.json().verdict.escalation;
    expect(esc.approve).toBe("http://test.local/api/v1/actions/0xaction/build-approve");
    expect(esc.review).toBe("http://test.local/api/v1/actions/0xaction");
  });

  it("POST submit 400s when missing fields", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/actions/submit", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("POST submit refuses to sponsor a tx that would abort on-chain (N1 dry-run)", async () => {
    const app = await makeApp({ dryRun: { success: false, error: "EDuplicateActionId" } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/submit",
      payload: { transaction: toBase64(new Uint8Array([1])), signature: "sig" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/would fail on-chain/i);
  });

  it("requires x-api-key on POST when configured (N2 auth)", async () => {
    const app = await makeApp({ cfg: { apiKey: "s3cret" } });

    const noKey = await app.inject({
      method: "POST",
      url: "/api/v1/actions/submit",
      payload: { transaction: toBase64(new Uint8Array([1])), signature: "sig" },
    });
    expect(noKey.statusCode).toBe(401);

    const withKey = await app.inject({
      method: "POST",
      url: "/api/v1/actions/submit",
      headers: { "x-api-key": "s3cret" },
      payload: { transaction: toBase64(new Uint8Array([1])), signature: "sig" },
    });
    expect(withKey.statusCode).toBe(200);

    const getOk = await app.inject({ url: "/api/v1/system/config" });
    expect(getOk.statusCode).toBe(200);
  });

  it("rate-limits per IP (N2)", async () => {
    const app = await makeApp({ cfg: { rateLimitMax: 2, rateLimitWindowMs: 60_000 } });
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    const third = await app.inject({ url: "/health" });
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("GET /api/v1/actions/:id returns the stored record + reasoning", async () => {
    const record: ActionRecord = {
      actionObjectId: "0xaction",
      agentId: "0xagent",
      onchainActionId: "5",
      targetProgram: "0x2",
      value: "1000",
      status: actionStatus.approved,
      decision: "Approved",
      rawScore: 1500,
      analyzer: "rule-based",
      reasoningHash: "abcd",
      verdictDigest: "0xverdict",
      createdAt: new Date().toISOString(),
    };
    const app = await makeApp({ record, reasoning: "the full reasoning" });
    const res = await app.inject({ url: "/api/v1/actions/0xaction" });
    const body = res.json();
    expect(body.decision).toBe("Approved");
    expect(body.value).toBe("1000");
    expect(body.reasoning).toBe("the full reasoning");
  });

  it("GET /api/v1/reasoning/:hash returns text or 404", async () => {
    const app1 = await makeApp({ reasoning: "why" });
    const ok = await app1.inject({ url: "/api/v1/reasoning/0xABCD" });
    expect(ok.json()).toEqual({ hash: "abcd", reasoning: "why" });

    const app2 = await makeApp();
    const miss = await app2.inject({ url: "/api/v1/reasoning/dead" });
    expect(miss.statusCode).toBe(404);
  });

  it("POST build-approve returns an unsigned sponsored tx", async () => {
    const record = { agentId: "0xagent" } as ActionRecord;
    const app = await makeApp({ record });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/0xaction/build-approve",
      payload: { ownerAddress: "0xowner" },
    });
    const body = res.json();
    expect(body.kind).toBe("approve");
    expect(body.agentId).toBe("0xagent");
    expect(typeof body.transaction).toBe("string");
  });

  // ----- dashboard endpoints -----

  const rec = (over: Partial<ActionRecord> = {}): ActionRecord => ({
    actionObjectId: "0xa1",
    agentId: "0xagent",
    onchainActionId: "1",
    targetProgram: "0x2",
    value: "1000",
    status: actionStatus.approved,
    decision: "Approved",
    rawScore: 1500,
    analyzer: "claude",
    reasoningHash: "abcd",
    createdAt: new Date().toISOString(),
    ...over,
  });

  it("GET /api/v1/stats aggregates counts by decision", async () => {
    const records = [rec({ actionObjectId: "0xa1", decision: "Approved" }), rec({ actionObjectId: "0xa2", decision: "Blocked" }), rec({ actionObjectId: "0xa3", decision: "Blocked", agentId: "0xagent2" })];
    const res = await (await makeApp({ records })).inject({ url: "/api/v1/stats" });
    const body = res.json();
    expect(body.totalActions).toBe(3);
    expect(body.agents).toBe(2);
    expect(body.byDecision).toMatchObject({ Approved: 1, Blocked: 2 });
  });

  it("GET /api/v1/actions lists + filters by decision", async () => {
    const records = [rec({ actionObjectId: "0xa1", decision: "Approved" }), rec({ actionObjectId: "0xa2", decision: "Blocked" })];
    const app = await makeApp({ records });
    const all = await app.inject({ url: "/api/v1/actions" });
    expect(all.json().total).toBe(2);
    const blocked = await app.inject({ url: "/api/v1/actions?decision=Blocked" });
    expect(blocked.json().total).toBe(1);
    expect(blocked.json().items[0].decision).toBe("Blocked");
  });

  it("GET /api/v1/agents/:id returns on-chain agent view (no bigint)", async () => {
    const res = await (await makeApp()).inject({ url: "/api/v1/agents/0xagent" });
    const body = res.json();
    expect(body.agentId).toBe("0xagent");
    expect(body.spendLimit).toBe("1000000"); // bigint → string
    expect(body.owner).toBe("0xowner");
    expect(Array.isArray(body.allowedTargets)).toBe(true);
  });

  it("GET /api/v1/agents lists distinct agents from the action log", async () => {
    const records = [rec({ agentId: "0xagent" }), rec({ actionObjectId: "0xa2", agentId: "0xagent" })];
    const res = await (await makeApp({ records })).inject({ url: "/api/v1/agents" });
    const body = res.json();
    expect(body.total).toBe(1); // distinct
    expect(body.items[0].agentId).toBe("0xagent");
  });

  // ----- owner-management endpoints -----

  it("POST /api/v1/agents/build-register returns an unsigned sponsored tx", async () => {
    const res = await (await makeApp()).inject({
      method: "POST",
      url: "/api/v1/agents/build-register",
      payload: { ownerAddress: "0xowner", agentWallet: "0xwallet", spendLimit: "1000000" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.transaction).toBe("string");
    expect(body.gasOwner).toBe("0xrelayer");
  });

  it("POST /api/v1/agents/:id/build-activate returns an unsigned tx", async () => {
    const res = await (await makeApp()).inject({
      method: "POST",
      url: "/api/v1/agents/0xagent/build-activate",
      payload: { ownerAddress: "0xowner" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentId).toBe("0xagent");
  });

  it("POST /api/v1/agents/execute broadcasts + returns the created agentId on register", async () => {
    const executeResult = {
      digest: "0xreg",
      effects: { status: { status: "success" } },
      objectChanges: [{ type: "created", objectType: "0xpkg::agent::Agent", objectId: "0xnewagent" }],
    };
    const res = await (await makeApp({ executeResult })).inject({
      method: "POST",
      url: "/api/v1/agents/execute",
      payload: { transaction: toBase64(new Uint8Array([1])), signature: "sig" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentId).toBe("0xnewagent");
    expect(res.json().digest).toBe("0xreg");
  });
});
