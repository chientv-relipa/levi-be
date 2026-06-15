// C1 guard: the backend must only sponsor the exact instructions it builds. assertSponsorable
// parses the tx bytes and rejects wrong gas owner, wrong target, multi-command, over-budget,
// and undecodable payloads — so a caller can't drain the sponsor's gas on arbitrary txs.

import { describe, it, expect } from "vitest";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

import { SuiService } from "../src/sui/sui.service";
import { TESTNET_ADDRESSES } from "../src/common/levi-sdk";
import type { RelayerConfig } from "../src/config/relayer-config";

const kp = Ed25519Keypair.generate();
const cfg = {
  rpcUrl: "http://localhost:1",
  pollIntervalMs: 1,
  port: 1,
  publicBaseUrl: "",
  rateLimitMax: 1000,
  rateLimitWindowMs: 60_000,
  operatorSecretKey: kp.getSecretKey(),
  addresses: TESTNET_ADDRESSES,
} as RelayerConfig;
const sui = new SuiService(cfg);

const GAS = [{ objectId: "0x" + "c".repeat(64), version: "1", digest: "1".repeat(32) }];

function baseTx(): Transaction {
  const tx = new Transaction();
  tx.setSender("0x" + "a".repeat(64));
  tx.setGasOwner(sui.address); // backend = sponsor
  tx.setGasBudget(50_000_000);
  tx.setGasPrice(1000);
  tx.setGasPayment(GAS);
  return tx;
}

async function bytesOf(tx: Transaction): Promise<Uint8Array> {
  return tx.build();
}

describe("assertSponsorable (C1 gas-sponsor guard)", () => {
  it("accepts a well-formed submit_action sponsored by the backend", async () => {
    const tx = baseTx();
    tx.moveCall({ target: sui.submitTarget(), arguments: [tx.pure.u64(1)] });
    await expect(bytesOf(tx).then((b) => sui.assertSponsorable(b, [sui.submitTarget()]))).resolves.toBeUndefined();
  });

  it("rejects a tx whose gas owner is not the sponsor", async () => {
    const tx = baseTx();
    tx.setGasOwner("0x" + "d".repeat(64));
    tx.moveCall({ target: sui.submitTarget(), arguments: [tx.pure.u64(1)] });
    const b = await bytesOf(tx);
    expect(() => sui.assertSponsorable(b, [sui.submitTarget()])).toThrow(/gas owner/i);
  });

  it("rejects a moveCall to a non-allowed target", async () => {
    const tx = baseTx();
    tx.moveCall({
      target: `${TESTNET_ADDRESSES.packageId}::register_agent::register_agent`,
      arguments: [tx.pure.address("0x" + "e".repeat(64)), tx.pure.u64(1)],
    });
    const b = await bytesOf(tx);
    expect(() => sui.assertSponsorable(b, [sui.submitTarget()])).toThrow(/not sponsorable/i);
  });

  it("rejects a multi-command transaction", async () => {
    const tx = baseTx();
    tx.moveCall({ target: sui.submitTarget(), arguments: [tx.pure.u64(1)] });
    tx.moveCall({ target: sui.submitTarget(), arguments: [tx.pure.u64(2)] });
    const b = await bytesOf(tx);
    expect(() => sui.assertSponsorable(b, [sui.submitTarget()])).toThrow(/single-command/i);
  });

  it("rejects a gas budget over the sponsor cap", async () => {
    const tx = baseTx();
    tx.setGasBudget(500_000_000); // > 0.1 SUI cap
    tx.moveCall({ target: sui.submitTarget(), arguments: [tx.pure.u64(1)] });
    const b = await bytesOf(tx);
    expect(() => sui.assertSponsorable(b, [sui.submitTarget()])).toThrow(/budget/i);
  });

  it("rejects undecodable bytes", () => {
    expect(() => sui.assertSponsorable(new Uint8Array([1, 2, 3]), [sui.submitTarget()])).toThrow(/decodable/i);
  });
});
