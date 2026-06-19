import { bcs } from "@mysten/sui/bcs";

// The plaintext the relayer decrypts and hands to Claude:
//   - prompt: the user's natural-language intent ("swap 50 USDC to SOL")
//   - tx: the serialized Sui transaction the agent intends to run (unsigned PTB,
//         BCS TransactionData bytes). The relayer decodes + analyzes the moveCalls.
//
// Encoded with BCS (Sui-native). This is the decrypted analysis payload, never read
// on-chain.

export interface ActionPayload {
  prompt: string;
  tx: Uint8Array;
}

const ActionPayloadSchema = bcs.struct("ActionPayload", {
  prompt: bcs.string(),
  tx: bcs.vector(bcs.u8()),
});

export const encodeActionPayload = (input: ActionPayload): Uint8Array => {
  return ActionPayloadSchema.serialize({
    prompt: input.prompt,
    tx: Array.from(input.tx),
  }).toBytes();
};

export const decodeActionPayload = (bytes: Uint8Array): ActionPayload => {
  const decoded = ActionPayloadSchema.parse(bytes);
  return { prompt: decoded.prompt, tx: Uint8Array.from(decoded.tx) };
};
