import { Module } from "@nestjs/common";
import { StoreModule } from "../../store/store.module";
import { PoliciesController } from "./policies.controller";

@Module({ imports: [StoreModule], controllers: [PoliciesController] })
export class PoliciesModule {}
