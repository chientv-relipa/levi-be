// Relayer persistence: the action log, full reasoning keyed by its on-chain hash, the set
// of already-processed actions (idempotency), and the watcher's event cursor.
//
// On-chain the contract stores only blake3(reasoning); the human-readable reasoning lives
// here and is served by `GET /reasoning/:hash`. A flat JSON file is enough for the hackathon
// volume; swap the backing store later without touching the RelayerStore interface.

import { Injectable } from "@nestjs/common";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EventId } from "@mysten/sui/client";

import type {
  ActionRecord,
  AgentPolicyState,
  RelayerStore,
  StoredPolicy,
} from "./store.interface";

interface StateFile {
  cursor: EventId | null;
  actions: Record<string, ActionRecord>;
  reasoning: Record<string, string>;
  processed: string[];
  agentNames: Record<string, string>;
  archivedAgents: string[];
  disabledPolicies: string[];
  removedPolicies: string[];
  customPolicies: StoredPolicy[];
  /** Per-agent policy overlay (workspace model). */
  agentPolicies: Record<string, AgentPolicyState>;
}

// src/store → ../../data/state.json (CommonJS __dirname).
const DEFAULT_PATH = resolve(__dirname, "..", "..", "data", "state.json");

const emptyState = (): StateFile => ({
  cursor: null,
  actions: {},
  reasoning: {},
  processed: [],
  agentNames: {},
  archivedAgents: [],
  disabledPolicies: [],
  removedPolicies: [],
  customPolicies: [],
  agentPolicies: {},
});

/** JSON-file store. Loads on construct, persists synchronously on each mutation. */
@Injectable()
export class JsonStore implements RelayerStore {
  private state: StateFile;
  private readonly processedSet: Set<string>;
  private readonly archivedSet: Set<string>;
  private readonly disabledPolicySet: Set<string>;
  private readonly removedPolicySet: Set<string>;

  constructor(private readonly path: string = DEFAULT_PATH) {
    this.state = existsSync(path)
      ? { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as StateFile) }
      : emptyState();
    this.processedSet = new Set(this.state.processed);
    this.archivedSet = new Set(this.state.archivedAgents ?? []);
    this.disabledPolicySet = new Set(this.state.disabledPolicies ?? []);
    this.removedPolicySet = new Set(this.state.removedPolicies ?? []);
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.state.processed = Array.from(this.processedSet);
    this.state.archivedAgents = Array.from(this.archivedSet);
    this.state.disabledPolicies = Array.from(this.disabledPolicySet);
    this.state.removedPolicies = Array.from(this.removedPolicySet);
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  getCursor(): EventId | null {
    return this.state.cursor;
  }
  setCursor(cursor: EventId | null): void {
    this.state.cursor = cursor;
    this.persist();
  }

  isProcessed(actionObjectId: string): boolean {
    return this.processedSet.has(actionObjectId);
  }
  markProcessed(actionObjectId: string): void {
    this.processedSet.add(actionObjectId);
    this.persist();
  }

  saveAction(record: ActionRecord): void {
    this.state.actions[record.actionObjectId] = record;
    this.persist();
  }
  getAction(actionObjectId: string): ActionRecord | undefined {
    return this.state.actions[actionObjectId];
  }
  listActions(): ActionRecord[] {
    return Object.values(this.state.actions);
  }

  saveReasoning(hashHex: string, reasoning: string): void {
    this.state.reasoning[hashHex] = reasoning;
    this.persist();
  }
  getReasoning(hashHex: string): string | undefined {
    return this.state.reasoning[hashHex];
  }

  setAgentName(agentId: string, name: string): void {
    this.state.agentNames[agentId] = name;
    this.persist();
  }
  getAgentName(agentId: string): string | undefined {
    return this.state.agentNames?.[agentId];
  }

  setAgentArchived(agentId: string, archived: boolean): void {
    if (archived) this.archivedSet.add(agentId);
    else this.archivedSet.delete(agentId);
    this.persist();
  }
  isAgentArchived(agentId: string): boolean {
    return this.archivedSet.has(agentId);
  }

  setPolicyEnabled(policyId: string, enabled: boolean): void {
    if (enabled) this.disabledPolicySet.delete(policyId);
    else this.disabledPolicySet.add(policyId);
    this.persist();
  }
  isPolicyDisabled(policyId: string): boolean {
    return this.disabledPolicySet.has(policyId);
  }

  listCustomPolicies(): StoredPolicy[] {
    return this.state.customPolicies ?? [];
  }
  addCustomPolicy(policy: StoredPolicy): void {
    this.state.customPolicies = [...(this.state.customPolicies ?? []), policy];
    this.persist();
  }
  deleteCustomPolicy(policyId: string): boolean {
    const before = this.state.customPolicies ?? [];
    const after = before.filter((p) => p.id !== policyId);
    this.state.customPolicies = after;
    this.disabledPolicySet.delete(policyId);
    this.persist();
    return after.length !== before.length;
  }

  setPolicyRemoved(policyId: string, removed: boolean): void {
    if (removed) this.removedPolicySet.add(policyId);
    else this.removedPolicySet.delete(policyId);
    this.persist();
  }
  isPolicyRemoved(policyId: string): boolean {
    return this.removedPolicySet.has(policyId);
  }

  // ---- Per-agent policy overlay ----

  /** Get (creating if needed) the mutable overlay for one agent. */
  private agentPol(agentId: string): AgentPolicyState {
    const map = (this.state.agentPolicies ??= {});
    return (map[agentId] ??= { disabled: [], removed: [], custom: [] });
  }

  setAgentPolicyEnabled(agentId: string, policyId: string, enabled: boolean): void {
    const ap = this.agentPol(agentId);
    ap.disabled = enabled
      ? ap.disabled.filter((id) => id !== policyId)
      : [...new Set([...ap.disabled, policyId])];
    this.persist();
  }
  isAgentPolicyDisabled(agentId: string, policyId: string): boolean {
    return !!this.state.agentPolicies?.[agentId]?.disabled.includes(policyId);
  }

  setAgentPolicyRemoved(agentId: string, policyId: string, removed: boolean): void {
    const ap = this.agentPol(agentId);
    ap.removed = removed
      ? [...new Set([...ap.removed, policyId])]
      : ap.removed.filter((id) => id !== policyId);
    this.persist();
  }
  isAgentPolicyRemoved(agentId: string, policyId: string): boolean {
    return !!this.state.agentPolicies?.[agentId]?.removed.includes(policyId);
  }

  listAgentCustomPolicies(agentId: string): StoredPolicy[] {
    return this.state.agentPolicies?.[agentId]?.custom ?? [];
  }
  addAgentCustomPolicy(agentId: string, policy: StoredPolicy): void {
    this.agentPol(agentId).custom.push(policy);
    this.persist();
  }
  deleteAgentCustomPolicy(agentId: string, policyId: string): boolean {
    const ap = this.agentPol(agentId);
    const before = ap.custom.length;
    ap.custom = ap.custom.filter((p) => p.id !== policyId);
    ap.disabled = ap.disabled.filter((id) => id !== policyId);
    this.persist();
    return ap.custom.length !== before;
  }
}
