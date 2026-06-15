import { Module } from "@nestjs/common";
import { SuiModule } from "../../sui/sui.module";
import { EngineModule } from "../../engine/engine.module";
import { StoreModule } from "../../store/store.module";
import { ActionsController } from "./actions.controller";

@Module({
  imports: [SuiModule, EngineModule, StoreModule],
  controllers: [ActionsController],
})
export class ActionsModule {}
