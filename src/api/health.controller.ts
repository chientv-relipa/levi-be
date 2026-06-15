import { Controller, Get } from "@nestjs/common";
import { SuiService } from "../sui/sui.service";

// GET /health (excluded from the /api/v1 prefix) — liveness.
@Controller()
export class HealthController {
  constructor(private readonly sui: SuiService) {}

  @Get("health")
  health() {
    return { ok: true, relayer: this.sui.address };
  }
}
