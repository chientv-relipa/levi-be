import { Module } from "@nestjs/common";
import { StoreModule } from "../../store/store.module";
import { ApprovalsController } from "./approvals.controller";

@Module({ imports: [StoreModule], controllers: [ApprovalsController] })
export class ApprovalsModule {}
