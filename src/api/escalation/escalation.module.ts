import { Module } from "@nestjs/common";
import { SuiModule } from "../../sui/sui.module";
import { StoreModule } from "../../store/store.module";
import { EscalationController } from "./escalation.controller";

@Module({
  imports: [SuiModule, StoreModule],
  controllers: [EscalationController],
})
export class EscalationModule {}
