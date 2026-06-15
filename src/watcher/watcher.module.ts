import { Module } from "@nestjs/common";
import { SuiModule } from "../sui/sui.module";
import { EngineModule } from "../engine/engine.module";
import { StoreModule } from "../store/store.module";
import { WatcherService } from "./watcher.service";

@Module({
  imports: [SuiModule, EngineModule, StoreModule],
  providers: [WatcherService],
})
export class WatcherModule {}
