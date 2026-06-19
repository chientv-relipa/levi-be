/**
 * Reset the off-chain activity log to zero (for a clean demo).
 *
 * Clears the relayer's stored actions / reasoning / processed set, and fast-forwards the
 * ActionSubmitted cursor to the latest on-chain event so the watcher does NOT re-ingest the
 * old actions. On-chain state is untouched. Agent names + archived flags are kept.
 *
 * Run with the relayer STOPPED (it owns the same data/state.json):
 *   npm run reset-activity
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EventId } from "@mysten/sui/client";

import { loadConfig } from "../src/config/relayer-config";
import { SuiService } from "../src/sui/sui.service";

const STATE_PATH = resolve(__dirname, "..", "data", "state.json");

async function main() {
  const cfg = loadConfig();
  const sui = new SuiService(cfg);

  // Walk every ActionSubmitted event to find the cursor *after* the last one.
  let cursor: EventId | null = null;
  let last: EventId | null = null;
  for (let i = 0; i < 500; i++) {
    const { events, nextCursor } = await sui.queryActionSubmitted(cursor);
    if (events.length > 0 && nextCursor) last = nextCursor;
    if (events.length === 0 || !nextCursor) break;
    cursor = nextCursor;
  }

  const state = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
    : {};

  const cleared = {
    ...state,
    cursor: last, // fast-forward past all existing events
    actions: {},
    reasoning: {},
    processed: [],
    agentNames: state.agentNames ?? {},
    archivedAgents: state.archivedAgents ?? [],
  };

  writeFileSync(STATE_PATH, JSON.stringify(cleared, null, 2));
  console.log("Activity log reset to 0.");
  console.log(`  cursor fast-forwarded to: ${last ? JSON.stringify(last) : "null (no events)"}`);
  console.log(`  kept ${Object.keys(cleared.agentNames).length} agent name(s), ${cleared.archivedAgents.length} archived.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
