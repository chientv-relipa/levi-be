/**
 * Key bootstrap.
 *
 * Generates (or reuses) the relayer's persistent x25519 keypair, writes the SECRET to
 * `.env` (RELAYER_X25519_SECRET), and publishes the PUBLIC key on-chain as
 * `Config.relayer_encryption_key` via `update_config` (signer must hold the AdminCap).
 *
 * Run: `npm run set-key`   (requires OPERATOR_SECRET_KEY in .env)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

import { loadConfig } from "../src/config/relayer-config";
import { SuiService } from "../src/sui/sui.service";
import {
  generateX25519Keypair,
  deriveX25519PublicKey,
  encryptForRelayer,
  decryptFromAgent,
} from "../src/common/levi-sdk";

const ENV_PATH = resolve(__dirname, "..", ".env");

function upsertEnv(key: string, value: string): void {
  const line = `${key}=${value}`;
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  content = re.test(content)
    ? content.replace(re, line)
    : (content.endsWith("\n") || content === "" ? content : content + "\n") + line + "\n";
  writeFileSync(ENV_PATH, content);
}

async function main() {
  const cfg = loadConfig();

  // 1) Resolve the relayer x25519 keypair (reuse existing secret, else generate).
  let secretKey: Uint8Array;
  if (cfg.relayerX25519Secret) {
    secretKey = hexToBytes(cfg.relayerX25519Secret);
    console.log("Reusing existing RELAYER_X25519_SECRET from .env");
  } else {
    secretKey = generateX25519Keypair().secretKey;
    console.log("Generated a new relayer x25519 keypair");
  }
  const publicKey = deriveX25519PublicKey(secretKey);

  // 2) Self-test the keypair (encrypt → decrypt round-trip) before touching the chain.
  const sample = new TextEncoder().encode("levi-key-self-test");
  const { payload } = encryptForRelayer({ plaintext: sample, relayerPublicKey: publicKey });
  const { plaintext } = decryptFromAgent({ payload, relayerSecretKey: secretKey });
  assert.deepStrictEqual(Array.from(plaintext), Array.from(sample), "x25519 round-trip failed");
  console.log("Keypair self-test OK");

  // 3) Persist the secret to .env (gitignored).
  upsertEnv("RELAYER_X25519_SECRET", bytesToHex(secretKey));
  console.log(`Saved RELAYER_X25519_SECRET to ${ENV_PATH}`);

  // 4) Publish the public key on-chain via update_config (needs AdminCap on the signer).
  const sui = new SuiService(cfg);
  console.log(`Signer: ${sui.address}`);
  console.log(`Public key: 0x${bytesToHex(publicKey)}`);
  const digest = await sui.setRelayerEncryptionKey(publicKey);
  console.log(`update_config tx: ${digest}`);

  // 5) Read back + verify.
  const onchain = await sui.getConfig();
  assert.deepStrictEqual(
    Array.from(onchain.relayerEncryptionKey),
    Array.from(publicKey),
    "on-chain key does not match the relayer public key"
  );
  console.log("✅ On-chain Config.relayer_encryption_key now matches the relayer key.");
}

main().catch((e) => {
  console.error("set-encryption-key failed:", e);
  process.exit(1);
});
