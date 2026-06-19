import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from "@nestjs/swagger";

import { SetAgentNameDto } from "./dto/set-agent-name.dto";
import { ArchiveAgentDto } from "./dto/archive-agent.dto";

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

  // Dashboard agent list. Without `owner`: agents the relayer has seen (distinct agentIds from the
  // action log). With `owner`: ALL agents that wallet owns, from on-chain RegisterAgent events
  // (incl. zero-action agents the action-log listing would miss) — this backs the "My Agents" page.
  @Get()
  @ApiOperation({ summary: "List agents (all seen, or by ?owner=) with on-chain reputation" })
  @ApiQuery({ name: "owner", required: false, example: "0x…" })
  async listAgents(@Query("owner") owner?: string) {
    const allIds = owner
      ? await this.sui.getAgentIdsByOwner(owner)
      : Array.from(new Set(this.store.listActions().map((a) => a.agentId))).slice(0, 50);
    const ids = allIds.filter((id) => !this.store.isAgentArchived(id));
    const items = (
      await Promise.all(
        ids.map((id) =>
          Promise.all([this.sui.getAgent(id), this.sui.getAllowedTargets(id)])
            .then(([a, t]) => agentView(id, a, t, this.store.getAgentName(id)))
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
    return agentView(id, a, targets, this.store.getAgentName(id));
  }

  // Set an agent's off-chain display name (cosmetic; the contract stores no name).
  @Post(":id/name")
  @HttpCode(HttpStatus.OK)
  @ApiSecurity("x-api-key")
  @ApiOperation({ summary: "Set an agent's off-chain display name" })
  setAgentName(@Param("id") id: string, @Body() body: SetAgentNameDto) {
    this.store.setAgentName(id, body.name.trim());
    return { agentId: id, name: body.name.trim() };
  }

  // Archive/unarchive an agent off-chain (soft delete — hides it from dashboard listings).
  @Post(":id/archive")
  @HttpCode(HttpStatus.OK)
  @ApiSecurity("x-api-key")
  @ApiOperation({ summary: "Archive (hide) or unarchive an agent off-chain" })
  archiveAgent(@Param("id") id: string, @Body() body: ArchiveAgentDto) {
    this.store.setAgentArchived(id, body.archived);
    return { agentId: id, archived: body.archived };
  }
}
