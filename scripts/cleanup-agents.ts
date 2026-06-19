/**
 * One-off cleanup: deactivate (on-chain) and archive (off-chain, hide from the dashboard)
 * every agent owned by the operator wallet.
 *
 * The contract has no delete_agent — agents are permanent on-chain. This deactivates them
 * (owner == operator, so the operator key can sign) and sets the relayer's off-chain
 * "archived" flag so they disappear from `GET /agents` listings + the UI.
 *
 * Run with the relayer STOPPED (it writes the same data/state.json):
 *   npm run cleanup-agents
 */
import { Transaction } from "@mysten/sui/transactions";

import { loadConfig } from "../src/config/relayer-config";
import { SuiService } from "../src/sui/sui.service";
import { JsonStore } from "../src/store/json-store.service";
import { MODULES } from "../src/common/levi-sdk";

async function main() {
  const cfg = loadConfig();
  const sui = new SuiService(cfg);
  const store = new JsonStore();
  const owner = sui.address;

  console.log(`Operator/owner: ${owner}`);
  const ids = await sui.getAgentIdsByOwner(owner);
  console.log(`Found ${ids.length} agent(s) owned by this wallet.`);

  for (const id of ids) {
    const a = await sui.getAgent(id).catch(() => null);
    if (!a) {
      console.log(`  ${id}  (unreadable, skipped)`);
      continue;
    }

    if (a.active) {
      const tx = new Transaction();
      tx.moveCall({
        target: `${cfg.addresses.packageId}::${MODULES.deactivateAgent}::${MODULES.deactivateAgent}`,
        arguments: [tx.object(cfg.addresses.configId), tx.object(id)],
      });
      const res = await sui.client.signAndExecuteTransaction({
        transaction: tx,
        signer: sui.signer,
        options: { showEffects: true },
      });
      await sui.client.waitForTransaction({ digest: res.digest });
      const ok = res.effects?.status?.status === "success";
      console.log(`  ${id}  deactivated ${ok ? "✓" : "✗ " + res.effects?.status?.error} (${res.digest})`);
    } else {
      console.log(`  ${id}  already inactive`);
    }

    store.setAgentArchived(id, true);
  }

  console.log(`Archived ${ids.length} agent(s) off-chain. They are now hidden from the dashboard.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
