import { x25519 } from "@noble/curves/ed25519";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { X25519_KEY_LENGTH } from "./keypair";
import { NONCE_LENGTH } from "./encrypt";

// Relayer-side: reverse of encryptForRelayer. Splits the envelope and decrypts.

export interface DecryptFromAgentParams {
  payload: Uint8Array;
  relayerSecretKey: Uint8Array;
}

export interface DecryptFromAgentResult {
  plaintext: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
}

export const decryptFromAgent = (
  params: DecryptFromAgentParams
): DecryptFromAgentResult => {
  if (params.relayerSecretKey.length !== X25519_KEY_LENGTH) {
    throw new Error(
      `relayer secret key must be ${X25519_KEY_LENGTH} bytes, got ${params.relayerSecretKey.length}`
    );
  }

  const headerLen = X25519_KEY_LENGTH + NONCE_LENGTH;
  if (params.payload.length < headerLen) {
    throw new Error(
      `payload too short: expected at least ${headerLen} bytes, got ${params.payload.length}`
    );
  }

  const ephemeralPublicKey = params.payload.slice(0, X25519_KEY_LENGTH);
  const nonce = params.payload.slice(X25519_KEY_LENGTH, headerLen);
  const ciphertext = params.payload.slice(headerLen);

  const sharedSecret = x25519.getSharedSecret(
    params.relayerSecretKey,
    ephemeralPublicKey
  );

  const plaintext = chacha20poly1305(sharedSecret, nonce).decrypt(ciphertext);

  return { plaintext, ephemeralPublicKey, nonce };
};
