// Owner-management API (dashboard, owner-signed + gas-sponsored):
//   POST /api/v1/agents/build-register            → unsigned register_agent tx
//   POST /api/v1/agents/:id/build-activate        → unsigned activate_agent tx
//   POST /api/v1/agents/:id/build-deactivate      → unsigned deactivate_agent tx
//   POST /api/v1/agents/:id/build-update-target   → unsigned update_agent_program_target tx
//   POST /api/v1/agents/execute                   → broadcast the owner-signed tx
//
// Same pattern as escalation: relayer builds the tx (sender = owner, gas = relayer), the owner
// signs in the browser (e.g. @mysten/dapp-kit), then `execute` validates + co-signs gas + broadcasts.

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

import { SuiService } from "../../sui/sui.service";
import { BuildRegisterDto } from "./dto/build-register.dto";
import { BuildLifecycleDto } from "./dto/build-lifecycle.dto";
import { BuildUpdateTargetDto } from "./dto/build-update-target.dto";
import { ExecuteDto } from "./dto/execute.dto";

function findCreatedAgent(res: { objectChanges?: unknown[] | null }): string | null {
  for (const c of (res.objectChanges ?? []) as any[]) {
    if (c.type === "created" && typeof c.objectType === "string" && c.objectType.endsWith("::agent::Agent")) {
      return c.objectId as string;
    }
  }
  return null;
}

@ApiTags("agents-management")
@ApiSecurity("x-api-key")
@Controller("agents")
export class AgentsManagementController {
  private readonly logger = new Logger("AgentsMgmt");

  constructor(private readonly sui: SuiService) {}

  @Post("build-register")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Build an unsigned, gas-sponsored register_agent tx for the owner to sign" })
  async buildRegister(@Body() b: BuildRegisterDto) {
    const txBytes = await this.sui.buildSponsoredRegister({
      ownerAddress: b.ownerAddress,
      agentWallet: b.agentWallet,
      spendLimit: BigInt(b.spendLimit),
    });
    return { transaction: toBase64(txBytes), sender: b.ownerAddress, gasOwner: this.sui.address };
  }

  @Post(":id/build-activate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Build an unsigned activate_agent tx for the owner to sign" })
  async buildActivate(@Param("id") id: string, @Body() b: BuildLifecycleDto) {
    const txBytes = await this.sui.buildSponsoredActivate({ ownerAddress: b.ownerAddress, agentId: id });
    return { transaction: toBase64(txBytes), agentId: id, sender: b.ownerAddress, gasOwner: this.sui.address };
  }

  @Post(":id/build-deactivate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Build an unsigned deactivate_agent tx for the owner to sign" })
  async buildDeactivate(@Param("id") id: string, @Body() b: BuildLifecycleDto) {
    const txBytes = await this.sui.buildSponsoredDeactivate({ ownerAddress: b.ownerAddress, agentId: id });
    return { transaction: toBase64(txBytes), agentId: id, sender: b.ownerAddress, gasOwner: this.sui.address };
  }

  @Post(":id/build-update-target")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Build an unsigned update_agent_program_target tx for the owner to sign" })
  async buildUpdateTarget(@Param("id") id: string, @Body() b: BuildUpdateTargetDto) {
    const txBytes = await this.sui.buildSponsoredUpdateTarget({
      ownerAddress: b.ownerAddress,
      agentId: id,
      target: b.target,
      allowed: b.allowed,
    });
    return { transaction: toBase64(txBytes), agentId: id, sender: b.ownerAddress, gasOwner: this.sui.address };
  }

  @Post("execute")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Broadcast an owner-signed agent-management tx (register/activate/deactivate/update-target)" })
  async execute(@Body() b: ExecuteDto) {
    const txBytes = fromBase64(b.transaction);

    // Only the four owner-management instructions are sponsorable here.
    try {
      this.sui.assertSponsorable(txBytes, this.sui.agentManagementTargets());
    } catch (e) {
      throw new BadRequestException(`refusing to sponsor: ${e instanceof Error ? e.message : String(e)}`);
    }

    const dry = await this.sui.dryRunSponsored(txBytes);
    if (!dry.success) throw new BadRequestException(`transaction would fail on-chain: ${dry.error ?? "unknown"}`);

    const res = await this.sui.executeSponsored(txBytes, b.signature);
    if (res.effects?.status?.status !== "success") {
      throw new BadRequestException(`agent management tx failed on-chain: ${res.effects?.status?.error ?? "unknown error"}`);
    }

    const agentId = findCreatedAgent(res); // present for register_agent
    this.logger.log(`execute ${res.digest}${agentId ? ` → registered ${agentId}` : ""}`);
    return { digest: res.digest, agentId };
  }
}
