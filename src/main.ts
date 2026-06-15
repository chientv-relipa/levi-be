// Relayer entrypoint: boots the NestJS (Fastify) HTTP API. The watcher starts itself via
// WatcherService's OnApplicationBootstrap hook.
//
// Run: `npm run start`  (requires OPERATOR_SECRET_KEY + RELAYER_X25519_SECRET in .env)

import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";
import { RELAYER_CONFIG, type RelayerConfig } from "./config/relayer-config";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  // /health stays at the root; everything else is under /api/v1.
  app.setGlobalPrefix("api/v1", { exclude: ["health"] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks(); // OnModuleDestroy → WatcherService.stop()

  const cfg = app.get<RelayerConfig>(RELAYER_CONFIG);
  await app.listen(cfg.port, "0.0.0.0");

  const log = new Logger("Bootstrap");
  log.log(`Levi relayer (gas sponsor + RelayerCap) listening on ${cfg.publicBaseUrl}`);
  if (!cfg.relayerX25519Secret) {
    log.warn("RELAYER_X25519_SECRET not set — payload decryption will fail. Run `npm run set-key`.");
  }
}

void bootstrap();
