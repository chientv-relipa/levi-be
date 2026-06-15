/**
 * Acceptance — prove gas-sponsored submit works on testnet.
 *
 * Generates a fresh agent wallet (with NO SUI), registers it, then submits an action
 * sponsored by the backend (agent = sender, backend = gas owner). If the Action lands in
 * Pending, sponsorship works end-to-end.
 *
 * Run: `npm run check-sponsored`  (requires OPERATOR_SECRET_KEY in .env)
 */
import assert from "node:assert";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { loadConfig } from "../src/config/relayer-config";
import { SuiService } from "../src/sui/sui.service";
import { actionStatus } from "../src/common/levi-sdk";

async function main() {
  const sui = new SuiService(loadConfig());
  console.log("backend (sponsor + owner):", sui.address);

  // 1) Fresh agent wallet — intentionally unfunded (sponsorship must cover gas).
  const agent = Ed25519Keypair.generate();
  const agentWallet = agent.getPublicKey().toSuiAddress();
  console.log("fresh agent wallet (no gas):", agentWallet);

  // 2) Register the agent (owner = backend signer).
  const { agentId } = await sui.registerAgent({ agentWallet, spendLimit: 1_000_000n });
  console.log("registered agentId:", agentId);

  // 3) Build a gas-sponsored submit_action (sender = agent, gas = backend).
  const txBytes = await sui.buildSponsoredSubmit({
    agentWallet,
    agentId,
    targetProgram: "0x000000000000000000000000000000000000000000000000000000000000dead",
    value: 1_000n,
    actionId: BigInt(Date.now()),
    encryptedPayload: new TextEncoder().encode("dummy-encrypted-payload"),
    commitmentHash: new Uint8Array(32),
  });

  // 4) Agent signs as sender; backend adds sponsor signature + broadcasts.
  const { signature } = await agent.signTransaction(txBytes);
  const res = await sui.executeSponsored(txBytes, signature);
  console.log("sponsored submit tx:", res.digest);

  // 5) Verify the Action landed in Pending.
  const created = (res.objectChanges ?? []).find(
    (c: any) => c.type === "created" && c.objectType.endsWith("::action::Action")
  ) as any;
  assert.ok(created, "Action object not created");
  const action = await sui.getAction(created.objectId);
  assert.strictEqual(action.status, actionStatus.pending, "action not Pending");
  assert.strictEqual(action.agent, agentId, "action.agent mismatch");

  console.log("✅ Gas-sponsored submit works: agent paid no gas, Action is Pending.");
}

main().catch((e) => {
  console.error("check-sponsored failed:", e);
  process.exit(1);
});
