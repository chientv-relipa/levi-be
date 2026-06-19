import { Inject, Injectable } from "@nestjs/common";
import { SuiClient, type EventId, type SuiTransactionBlockResponse } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";
import { blake3 } from "@noble/hashes/blake3";

import { RELAYER_CONFIG, type RelayerConfig } from "../config/relayer-config";
import type { LeviConfig, LeviAgent, LeviAction, AllowedTarget } from "../common/levi-sdk";
import { MODULES } from "../common/levi-sdk";

// vector<u8> object fields come back from JSON-RPC as base64; normalize to bytes.
const toBytes = (v: unknown): Uint8Array =>
  typeof v === "string" ? fromBase64(v) : Uint8Array.from(v as number[]);
const contentFields = (res: any): any => res?.data?.content?.fields;

/** Max gas the sponsor (backend) will cover for a single sponsored transaction. */
export const MAX_SPONSOR_GAS_BUDGET = 100_000_000n; // 0.1 SUI

const normalizeTarget = (t: string): string => {
  const [pkg, mod, fn] = t.split("::");
  return `${normalizeSuiAddress(pkg)}::${mod}::${fn}`;
};

/** Find the first created object whose type ends with `suffix` (e.g. "::agent::Agent"). */
function findCreatedObjectId(res: SuiTransactionBlockResponse, suffix: string): string | null {
  for (const c of res.objectChanges ?? []) {
    if (c.type === "created" && c.objectType.endsWith(suffix)) return c.objectId;
  }
  return null;
}

export interface ActionSubmittedEvent {
  action: string; // Action object ID
  agent: string; // Agent object ID
  actionId: bigint;
}

/**
 * Backend-owned Sui layer: one `SuiClient` + the relayer signer, plus typed readers, the
 * `ActionSubmitted` event query, sponsored-tx builders/guards, and `verdict_action`.
 */
@Injectable()
export class SuiService {
  readonly client: SuiClient;
  readonly signer: Ed25519Keypair;
  readonly address: string;

  constructor(@Inject(RELAYER_CONFIG) private readonly cfg: RelayerConfig) {
    this.client = new SuiClient({ url: cfg.rpcUrl });
    const { secretKey } = decodeSuiPrivateKey(cfg.operatorSecretKey);
    this.signer = Ed25519Keypair.fromSecretKey(secretKey);
    this.address = this.signer.getPublicKey().toSuiAddress();
  }

  get pkg(): string {
    return this.cfg.addresses.packageId;
  }

  // ----- readers -----

  async getConfig(): Promise<LeviConfig> {
    const res = await this.client.getObject({
      id: this.cfg.addresses.configId,
      options: { showContent: true },
    });
    const f = contentFields(res);
    return {
      id: this.cfg.addresses.configId,
      operator: f.operator,
      relayer: f.relayer,
      relayerEncryptionKey: toBytes(f.relayer_encryption_key),
      escalateThreshold: Number(f.escalate_threshold),
      blockThreshold: Number(f.block_threshold),
      maxStrikes: Number(f.max_strikes),
      emaAlpha: Number(f.ema_alpha),
      emaScale: Number(f.ema_scale),
      totalAgents: BigInt(f.total_agents),
      maintenance: Boolean(f.maintenance),
    };
  }

  /** Resolve an Agent object ID from a wallet via the on-chain AgentRegistry (null if unregistered). */
  async getAgentIdByWallet(agentWallet: string): Promise<string | null> {
    const reg = await this.client.getObject({
      id: this.cfg.addresses.registryId,
      options: { showContent: true },
    });
    const tableId = contentFields(reg)?.agents?.fields?.id?.id;
    if (!tableId) return null;
    try {
      const field = await this.client.getDynamicFieldObject({
        parentId: tableId,
        name: { type: "address", value: agentWallet },
      });
      return ((field?.data?.content as any)?.fields?.value as string) ?? null;
    } catch {
      return null;
    }
  }

