import { Controller, Get, Inject } from "@nestjs/common";

import { SuiService } from "../../sui/sui.service";
import { RELAYER_CONFIG, type RelayerConfig } from "../../config/relayer-config";
import { hex0x } from "../../common/util/view";

// GET /api/v1/system/config — everything an agent needs to encrypt + address the contract.
@Controller("system")
export class SystemController {
  constructor(
    private readonly sui: SuiService,
    @Inject(RELAYER_CONFIG) private readonly cfg: RelayerConfig
  ) {}

  @Get("config")
  async config() {
    const c = await this.sui.getConfig();
    return {
      packageId: this.cfg.addresses.packageId,
      configId: this.cfg.addresses.configId,
      registryId: this.cfg.addresses.registryId,
      // The backend wallet doubles as gas sponsor + RelayerCap holder.
      relayerAddress: this.sui.address,
      // x25519 public key agents encrypt their ActionPayload to.
      relayerEncryptionKey: hex0x(c.relayerEncryptionKey),
      thresholds: { escalate: c.escalateThreshold, block: c.blockThreshold },
      maxStrikes: c.maxStrikes,
      maintenance: c.maintenance,
    };
  }
}
