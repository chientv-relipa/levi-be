import { Module } from "@nestjs/common";
import { StoreModule } from "../../store/store.module";
import { ReasoningController } from "./reasoning.controller";

@Module({ imports: [StoreModule], controllers: [ReasoningController] })
export class ReasoningModule {}
