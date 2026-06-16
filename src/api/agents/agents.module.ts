import { Module } from "@nestjs/common";
import { SuiModule } from "../../sui/sui.module";
import { StoreModule } from "../../store/store.module";
import { AgentsController } from "./agents.controller";
import { AgentsManagementController } from "./agents-management.controller";

@Module({
  imports: [SuiModule, StoreModule],
  controllers: [AgentsController, AgentsManagementController],
})
export class AgentsModule {}
