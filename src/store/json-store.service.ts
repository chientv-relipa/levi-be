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

import type { ActionRecord, RelayerStore } from "./store.interface";

interface StateFile {
  cursor: EventId | null;
  actions: Record<string, ActionRecord>;
  reasoning: Record<string, string>;
  processed: string[];
}

// src/store → ../../data/state.json (CommonJS __dirname).
const DEFAULT_PATH = resolve(__dirname, "..", "..", "data", "state.json");

const emptyState = (): StateFile => ({ cursor: null, actions: {}, reasoning: {}, processed: [] });

/** JSON-file store. Loads on construct, persists synchronously on each mutation. */
@Injectable()
export class JsonStore implements RelayerStore {
  private state: StateFile;
  private readonly processedSet: Set<string>;

  constructor(private readonly path: string = DEFAULT_PATH) {
    this.state = existsSync(path)
      ? { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as StateFile) }
      : emptyState();
    this.processedSet = new Set(this.state.processed);
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.state.processed = Array.from(this.processedSet);
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
}
