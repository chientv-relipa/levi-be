import { Module } from "@nestjs/common";
import { SuiModule } from "../../sui/sui.module";
import { AgentsController } from "./agents.controller";

@Module({ imports: [SuiModule], controllers: [AgentsController] })
export class AgentsModule {}
