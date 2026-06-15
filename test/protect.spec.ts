// Agent client wiring, offline: a stub fetch verifies protect() fetches the relayer key,
// encrypts + commits the payload, signs the built tx, submits, and maps the verdict.

import { describe, it, expect } from "vitest";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64, fromBase64 } from "@mysten/sui/utils";
import { bytesToHex } from "@noble/hashes/utils";

import { protect } from "../client/protect";
import {
  generateX25519Keypair,
  decryptFromAgent,
  decodeActionPayload,
  commitmentHash,
} from "../src/common/levi-sdk";

describe("protect() client", () => {
  it("encrypts, commits, signs, submits, and returns the verdict", async () => {
    const relayer = generateX25519Keypair();
    const agent = Ed25519Keypair.generate();

    const calls: { url: string; body?: any }[] = [];
    let capturedBuildSubmit: any = null;

    const builtTx = await new Transaction()
      .build({ onlyTransactionKind: true })
      .catch(() => new Uint8Array([1, 2, 3]));

    const fetchStub = async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });

      let data: any = {};
      if (url.endsWith("/api/v1/system/config")) {
        data = { relayerEncryptionKey: "0x" + bytesToHex(relayer.publicKey) };
      } else if (url.endsWith("/api/v1/actions/build-submit")) {
        capturedBuildSubmit = body;
        data = { transaction: toBase64(builtTx), agentId: "0xagent", actionId: "1" };
      } else if (url.endsWith("/api/v1/actions/submit")) {
        data = {
          digest: "0xdigest",
          actionId: "0xaction",
          verdict: {
            decision: "Approved",
            rawScore: 1200,
            status: 2,
            reasoning: "clean",
            reasoningHash: "abcd",
            analyzer: "rule-based",
            verdictDigest: "0xverdict",
            escalation: null,
            skipped: false,
          },
        };
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => data };
    };

    const verdict = await protect({
      backendUrl: "http://relayer.test",
      agentKeypair: agent,
      prompt: "swap 10 SUI for USDC",
      targetProgram: "0x2",
      value: 1000n,
      fetchImpl: fetchStub as unknown as typeof fetch,
    });

    expect(verdict.decision).toBe("Approved");
    expect(verdict.digest).toBe("0xdigest");
    expect(verdict.actionId).toBe("0xaction");

    expect(calls.map((c) => c.url)).toEqual([
      "http://relayer.test/api/v1/system/config",
      "http://relayer.test/api/v1/actions/build-submit",
      "http://relayer.test/api/v1/actions/submit",
    ]);

    expect(capturedBuildSubmit.agentWallet).toBe(agent.getPublicKey().toSuiAddress());
    const payload = fromBase64(capturedBuildSubmit.encryptedPayload);
    const { plaintext } = decryptFromAgent({ payload, relayerSecretKey: relayer.secretKey });
    expect(decodeActionPayload(plaintext).prompt).toBe("swap 10 SUI for USDC");

    expect(bytesToHex(fromBase64(capturedBuildSubmit.commitmentHash))).toBe(
      bytesToHex(commitmentHash(plaintext))
    );

    const submitCall = calls.find((c) => c.url.endsWith("/submit"))!;
    expect(typeof submitCall.body.signature).toBe("string");
    expect(submitCall.body.transaction).toBe(toBase64(builtTx));
  });

  it("throws a helpful error when the backend rejects build-submit", async () => {
    const relayer = generateX25519Keypair();
    const fetchStub = async (url: string) => {
      if (url.endsWith("/system/config")) {
        return { ok: true, status: 200, json: async () => ({ relayerEncryptionKey: "0x" + bytesToHex(relayer.publicKey) }) };
      }
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({ error: "agent not registered" }) };
    };

    await expect(
      protect({
        backendUrl: "http://relayer.test",
        agentKeypair: Ed25519Keypair.generate(),
        prompt: "hi",
        targetProgram: "0x2",
        value: 1n,
        fetchImpl: fetchStub as unknown as typeof fetch,
      })
    ).rejects.toThrow(/agent not registered/);
  });
});