  /** All Agent object IDs owned by `owner`, resolved from on-chain RegisterAgent events.
   *  Unlike the action-log listing, this includes agents that have submitted zero actions. */
  async getAgentIdsByOwner(owner: string): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor: EventId | null = null;
    // RegisterAgent events are few on testnet; paginate defensively.
    for (let page = 0; page < 20; page++) {
      const res = await this.client.queryEvents({
        query: { MoveEventType: `${this.pkg}::events::RegisterAgent` },
        cursor,
        order: "ascending",
      });
      for (const e of res.data) {
        const p = e.parsedJson as { agent_id: string; agent_wallet: string; owner: string };
        if (p.owner === owner && !seen.has(p.agent_id)) {
          seen.add(p.agent_id);
          ids.push(p.agent_id);
        }
      }
      if (!res.hasNextPage || !res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return ids;
  }

  async getAgent(agentId: string): Promise<LeviAgent> {
    const res = await this.client.getObject({ id: agentId, options: { showContent: true } });
    const f = contentFields(res);
    return {
      id: agentId,
      agentWallet: f.agent_wallet,
      owner: f.owner,
      spendLimit: BigInt(f.spend_limit),
      threatScore: Number(f.threat_score),
      strikes: Number(f.strikes),
      active: Boolean(f.active),
      registeredAt: BigInt(f.registered_at),
      actionCounter: BigInt(f.action_counter),
      totalActions: BigInt(f.total_actions),
      totalApproved: BigInt(f.total_approved),
      totalBlocked: BigInt(f.total_blocked),
      totalEscalated: BigInt(f.total_escalated),
    };
  }

  async getAllowedTargets(agentId: string): Promise<AllowedTarget[]> {
    const res = await this.client.getObject({ id: agentId, options: { showContent: true } });
    const arr = contentFields(res)?.allowed_targets ?? [];
    return arr.map((e: any) => ({ target: e.fields.target, allowed: Boolean(e.fields.allowed) }));
  }

  async getAction(actionId: string): Promise<LeviAction> {
    const res = await this.client.getObject({ id: actionId, options: { showContent: true } });
    const f = contentFields(res);
    return {
      id: actionId,
      agent: f.agent,
      actionId: BigInt(f.action_id),
      targetProgram: f.target_program,
      value: BigInt(f.value),
      commitment: toBytes(f.commitment),
      status: Number(f.status),
      decision: Number(f.decision),
      rawScore: Number(f.raw_score),
      reasoningHash: toBytes(f.reasoning_hash),
      encryptedPayload: toBytes(f.encrypted_payload),
    };
  }

  // ----- events -----

  /** Poll `ActionSubmitted` events from `cursor` (ascending). */
  async queryActionSubmitted(
    cursor: EventId | null
  ): Promise<{ events: ActionSubmittedEvent[]; nextCursor: EventId | null }> {
    const res = await this.client.queryEvents({
      query: { MoveEventType: `${this.pkg}::events::ActionSubmitted` },
      cursor: cursor ?? null,
      order: "ascending",
    });
    const events = res.data.map((e) => {
      const p = e.parsedJson as { action: string; agent: string; action_id: string };
      return { action: p.action, agent: p.agent, actionId: BigInt(p.action_id) };
    });
    return { events, nextCursor: res.nextCursor ?? null };
  }

  // ----- verdict -----

  /** Land a verdict (requires the relayer signer to hold the RelayerCap). */
  async submitVerdict(p: {
    agentId: string;
    actionId: string;
    rawScore: number;
    reasoning: string;
  }): Promise<string> {
    const reasoningHash = Array.from(blake3(new TextEncoder().encode(p.reasoning)));
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.pkg}::${MODULES.verdictAction}::${MODULES.verdictAction}`,
      arguments: [
        tx.object(this.cfg.addresses.relayerCapId),
        tx.object(this.cfg.addresses.configId),
        tx.object(p.agentId),
        tx.object(p.actionId),
        tx.pure.u32(p.rawScore),
        tx.pure.vector("u8", reasoningHash),
      ],
    });
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.signer,
      options: { showEffects: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    return res.digest;
  }

  // ----- agent lifecycle -----

  /** Register an agent (signer = owner). Returns the created Agent object ID. */
  async registerAgent(p: {
    agentWallet: string;
    spendLimit: bigint | number;
  }): Promise<{ digest: string; agentId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.pkg}::${MODULES.registerAgent}::${MODULES.registerAgent}`,
      arguments: [
        tx.object(this.cfg.addresses.configId),
        tx.object(this.cfg.addresses.registryId),
        tx.pure.address(p.agentWallet),
        tx.pure.u64(p.spendLimit),
      ],
    });
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.signer,
      options: { showObjectChanges: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    const agentId = findCreatedObjectId(res, "::agent::Agent");
    if (!agentId) throw new Error("register_agent: Agent object not found in tx effects");
    return { digest: res.digest, agentId };
  }

  // ----- owner escalation resolution (direct, owner-signed) -----
  // Used in the demo where owner == operator (this.signer). For a separate-wallet owner,
  // use the sponsored build-approve/build-reject + resolve HTTP flow instead.

  /** Owner approves an escalated action (Escalated → Approved). Signer must be the owner. */
  async approveAction(p: { agentId: string; actionId: string }): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.pkg}::${MODULES.approveAction}::${MODULES.approveAction}`,
      arguments: [tx.object(p.agentId), tx.object(p.actionId)],
    });
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.signer,
      options: { showEffects: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    return res.digest;
  }

  /** Owner rejects an escalated action (Escalated → Rejected, +strike). Signer must be the owner. */
  async rejectAction(p: { agentId: string; actionId: string }): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.pkg}::${MODULES.rejectAction}::${MODULES.rejectAction}`,
      arguments: [
        tx.object(this.cfg.addresses.configId),
        tx.object(p.agentId),
        tx.object(p.actionId),
      ],
    });
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.signer,
      options: { showEffects: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    return res.digest;
  }

  // ----- owner management: sponsored, owner-signed builders (for the dashboard UI) -----
  // Same pattern as escalation: relayer builds an UNSIGNED tx (sender = owner, gas = relayer),
  // the owner signs in the browser, then `agents/execute` broadcasts it.

  /** Allowed moveCall targets for the owner-management `execute` flow. */
  agentManagementTargets(): string[] {
    return [
      `${this.pkg}::${MODULES.registerAgent}::${MODULES.registerAgent}`,
      `${this.pkg}::${MODULES.activateAgent}::${MODULES.activateAgent}`,
      `${this.pkg}::${MODULES.deactivateAgent}::${MODULES.deactivateAgent}`,
      `${this.pkg}::${MODULES.updateAgentProgramTarget}::${MODULES.updateAgentProgramTarget}`,
    ];
  }

  private async buildSponsoredOwnerTx(
    ownerAddress: string,
    gasBudget: number | undefined,
    build: (tx: Transaction) => void
  ): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(ownerAddress);
    tx.setGasOwner(this.address);
    tx.setGasBudget(gasBudget ?? 50_000_000);
    tx.setGasPayment(await this.sponsorGasPayment());
    build(tx);
    return tx.build({ client: this.client });
  }

  /** Build an UNSIGNED, gas-sponsored `register_agent` tx (sender = owner). */
  buildSponsoredRegister(p: {
    ownerAddress: string;
    agentWallet: string;
    spendLimit: bigint | number;
    gasBudget?: number;
  }): Promise<Uint8Array> {
    return this.buildSponsoredOwnerTx(p.ownerAddress, p.gasBudget, (tx) =>
      tx.moveCall({
        target: `${this.pkg}::${MODULES.registerAgent}::${MODULES.registerAgent}`,
        arguments: [
          tx.object(this.cfg.addresses.configId),
          tx.object(this.cfg.addresses.registryId),
          tx.pure.address(p.agentWallet),
          tx.pure.u64(p.spendLimit),
        ],
      })
    );
  }

  /** Build an UNSIGNED, gas-sponsored `activate_agent` tx (sender = owner). */
  buildSponsoredActivate(p: { ownerAddress: string; agentId: string; gasBudget?: number }): Promise<Uint8Array> {
    return this.buildSponsoredOwnerTx(p.ownerAddress, p.gasBudget, (tx) =>
      tx.moveCall({
        target: `${this.pkg}::${MODULES.activateAgent}::${MODULES.activateAgent}`,
        arguments: [tx.object(this.cfg.addresses.configId), tx.object(p.agentId)],
      })
    );
  }

  /** Build an UNSIGNED, gas-sponsored `deactivate_agent` tx (sender = owner). */
  buildSponsoredDeactivate(p: { ownerAddress: string; agentId: string; gasBudget?: number }): Promise<Uint8Array> {
    return this.buildSponsoredOwnerTx(p.ownerAddress, p.gasBudget, (tx) =>
      tx.moveCall({
        target: `${this.pkg}::${MODULES.deactivateAgent}::${MODULES.deactivateAgent}`,
        arguments: [tx.object(this.cfg.addresses.configId), tx.object(p.agentId)],
      })
    );
  }

  /** Build an UNSIGNED, gas-sponsored `update_agent_program_target` tx (sender = owner). */
  buildSponsoredUpdateTarget(p: {
    ownerAddress: string;
    agentId: string;
    target: string;
    allowed: boolean;
    gasBudget?: number;
  }): Promise<Uint8Array> {
    return this.buildSponsoredOwnerTx(p.ownerAddress, p.gasBudget, (tx) =>
      tx.moveCall({
        target: `${this.pkg}::${MODULES.updateAgentProgramTarget}::${MODULES.updateAgentProgramTarget}`,
        arguments: [
          tx.object(this.cfg.addresses.configId),
          tx.object(p.agentId),
          tx.pure.address(p.target),
          tx.pure.bool(p.allowed),
        ],
      })
    );
  }

  // ----- sponsored transactions (backend pays gas; user is the sender) -----

  /** Gas coins owned by the sponsor (backend), for explicit sponsored gas payment. */
  private async sponsorGasPayment() {
    const { data } = await this.client.getCoins({ owner: this.address, limit: 10 });
    if (data.length === 0) {
      throw new Error(`sponsor ${this.address} has no SUI coins to pay gas`);
    }
    return data.map((c) => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest }));
  }

  /**
   * Build an UNSIGNED, gas-sponsored `submit_action` transaction: sender = agent wallet,
   * gas owner = backend (this.address). Returns the tx bytes for the agent to sign.
   */
  async buildSponsoredSubmit(p: {
    agentWallet: string;
    agentId: string;
    targetProgram: string;
    value: bigint | number;
    actionId: bigint | number;
    encryptedPayload: Uint8Array | number[];
    commitmentHash: Uint8Array | number[];
    gasBudget?: number;
  }): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(p.agentWallet);
    tx.setGasOwner(this.address);
    tx.setGasBudget(p.gasBudget ?? 50_000_000);
    tx.setGasPayment(await this.sponsorGasPayment());
    tx.moveCall({
      target: `${this.pkg}::${MODULES.submitAction}::${MODULES.submitAction}`,
      arguments: [
        tx.object(this.cfg.addresses.configId),
        tx.object(p.agentId),
        tx.pure.address(p.targetProgram),
        tx.pure.u64(p.value),
        tx.pure.u64(p.actionId),
        tx.pure.vector("u8", Array.from(p.encryptedPayload)),
        tx.pure.vector("u8", Array.from(p.commitmentHash)),
      ],
    });
    return tx.build({ client: this.client });
  }

  /** Build an UNSIGNED gas-sponsored `approve_action` tx (sender = owner, gas = backend). */
  async buildSponsoredApprove(p: {
    ownerAddress: string;
    agentId: string;
    actionId: string;
    gasBudget?: number;
  }): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(p.ownerAddress);
    tx.setGasOwner(this.address);
    tx.setGasBudget(p.gasBudget ?? 50_000_000);
    tx.setGasPayment(await this.sponsorGasPayment());
    tx.moveCall({
      target: `${this.pkg}::${MODULES.approveAction}::${MODULES.approveAction}`,
      arguments: [tx.object(p.agentId), tx.object(p.actionId)],
    });
    return tx.build({ client: this.client });
  }

  /** Build an UNSIGNED gas-sponsored `reject_action` tx (sender = owner, gas = backend). */
  async buildSponsoredReject(p: {
    ownerAddress: string;
    agentId: string;
    actionId: string;
    gasBudget?: number;
  }): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(p.ownerAddress);
    tx.setGasOwner(this.address);
    tx.setGasBudget(p.gasBudget ?? 50_000_000);
    tx.setGasPayment(await this.sponsorGasPayment());
    tx.moveCall({
      target: `${this.pkg}::${MODULES.rejectAction}::${MODULES.rejectAction}`,
      arguments: [
        tx.object(this.cfg.addresses.configId),
        tx.object(p.agentId),
        tx.object(p.actionId),
      ],
    });
    return tx.build({ client: this.client });
  }

  /**
   * Validate that `txBytes` is a SINGLE sponsorable moveCall to one of `allowedTargets`, with
   * this backend as gas owner and a bounded gas budget. Throws (never sponsors) on mismatch —
   * the backend must NOT blindly co-sign arbitrary transactions (gas-drain protection).
   */
  assertSponsorable(
    txBytes: Uint8Array,
    allowedTargets: string[],
    maxGasBudget: bigint = MAX_SPONSOR_GAS_BUDGET
  ): void {
    let data: ReturnType<Transaction["getData"]>;
    try {
      data = Transaction.from(txBytes).getData();
    } catch (e) {
      throw new Error(`transaction is not decodable: ${e instanceof Error ? e.message : String(e)}`);
    }

    const owner = data.gasData?.owner;
    if (!owner || normalizeSuiAddress(owner) !== normalizeSuiAddress(this.address)) {
      throw new Error("gas owner is not the relayer sponsor");
    }
    if (data.gasData?.budget != null && BigInt(data.gasData.budget) > maxGasBudget) {
      throw new Error(`gas budget ${data.gasData.budget} exceeds sponsor cap ${maxGasBudget}`);
    }

    const commands = data.commands ?? [];
    if (commands.length !== 1) throw new Error("only a single-command transaction is sponsorable");
    const mc = (commands[0] as any).MoveCall;
    if (!mc) throw new Error("sponsorable transaction must be a single moveCall");

    const target = `${normalizeSuiAddress(mc.package)}::${mc.module}::${mc.function}`;
    if (!allowedTargets.map(normalizeTarget).includes(target)) {
      throw new Error(`moveCall target ${mc.module}::${mc.function} is not sponsorable`);
    }
  }

  /** Allowed moveCall targets for each sponsored flow (used by assertSponsorable). */
  submitTarget(): string {
    return `${this.pkg}::${MODULES.submitAction}::${MODULES.submitAction}`;
  }
  resolutionTargets(): string[] {
    return [
      `${this.pkg}::${MODULES.approveAction}::${MODULES.approveAction}`,
      `${this.pkg}::${MODULES.rejectAction}::${MODULES.rejectAction}`,
    ];
  }

  /**
   * Simulate a sponsored tx before broadcasting. The sponsor pays gas even for a tx that
   * executes and aborts, so we dry-run first and refuse to sponsor anything that would fail.
   */
  async dryRunSponsored(txBytes: Uint8Array): Promise<{ success: boolean; error?: string }> {
    const res = await this.client.dryRunTransactionBlock({ transactionBlock: txBytes });
    const status = res.effects?.status?.status;
    return { success: status === "success", error: res.effects?.status?.error };
  }

  /**
   * Add the backend's sponsor signature to `txBytes` already signed by the sender, then
   * broadcast. `senderSignature` is the agent/owner signature over the same bytes.
   *
   * Edge case: when the sender IS the gas sponsor (e.g. the connected wallet is the relayer
   * itself), one signature already covers both roles — adding a second, identical signature
   * makes Sui reject it ("Expect 1 signer signatures but got 2"). So we only co-sign when the
   * sender and the gas owner are different addresses.
   */
  async executeSponsored(
    txBytes: Uint8Array,
    senderSignature: string
  ): Promise<SuiTransactionBlockResponse> {
    const data = Transaction.from(txBytes).getData();
    const sender = data.sender ? normalizeSuiAddress(data.sender) : undefined;
    const gasOwner = data.gasData?.owner ? normalizeSuiAddress(data.gasData.owner) : undefined;

    const signature =
      sender && gasOwner && sender === gasOwner
        ? [senderSignature]
        : [senderSignature, (await this.signer.signTransaction(txBytes)).signature];

    const res = await this.client.executeTransactionBlock({
      transactionBlock: txBytes,
      signature,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    return res;
  }

  // ----- admin: set relayer encryption key (update_config) -----

  /**
   * Set `Config.relayer_encryption_key` to the relayer's 32-byte x25519 public key.
   * Requires the signer to hold the AdminCap. All other config fields are left unchanged.
   */
  async setRelayerEncryptionKey(publicKey: Uint8Array): Promise<string> {
    if (publicKey.length !== 32) {
      throw new Error(`encryption key must be 32 bytes, got ${publicKey.length}`);
    }
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.pkg}::${MODULES.updateConfig}::${MODULES.updateConfig}`,
      arguments: [
        tx.object(this.cfg.addresses.adminCapId),
        tx.object(this.cfg.addresses.configId),
        tx.pure(bcs.option(bcs.Address).serialize(null)), // relayer
        tx.pure(bcs.option(bcs.vector(bcs.u8())).serialize(Array.from(publicKey))), // encryption key
        tx.pure(bcs.option(bcs.u32()).serialize(null)), // escalate_threshold
        tx.pure(bcs.option(bcs.u32()).serialize(null)), // block_threshold
        tx.pure(bcs.option(bcs.u8()).serialize(null)), // max_strikes
        tx.pure(bcs.option(bcs.u16()).serialize(null)), // ema_alpha
        tx.pure(bcs.option(bcs.u16()).serialize(null)), // ema_scale
      ],
    });
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.signer,
      options: { showEffects: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    return res.digest;
  }
}
