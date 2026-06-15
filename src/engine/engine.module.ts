import { Module } from "@nestjs/common";
import { SuiModule } from "../sui/sui.module";
import { AnalyzerModule } from "../analyzer/analyzer.module";
import { StoreModule } from "../store/store.module";
import { EngineService } from "./engine.service";

@Module({
  imports: [SuiModule, AnalyzerModule, StoreModule],
  providers: [EngineService],
  exports: [EngineService],
})
export class EngineModule {}
