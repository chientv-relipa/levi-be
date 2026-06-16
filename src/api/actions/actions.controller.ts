// Action lifecycle:
//   POST /api/v1/actions/build-submit  → unsigned, gas-sponsored submit_action tx
//   POST /api/v1/actions/submit        → co-sign gas + broadcast + synchronous verdict
//   GET  /api/v1/actions/:id           → action status / decision / reasoning (poll)

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

import { SuiService, MAX_SPONSOR_GAS_BUDGET } from "../../sui/sui.service";
import { EngineService } from "../../engine/engine.service";
import { RELAYER_STORE, type RelayerStore } from "../../store/store.interface";
import { RELAYER_CONFIG, type RelayerConfig } from "../../config/relayer-config";
import { hex0x, labelStatus, recordView, verdictView, escalationLinks } from "../../common/util/view";
import { BuildSubmitDto } from "./dto/build-submit.dto";
import { SubmitDto } from "./dto/submit.dto";

function findCreatedAction(res: { objectChanges?: unknown[] | null }): string | null {
  for (const c of (res.objectChanges ?? []) as any[]) {
    if (c.type === "created" && typeof c.objectType === "string" && c.objectType.endsWith("::action::Action")) {
      return c.objectId as string;
    }
  }
  return null;
}

@ApiTags("actions")
@Controller("actions")
export class ActionsController {
  private readonly logger = new Logger("Actions");

  constructor(
    private readonly sui: SuiService,
    private readonly engine: EngineService,
    @Inject(RELAYER_STORE) private readonly store: RelayerStore,
    @Inject(RELAYER_CONFIG) private readonly cfg: RelayerConfig
  ) {}

  // Build the unsigned sponsored submit tx for the agent to sign.
  @Post("build-submit")
  @HttpCode(HttpStatus.OK)
  @ApiSecurity("x-api-key")
  @ApiOperation({ summary: "Build an unsigned, gas-sponsored submit_action tx for the agent to sign" })
  async buildSubmit(@Body() b: BuildSubmitDto) {
    if (b.gasBudget !== undefined && BigInt(b.gasBudget) > MAX_SPONSOR_GAS_BUDGET) {
      throw new BadRequestException(`gasBudget exceeds sponsor cap ${MAX_SPONSOR_GAS_BUDGET}`);
    }

    const agentId = await this.sui.getAgentIdByWallet(b.agentWallet);
    if (!agentId) throw new NotFoundException(`agent ${b.agentWallet} is not registered`);

    // Default the action_id to counter+1 — the on-chain counter tracks the highest used id,
    // so counter+1 is always free (avoids EDuplicateActionId).
    const actionId: bigint =
      b.actionId === undefined || b.actionId === null || b.actionId === ""
        ? (await this.sui.getAgent(agentId)).actionCounter + 1n
        : BigInt(b.actionId);

    const txBytes = await this.sui.buildSponsoredSubmit({
      agentWallet: b.agentWallet,
      agentId,
      targetProgram: b.targetProgram,
      value: BigInt(b.value),
      actionId,
      encryptedPayload: fromBase64(b.encryptedPayload),
      commitmentHash: fromBase64(b.commitmentHash),
      gasBudget: b.gasBudget,
    });

    return {
      transaction: toBase64(txBytes),
      agentId,
      actionId: actionId.toString(),
      sender: b.agentWallet,
      gasOwner: this.sui.address,
    };
  }

  // Co-sign (gas sponsor) + broadcast, then verdict synchronously.
  @Post("submit")
  @HttpCode(HttpStatus.OK)
  @ApiSecurity("x-api-key")
  @ApiOperation({ summary: "Co-sign gas + broadcast + return the synchronous verdict" })
  async submit(@Body() b: SubmitDto) {
    const txBytes = fromBase64(b.transaction);

    // Refuse to sponsor anything that isn't exactly a submit_action we would build.
    try {
      this.sui.assertSponsorable(txBytes, [this.sui.submitTarget()]);
    } catch (e) {
      throw new BadRequestException(`refusing to sponsor: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Don't pay gas for a tx that would abort on-chain.
    const dry = await this.sui.dryRunSponsored(txBytes);
    if (!dry.success) throw new BadRequestException(`transaction would fail on-chain: ${dry.error ?? "unknown"}`);

    const res = await this.sui.executeSponsored(txBytes, b.signature);
    if (res.effects?.status?.status !== "success") {
      throw new BadRequestException(`submit_action failed on-chain: ${res.effects?.status?.error ?? "unknown error"}`);
    }

    const actionObjectId = findCreatedAction(res);
    if (!actionObjectId) throw new InternalServerErrorException("Action object not found in transaction effects");

    const verdict = await this.engine.processAction(actionObjectId);
    this.logger.log(`submit ${actionObjectId} → ${verdict.decision} (${verdict.rawScore}) via ${verdict.analyzer}`);
    return { digest: res.digest, actionId: actionObjectId, verdict: verdictView(verdict, this.cfg.publicBaseUrl) };
  }

  // Dashboard: list actions (newest first), optional filters + pagination.
  @Get()
  @ApiOperation({ summary: "List actions for the dashboard (newest first; filter by agentId/decision)" })
  @ApiQuery({ name: "agentId", required: false })
  @ApiQuery({ name: "decision", required: false, example: "Blocked" })
  @ApiQuery({ name: "limit", required: false, example: 50 })
  @ApiQuery({ name: "offset", required: false, example: 0 })
  listActions(
    @Query("agentId") agentId?: string,
    @Query("decision") decision?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    let items = this.store.listActions();
    if (agentId) items = items.filter((a) => a.agentId === agentId);
    if (decision) items = items.filter((a) => a.decision.toLowerCase() === decision.toLowerCase());
    items = items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
    const total = items.length;
    const off = Math.max(0, Number(offset ?? 0));
    const lim = Math.min(200, Math.max(1, Number(limit ?? 50)));
    const page = items.slice(off, off + lim).map((r) => recordView(r, null, this.cfg.publicBaseUrl));
    return { total, limit: lim, offset: off, items: page };
  }

  // Poll an action: stored record first, fall back to on-chain.
  @Get(":id")
  @ApiOperation({ summary: "Poll an action's status / decision / reasoning" })
  async getAction(@Param("id") id: string) {
    const rec = this.store.getAction(id);
    if (rec) return recordView(rec, this.store.getReasoning(rec.reasoningHash) ?? null, this.cfg.publicBaseUrl);

    const a = await this.sui.getAction(id).catch(() => null);
    if (!a) throw new NotFoundException(`action ${id} not found`);
    return {
      actionId: id,
      onchainActionId: a.actionId.toString(),
      agentId: a.agent,
      targetProgram: a.targetProgram,
      value: a.value.toString(),
      status: a.status,
      decision: labelStatus(a.status),
      rawScore: a.rawScore,
      analyzer: null,
      reasoningHash: hex0x(a.reasoningHash),
      verdictDigest: null,
      reasoning: null,
      escalation: escalationLinks(a.status, id, this.cfg.publicBaseUrl),
    };
  }
}
