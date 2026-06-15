import "dotenv/config";
import { TESTNET_ADDRESSES } from "../common/levi-sdk";

/** DI token for the resolved RelayerConfig. */
export const RELAYER_CONFIG = "RELAYER_CONFIG";

export interface RelayerConfig {
  rpcUrl: string;
  pollIntervalMs: number;
  /** HTTP API port. */
  port: number;
  /** Public base URL used to build escalation links (approve/reject/review). */
  publicBaseUrl: string;
  /** Shared secret required on write (POST) routes via `x-api-key`. If unset, auth is OFF. */
  apiKey?: string;
  /** Per-IP request cap per window. */
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** Sui signer (bech32 suiprivkey…) — must hold the RelayerCap. */
  operatorSecretKey: string;
  /** x25519 secret (hex) matching the on-chain Config.relayer_encryption_key. */
  relayerX25519Secret?: string;
  /** Anthropic key; if absent the relayer uses the offline rule-based analyzer. */
  anthropicApiKey?: string;
  addresses: typeof TESTNET_ADDRESSES;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (copy .env.example → .env)`);
  return v;
}

/** Validate + load config from env. */
export function loadConfig(): RelayerConfig {
  const port = Number(process.env.PORT ?? 8787);
  return {
    rpcUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 4000),
    port,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    apiKey: process.env.RELAYER_API_KEY || undefined,
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 120),
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    operatorSecretKey: required("OPERATOR_SECRET_KEY"),
    relayerX25519Secret: process.env.RELAYER_X25519_SECRET || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    addresses: TESTNET_ADDRESSES,
  };
}
