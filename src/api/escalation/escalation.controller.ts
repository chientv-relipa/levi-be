// Owner-signed escalation resolution (Sui puts the authority on the owner):
//   POST /api/v1/actions/:id/build-approve  → unsigned, gas-sponsored approve_action tx
//   POST /api/v1/actions/:id/build-reject   → unsigned, gas-sponsored reject_action tx
//   POST /api/v1/actions/:id/resolve        → co-sign gas + broadcast the owner-signed tx

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

import { SuiService } from "../../sui/sui.service";
import { RELAYER_STORE, type RelayerStore } from "../../store/store.interface";
import { labelStatus } from "../../common/util/view";
import { BuildResolutionDto } from "./dto/build-resolution.dto";
import { ResolveDto } from "./dto/resolve.dto";

@Controller("actions")
export class EscalationController {
  private readonly logger = new Logger("Escalation");

  constructor(
    private readonly sui: SuiService,
    @Inject(RELAYER_STORE) private readonly store: RelayerStore
  ) {}

  private async agentIdFor(actionId: string): Promise<string> {
    const rec = this.store.getAction(actionId);
    if (rec) return rec.agentId;
    const a = await this.sui.getAction(actionId).catch(() => null);
    if (!a) throw new NotFoundException(`action ${actionId} not found`);
    return a.agent;
  }

  @Post(":id/build-approve")
  @HttpCode(HttpStatus.OK)
  buildApprove(@Param("id") id: string, @Body() b: BuildResolutionDto) {
    return this.buildResolution("approve", id, b);
  }

  @Post(":id/build-reject")
  @HttpCode(HttpStatus.OK)
  buildReject(@Param("id") id: string, @Body() b: BuildResolutionDto) {
    return this.buildResolution("reject", id, b);
  }

  private async buildResolution(kind: "approve" | "reject", id: string, b: BuildResolutionDto) {
    const agentId = await this.agentIdFor(id);
    const txBytes = await (kind === "approve"
      ? this.sui.buildSponsoredApprove({ ownerAddress: b.ownerAddress, agentId, actionId: id, gasBudget: b.gasBudget })
      : this.sui.buildSponsoredReject({ ownerAddress: b.ownerAddress, agentId, actionId: id, gasBudget: b.gasBudget }));

    return {
      kind,
      transaction: toBase64(txBytes),
      action: id,
      agentId,
      sender: b.ownerAddress,
      gasOwner: this.sui.address,
    };
  }

  // Broadcast the owner-signed approve/reject tx and reflect the new status.
  @Post(":id/resolve")
  @HttpCode(HttpStatus.OK)
  async resolve(@Param("id") id: string, @Body() b: ResolveDto) {
    const txBytes = fromBase64(b.transaction);

    // Only approve_action / reject_action are sponsorable here.
    try {
      this.sui.assertSponsorable(txBytes, this.sui.resolutionTargets());
    } catch (e) {
      throw new BadRequestException(`refusing to sponsor: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Don't pay gas for a resolution that would abort on-chain (e.g. not the owner).
    const dry = await this.sui.dryRunSponsored(txBytes);
    if (!dry.success) throw new BadRequestException(`transaction would fail on-chain: ${dry.error ?? "unknown"}`);

    const res = await this.sui.executeSponsored(txBytes, b.signature);
    if (res.effects?.status?.status !== "success") {
      throw new BadRequestException(`resolution failed on-chain: ${res.effects?.status?.error ?? "unknown error"}`);
    }

    const a = await this.sui.getAction(id);
    const rec = this.store.getAction(id);
    if (rec) {
      rec.status = a.status;
      rec.decision = labelStatus(a.status);
      this.store.saveAction(rec);
    }

    this.logger.log(`resolve ${id} → ${labelStatus(a.status)} (${res.digest})`);
    return { digest: res.digest, action: id, status: a.status, decision: labelStatus(a.status) };
  }
}
