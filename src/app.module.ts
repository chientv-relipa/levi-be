import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { ConfigModule } from "./config/config.module";
import { SuiModule } from "./sui/sui.module";
import { AnalyzerModule } from "./analyzer/analyzer.module";
import { StoreModule } from "./store/store.module";
import { EngineModule } from "./engine/engine.module";
import { WatcherModule } from "./watcher/watcher.module";
import { SystemModule } from "./api/system/system.module";
import { AgentsModule } from "./api/agents/agents.module";
import { ActionsModule } from "./api/actions/actions.module";
import { ReasoningModule } from "./api/reasoning/reasoning.module";
import { EscalationModule } from "./api/escalation/escalation.module";
import { StatsModule } from "./api/stats/stats.module";
import { HealthController } from "./api/health.controller";
import { RateLimitGuard } from "./common/guards/rate-limit.guard";
import { ApiKeyGuard } from "./common/guards/api-key.guard";

@Module({
  imports: [
    ConfigModule,
    SuiModule,
    AnalyzerModule,
    StoreModule,
    EngineModule,
    WatcherModule,
    SystemModule,
    AgentsModule,
    ActionsModule,
    ReasoningModule,
    EscalationModule,
    StatsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global guards run in order: rate-limit first, then API-key auth.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AppModule {}
