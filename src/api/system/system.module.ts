import { Module } from "@nestjs/common";
import { SuiModule } from "../../sui/sui.module";
import { SystemController } from "./system.controller";

@Module({ imports: [SuiModule], controllers: [SystemController] })
export class SystemModule {}
