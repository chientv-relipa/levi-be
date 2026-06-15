import { Global, Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";

import { RELAYER_CONFIG, loadConfig } from "./relayer-config";

// Global so every feature module can inject RELAYER_CONFIG without re-importing.
@Global()
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true })],
  providers: [{ provide: RELAYER_CONFIG, useFactory: loadConfig }],
  exports: [RELAYER_CONFIG],
})
export class ConfigModule {}
