import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SuiService } from "../sui/sui.service";

// GET /health (excluded from the /api/v1 prefix) — liveness.
@ApiTags("health")
@Controller()
export class HealthController {
  constructor(private readonly sui: SuiService) {}

  @Get("health")
  @ApiOperation({ summary: "Liveness probe" })
  health() {
    return { ok: true, relayer: this.sui.address };
  }
}
