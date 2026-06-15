// Proves the engine's verify step: an agent encrypts {prompt, tx} to the relayer key, the
// relayer decrypts it, the blake3 commitment matches, tampering is detected, and the inner
// PTB decodes into analyzable moveCalls.

import { describe, it, expect } from "vitest";
import { Transaction } from "@mysten/sui/transactions";

import {
  generateX25519Keypair,
  encryptForRelayer,
  decryptFromAgent,
  commitmentHash,
  encodeActionPayload,
  decodeActionPayload,
  COMMITMENT_LENGTH,
} from "../src/common/levi-sdk";
import { parseActionTx } from "../src/analyzer/ptb.util";

describe("payload crypto + commitment", () => {
  it("round-trips encrypt → decrypt for the relayer keypair", () => {
    const relayer = generateX25519Keypair();
    const plaintext = new TextEncoder().encode("swap 10 SUI for USDC");

    const { payload } = encryptForRelayer({ plaintext, relayerPublicKey: relayer.publicKey });
    const { plaintext: out } = decryptFromAgent({ payload, relayerSecretKey: relayer.secretKey });

    expect(Array.from(out)).toEqual(Array.from(plaintext));
  });

  it("commitment is blake3(plaintext) and survives the round-trip", () => {
    const relayer = generateX25519Keypair();
    const plaintext = new TextEncoder().encode("approve action #42");
    const commitment = commitmentHash(plaintext);

    expect(commitment.length).toBe(COMMITMENT_LENGTH);

    const { payload } = encryptForRelayer({ plaintext, relayerPublicKey: relayer.publicKey });
    const { plaintext: out } = decryptFromAgent({ payload, relayerSecretKey: relayer.secretKey });

    expect(Array.from(commitmentHash(out))).toEqual(Array.from(commitment));
  });

  it("detects tampering with the ciphertext", () => {
    const relayer = generateX25519Keypair();
    const plaintext = new TextEncoder().encode("legit intent");
    const { payload } = encryptForRelayer({ plaintext, relayerPublicKey: relayer.publicKey });

    const tampered = Uint8Array.from(payload);
    tampered[tampered.length - 1] ^= 0xff; // flip a ciphertext byte

    expect(() => decryptFromAgent({ payload: tampered, relayerSecretKey: relayer.secretKey })).toThrow();
  });

  it("fails to decrypt with the wrong relayer key", () => {
    const relayer = generateX25519Keypair();
    const attacker = generateX25519Keypair();
    const { payload } = encryptForRelayer({
      plaintext: new TextEncoder().encode("secret"),
      relayerPublicKey: relayer.publicKey,
    });

    expect(() => decryptFromAgent({ payload, relayerSecretKey: attacker.secretKey })).toThrow();
  });

  it("encodes/decodes the ActionPayload and decodes its inner PTB", async () => {
    const tx = new Transaction();
    tx.moveCall({ target: "0x2::coin::value", typeArguments: ["0x2::sui::SUI"], arguments: [] });
    const txBytes = await tx.build({ onlyTransactionKind: true });

    const encoded = encodeActionPayload({ prompt: "read coin value", tx: txBytes });
    const decoded = decodeActionPayload(encoded);

    expect(decoded.prompt).toBe("read coin value");
    expect(Array.from(decoded.tx)).toEqual(Array.from(txBytes));

    const parsed = parseActionTx(decoded.tx);
    expect(parsed.parsed).toBe(true);
    expect(parsed.moveCalls.length).toBe(1);
    expect(parsed.moveCalls[0].module).toBe("coin");
    expect(parsed.moveCalls[0].function).toBe("value");
  });

  it("degrades gracefully on an undecodable tx payload", () => {
    const parsed = parseActionTx(new Uint8Array([1, 2, 3, 4]));
    expect(parsed.parsed).toBe(false);
    expect(parsed.error).toBeTruthy();
  });
});
