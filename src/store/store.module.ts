import { Module } from "@nestjs/common";
import { RELAYER_STORE } from "./store.interface";
import { JsonStore } from "./json-store.service";

@Module({
  // useFactory so Nest doesn't try to inject JsonStore's optional `path` constructor arg.
  providers: [{ provide: RELAYER_STORE, useFactory: () => new JsonStore() }],
  exports: [RELAYER_STORE],
})
export class StoreModule {}
