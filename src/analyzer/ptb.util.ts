// Best-effort decode of `ActionPayload.tx` (the serialized Sui transaction an agent
// intends to run) into a moveCall summary the analyzer can reason about.
//
// The agent serializes its intended PTB (BCS TransactionData / TransactionKind bytes)
// into the encrypted payload. We decode it here to surface *what* the action actually
// does — which packages/functions it calls, and how much it moves — rather than trusting
// the prompt alone. Decoding is best-effort: an unparseable payload degrades gracefully,
// it never throws.

import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

export interface MoveCallSummary {
  /** `package::module::function` */
  target: string;
  package: string;
  module: string;
  function: string;
  typeArguments: string[];
  argumentCount: number;
}

export interface ParsedTx {
  /** True if the bytes decoded into a transaction we could inspect. */
  parsed: boolean;
  moveCalls: MoveCallSummary[];
  /** All command kinds in order (e.g. ["MoveCall", "TransferObjects"]). */
  commandKinds: string[];
  byteLength: number;
  /** u64 amounts referenced by SplitCoins commands — coins actually leaving the wallet. */
  splitAmounts?: bigint[];
  error?: string;
}

/** Decode an 8-byte little-endian BCS u64 from a base64 Pure input. */
function decodePureU64LE(b64: string): bigint | null {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch {
    return null;
  }
  if (bytes.length !== 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/** Decode a serialized transaction payload into a structured, analyzable summary. */
export function parseActionTx(txBytes: Uint8Array | undefined | null): ParsedTx {
  const byteLength = txBytes?.length ?? 0;
  const empty: ParsedTx = { parsed: false, moveCalls: [], commandKinds: [], byteLength };

  if (!txBytes || txBytes.length === 0) {
    return { ...empty, error: "empty tx payload" };
  }

  // Agents may serialize either full TransactionData or a transaction-kind only — try both.
  let tx: Transaction;
  try {
    tx = Transaction.from(txBytes);
  } catch {
    try {
      tx = Transaction.fromKind(txBytes);
    } catch (eKind) {
      const msg = eKind instanceof Error ? eKind.message : String(eKind);
      return { ...empty, error: `undecodable tx payload: ${msg}` };
    }
  }

  try {
    const data = tx.getData();
    const commands = data.commands ?? [];

    const inputs: any[] = (data as any).inputs ?? [];
    const pureU64At = (idx: number): bigint | null => {
      const b64 = inputs[idx]?.Pure?.bytes;
      return typeof b64 === "string" ? decodePureU64LE(b64) : null;
    };

    const moveCalls: MoveCallSummary[] = [];
    const commandKinds: string[] = [];
    const splitAmounts: bigint[] = [];

    for (const cmd of commands as any[]) {
      const kind: string = cmd?.$kind ?? Object.keys(cmd ?? {})[0] ?? "Unknown";
      commandKinds.push(kind);

      const mc = cmd?.MoveCall;
      if (mc && mc.package && mc.module && mc.function) {
        moveCalls.push({
          target: `${mc.package}::${mc.module}::${mc.function}`,
          package: mc.package,
          module: mc.module,
          function: mc.function,
          typeArguments: Array.isArray(mc.typeArguments) ? mc.typeArguments : [],
          argumentCount: Array.isArray(mc.arguments) ? mc.arguments.length : 0,
        });
      }

      // SplitCoins amounts are the canonical "value leaving the wallet" in a Sui PTB.
      const sc = cmd?.SplitCoins;
      if (sc?.amounts) {
        for (const arg of sc.amounts) {
          if (arg?.$kind === "Input" && typeof arg.Input === "number") {
            const v = pureU64At(arg.Input);
            if (v !== null) splitAmounts.push(v);
          }
        }
      }
    }

    return { parsed: true, moveCalls, commandKinds, byteLength, splitAmounts };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}
