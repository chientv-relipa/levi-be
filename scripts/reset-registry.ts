/**
 * Create a FRESH (empty) AgentRegistry on-chain and point the relayer at it.
 *
 * Why: the on-chain registry maps agent_wallet → agent permanently (no unregister, by design).
 * To let a wallet that was already registered (e.g. the operator's own address) register again
 * with a clean reputation, we mint a brand-new empty registry via `registry::init_registry`
 * (gated on the AdminCap, which the operator owns) and rewrite the SDK's `registryId` so all
 * register/lookups use the new one. The package, Config, caps and existing Agent objects are
 * untouched — only NEW registrations go through the fresh registry.
 *
 * Run with the relayer STOPPED, then restart it:
 *   npm run reset-registry
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Transaction } from "@mysten/sui/transactions";

import { loadConfig } from "../src/config/relayer-config";
import { SuiService } from "../src/sui/sui.service";

const CONSTANTS_PATH = resolve(__dirname, "..", "src", "sdk", "common", "constants.ts");

async function main() {
  const cfg = loadConfig();
  const sui = new SuiService(cfg);
  const { packageId, adminCapId, registryId: oldRegistry } = cfg.addresses;

  console.log("operator (signer):", sui.signer.getPublicKey().toSuiAddress());
  console.log("package          :", packageId);
  console.log("old registry     :", oldRegistry);
  console.log("calling registry::init_registry …\n");

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::registry::init_registry`,
    arguments: [tx.object(adminCapId)],
  });

  const res = await sui.client.signAndExecuteTransaction({
    signer: sui.signer,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  await sui.client.waitForTransaction({ digest: res.digest });

  if (res.effects?.status?.status !== "success") {
    throw new Error(`tx failed: ${JSON.stringify(res.effects?.status)}`);
  }

  const created = (res.objectChanges ?? []).find(
    (c): c is Extract<typeof c, { type: "created" }> =>
      c.type === "created" &&
      typeof (c as { objectType?: string }).objectType === "string" &&
      (c as { objectType: string }).objectType.endsWith("::registry::AgentRegistry"),
  );
  if (!created) {
    throw new Error(
      `created AgentRegistry not found. objectChanges=${JSON.stringify(res.objectChanges, null, 2)}`,
    );
  }
  const newRegistry = (created as { objectId: string }).objectId;

  console.log("✅ init_registry tx:", res.digest);
  console.log("✅ NEW registry    :", newRegistry);

  // Rewrite registryId in the shared SDK constants so the relayer uses the fresh registry.
  const src = readFileSync(CONSTANTS_PATH, "utf8");
  if (!src.includes(oldRegistry)) {
    throw new Error(`old registryId not found in ${CONSTANTS_PATH} — patch manually to ${newRegistry}`);
  }
  writeFileSync(CONSTANTS_PATH, src.split(oldRegistry).join(newRegistry));
  console.log("✅ updated registryId in", CONSTANTS_PATH);

  console.log("\nDONE. Restart the relayer (npm run start). The operator wallet can now register a");
  console.log("fresh agent. (Old agents from the previous registry still exist — archive them if");
  console.log("you don't want them in My Agents.)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
