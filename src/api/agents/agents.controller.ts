import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { SuiService } from "../../sui/sui.service";
import { RELAYER_STORE, type RelayerStore } from "../../store/store.interface";
import { agentView } from "../../common/util/view";

// Agent reads: registration check + dashboard agent list/detail.
@ApiTags("agents")
@Controller("agents")
export class AgentsController {
  constructor(
    private readonly sui: SuiService,
    @Inject(RELAYER_STORE) private readonly store: RelayerStore
  ) {}

  // Static route declared before `:id` so it isn't captured as an id.
  @Get("check-registration")
  @ApiOperation({ summary: "Check whether an agent wallet is registered on-chain" })
  @ApiQuery({ name: "agentAddress", required: true, example: "0x…" })
  async checkRegistration(@Query("agentAddress") agentAddress?: string) {
    if (!agentAddress) throw new BadRequestException("agentAddress query param is required");

    const agentId = await this.sui.getAgentIdByWallet(agentAddress);
    if (!agentId) return { registered: false, agentAddress };

    const a = await this.sui.getAgent(agentId);
    return {
      registered: true,
      agentAddress,
      agentId,
      owner: a.owner,
      active: a.active,
      spendLimit: a.spendLimit.toString(),
      threatScore: a.threatScore,
      strikes: a.strikes,
    };
  }

  // Dashboard: agents the relayer has seen (distinct agentIds from the action log) + on-chain stats.
  @Get()
  @ApiOperation({ summary: "List agents seen by the relayer (with on-chain reputation)" })
  async listAgents() {
    const ids = Array.from(new Set(this.store.listActions().map((a) => a.agentId))).slice(0, 50);
    const items = (
      await Promise.all(
        ids.map((id) =>
          Promise.all([this.sui.getAgent(id), this.sui.getAllowedTargets(id)])
            .then(([a, t]) => agentView(id, a, t))
            .catch(() => null)
        )
      )
    ).filter(Boolean);
    return { total: items.length, items };
  }

  // Dashboard: full on-chain agent detail (reputation, stats, allow-list).
  @Get(":id")
  @ApiOperation({ summary: "Get an agent's on-chain reputation, stats and allow-list" })
  async getAgent(@Param("id") id: string) {
    const a = await this.sui.getAgent(id).catch(() => null);
    if (!a) throw new NotFoundException(`agent ${id} not found`);
    const targets = await this.sui.getAllowedTargets(id);
    return agentView(id, a, targets);
  }
}
