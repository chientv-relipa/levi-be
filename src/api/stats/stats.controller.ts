import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { RELAYER_STORE, type RelayerStore } from "../../store/store.interface";

// GET /api/v1/stats — aggregate counts for the dashboard home.
@ApiTags("dashboard")
@Controller("stats")
export class StatsController {
  constructor(@Inject(RELAYER_STORE) private readonly store: RelayerStore) {}

  @Get()
  @ApiOperation({ summary: "Aggregate verdict/agent counts for the dashboard" })
  stats() {
    const actions = this.store.listActions();
    const count = (d: string) => actions.filter((a) => a.decision === d).length;
    // Funds the firewall kept from being spent: value of everything it stopped (Blocked/Rejected).
    const fundSavedMist = actions
      .filter((a) => a.decision === "Blocked" || a.decision === "Rejected")
      .reduce((sum, a) => sum + BigInt(a.value || "0"), 0n)
      .toString();
    return {
      totalActions: actions.length,
      agents: new Set(actions.map((a) => a.agentId)).size,
      fundSavedMist,
      byDecision: {
        Approved: count("Approved"),
        Escalated: count("Escalated"),
        Blocked: count("Blocked"),
        Rejected: count("Rejected"),
        Pending: count("Pending"),
      },
    };
  }
}
