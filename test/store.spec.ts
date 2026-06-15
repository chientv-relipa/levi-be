// JsonStore persistence + idempotency, including survival across a reload.

import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

import { JsonStore } from "../src/store/json-store.service";
import type { ActionRecord } from "../src/store/store.interface";

let counter = 0;
const paths: string[] = [];
function tmpPath(): string {
  const p = join(tmpdir(), `levi-store-${process.pid}-${counter++}.json`);
  paths.push(p);
  return p;
}

afterEach(() => {
  for (const p of paths) if (existsSync(p)) rmSync(p);
  paths.length = 0;
});

function rec(id: string): ActionRecord {
  return {
    actionObjectId: id,
    agentId: "0xagent",
    onchainActionId: "7",
    targetProgram: "0x2",
    value: "1000",
    status: 2,
    decision: "Approved",
    rawScore: 1500,
    analyzer: "rule-based",
    reasoningHash: "abcd",
    createdAt: new Date().toISOString(),
  };
}

describe("JsonStore", () => {
  it("tracks processed ids idempotently", () => {
    const s = new JsonStore(tmpPath());
    expect(s.isProcessed("0xa")).toBe(false);
    s.markProcessed("0xa");
    expect(s.isProcessed("0xa")).toBe(true);
  });

  it("saves and reads action records + reasoning by hash", () => {
    const s = new JsonStore(tmpPath());
    s.saveAction(rec("0xaction"));
    s.saveReasoning("abcd", "full reasoning text");
    expect(s.getAction("0xaction")?.decision).toBe("Approved");
    expect(s.getReasoning("abcd")).toBe("full reasoning text");
    expect(s.listActions()).toHaveLength(1);
  });

  it("persists across reloads", () => {
    const path = tmpPath();
    const s1 = new JsonStore(path);
    s1.setCursor({ txDigest: "0xtx", eventSeq: "3" });
    s1.markProcessed("0xa");
    s1.saveAction(rec("0xaction"));
    s1.saveReasoning("hh", "persisted reasoning");

    const s2 = new JsonStore(path);
    expect(s2.getCursor()).toEqual({ txDigest: "0xtx", eventSeq: "3" });
    expect(s2.isProcessed("0xa")).toBe(true);
    expect(s2.getAction("0xaction")?.rawScore).toBe(1500);
    expect(s2.getReasoning("hh")).toBe("persisted reasoning");
  });
});
