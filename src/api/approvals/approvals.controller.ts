// GET /api/v1/approvals — the human-in-the-loop review queue: actions the firewall escalated
// (Escalated decision) that await an owner's approve/reject, plus headline counts.

import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { RELAYER_STORE, type RelayerStore } from "../../store/store.interface";
import { RELAYER_CONFIG, type RelayerConfig } from "../../config/relayer-config";
import { recordView } from "../../common/util/view";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM";

/** Map an escalated action's raw score to a review severity (escalation band is 40k–70k). */
function severity(rawScore: number): Severity {
  if (rawScore >= 60_000) return "CRITICAL";
  if (rawScore >= 50_000) return "HIGH";
  return "MEDIUM";
}

@ApiTags("dashboard")
@Controller("approvals")
export class ApprovalsController {
  constructor(
    @Inject(RELAYER_STORE) private readonly store: RelayerStore,
    @Inject(RELAYER_CONFIG) private readonly cfg: RelayerConfig
  ) {}

  @Get()
  @ApiOperation({ summary: "Human-in-the-loop review queue (escalated actions) + counts" })
  approvals() {
    const actions = this.store.listActions();
    const escalated = actions
      .filter((a) => a.decision === "Escalated")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first

    const items = escalated.map((r) => ({
      ...recordView(r, this.store.getReasoning(r.reasoningHash) ?? null, this.cfg.publicBaseUrl),
      severity: severity(r.rawScore),
    }));

    const count = (d: string) => actions.filter((a) => a.decision === d).length;
    return {
      pending: escalated.length,
      critical: items.filter((i) => i.severity === "CRITICAL").length,
      approved: count("Approved"),
      blocked: count("Blocked"),
      total: escalated.length,
      items,
    };
  }
}
