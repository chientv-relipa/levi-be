import { Controller, Get, Inject, NotFoundException, Param } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { RELAYER_STORE, type RelayerStore } from "../../store/store.interface";

// GET /api/v1/reasoning/:hash — full reasoning text (on-chain stores only blake3(reasoning)).
@ApiTags("reasoning")
@Controller("reasoning")
export class ReasoningController {
  constructor(@Inject(RELAYER_STORE) private readonly store: RelayerStore) {}

  @Get(":hash")
  @ApiOperation({ summary: "Fetch the full reasoning text by its blake3 hash" })
  reasoning(@Param("hash") hashParam: string) {
    const hash = hashParam.replace(/^0x/, "").toLowerCase();
    const reasoning = this.store.getReasoning(hash);
    if (reasoning === undefined) throw new NotFoundException(`no reasoning stored for hash ${hash}`);
    return { hash, reasoning };
  }
}
