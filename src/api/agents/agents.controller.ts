import { BadRequestException, Controller, Get, Query } from "@nestjs/common";

import { SuiService } from "../../sui/sui.service";

// GET /api/v1/agents/check-registration?agentAddress= — read the on-chain AgentRegistry.
@Controller("agents")
export class AgentsController {
  constructor(private readonly sui: SuiService) {}

  @Get("check-registration")
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
}
