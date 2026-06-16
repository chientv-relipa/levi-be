// Agent-side `protect()` — the only thing an AI agent calls. It talks ONLY to the Levi
// relayer (never directly to chain), and gets back a synchronous verdict.
//
// Flow (mirrors the relayer API):
//   1. GET  /system/config        → relayer x25519 pubkey + IDs
//   2. encode {prompt, tx} → blake3 commitment → encrypt to the relayer pubkey
//   3. POST /actions/build-submit  → unsigned, gas-sponsored submit_action tx
//   4. sign as sender (agent wallet) — the agent pays NO gas (backend sponsors)
//   5. POST /actions/submit        → { verdict }
//
// The agent only needs its own keypair + the relayer URL — no secrets, no SUI for gas.

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { hexToBytes } from "@noble/hashes/utils";

import { encodeActionPayload, encryptForRelayer, commitmentHash } from "../src/common/levi-sdk";

export interface ProtectParams {
  backendUrl: string;
  /** The agent's wallet keypair (signs as sender; needs no gas). */
  agentKeypair: Ed25519Keypair;
  /** Natural-language intent. */
  prompt: string;
  /** Serialized intended PTB (BCS bytes); optional. */
  tx?: Uint8Array;
  /** Declared target package. */
  targetProgram: string;
  /** Declared value. */
  value: bigint | number;
  /** Explicit action id; defaults server-side to the next free id. */
  actionId?: bigint | number;
  /** Override fetch (tests / non-global-fetch runtimes). */
  fetchImpl?: typeof fetch;
  /** Relayer API key (sent as x-api-key) — required if the relayer has RELAYER_API_KEY set. */
  apiKey?: string;
}

export interface ProtectVerdict {
  decision: string; // Approved | Escalated | Blocked
  rawScore: number;
  status: number;
  reasoning: string;
  reasoningHash: string;
  analyzer: string;
  verdictDigest: string | null;
  escalation: { approve: string; reject: string; review: string } | null;
  skipped: boolean;
  /** Sui digest of the submit_action transaction. */
  digest: string;
  /** Action object ID (poll GET /actions/:id). */
  actionId: string;
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { "x-api-key": apiKey } : {};
}

async function getJson(f: typeof fetch, url: string, apiKey?: string): Promise<any> {
  const res = await f(url, { headers: authHeaders(apiKey) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${body?.error ?? res.statusText}`);
  return body;
}

async function postJson(f: typeof fetch, url: string, payload: unknown, apiKey?: string): Promise<any> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify(payload),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${body?.error ?? res.statusText}`);
  return body;
}

/** Check whether an agent wallet is registered with the Levi relayer. */
export async function checkRegistration(
  backendUrl: string,
  agentAddress: string,
  fetchImpl: typeof fetch = fetch,
  apiKey?: string
): Promise<{ registered: boolean; agentId?: string; active?: boolean }> {
  const base = backendUrl.replace(/\/$/, "");
  return getJson(fetchImpl, `${base}/api/v1/agents/check-registration?agentAddress=${agentAddress}`, apiKey);
}

/** Submit an action through Levi and return the firewall's verdict. */
export async function protect(p: ProtectParams): Promise<ProtectVerdict> {
  const f = p.fetchImpl ?? fetch;
  const base = p.backendUrl.replace(/\/$/, "");

  // 1) relayer encryption key + IDs
  const sys = await getJson(f, `${base}/api/v1/system/config`, p.apiKey);
  const relayerPublicKey = hexToBytes(String(sys.relayerEncryptionKey).replace(/^0x/, ""));

  // 2) encode + commit + encrypt the payload
  const payloadBytes = encodeActionPayload({ prompt: p.prompt, tx: p.tx ?? new Uint8Array() });
  const commitment = commitmentHash(payloadBytes);
  const { payload } = encryptForRelayer({ plaintext: payloadBytes, relayerPublicKey });

  // 3) build the sponsored submit tx
  const agentWallet = p.agentKeypair.getPublicKey().toSuiAddress();
  const built = await postJson(
    f,
    `${base}/api/v1/actions/build-submit`,
    {
      agentWallet,
      targetProgram: p.targetProgram,
      value: String(p.value),
      actionId: p.actionId !== undefined ? String(p.actionId) : undefined,
      encryptedPayload: toBase64(payload),
      commitmentHash: toBase64(commitment),
    },
    p.apiKey
  );

  // 4) sign as sender (agent pays no gas)
  const { signature } = await p.agentKeypair.signTransaction(fromBase64(built.transaction));

  // 5) submit → synchronous verdict
  const submitted = await postJson(
    f,
    `${base}/api/v1/actions/submit`,
    { transaction: built.transaction, signature },
    p.apiKey
  );

  const v = submitted.verdict;
  return {
    decision: v.decision,
    rawScore: v.rawScore,
    status: v.status,
    reasoning: v.reasoning,
    reasoningHash: v.reasoningHash,
    analyzer: v.analyzer,
    verdictDigest: v.verdictDigest ?? null,
    escalation: v.escalation ?? null,
    skipped: v.skipped,
    digest: submitted.digest,
    actionId: submitted.actionId,
  };
}
