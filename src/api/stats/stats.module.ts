import { Module } from "@nestjs/common";
import { StoreModule } from "../../store/store.module";
import { StatsController } from "./stats.controller";

@Module({ imports: [StoreModule], controllers: [StatsController] })
export class StatsModule {}
