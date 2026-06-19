import { blake3 } from "@noble/hashes/blake3";

// blake3(plaintext) — computed BEFORE encryption and passed to submit_action.
// The relayer recomputes it after decryption to detect tampering.
export const COMMITMENT_LENGTH = 32;

export const commitmentHash = (plaintext: Uint8Array): Uint8Array => {
  return blake3(plaintext);
};

export const commitmentHashAsArray = (plaintext: Uint8Array): number[] => {
  return Array.from(blake3(plaintext));
};
