// Relayer entrypoint: boots the NestJS (Fastify) HTTP API. The watcher starts itself via
// WatcherService's OnApplicationBootstrap hook.
//
// Run: `npm run start`  (requires OPERATOR_SECRET_KEY + RELAYER_X25519_SECRET in .env)

import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";
import { RELAYER_CONFIG, type RelayerConfig } from "./config/relayer-config";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  const cfg = app.get<RelayerConfig>(RELAYER_CONFIG);

  // CORS for the dashboard UI. CORS_ORIGINS (comma-separated) locks it down; unset = reflect any.
  app.enableCors({
    origin: cfg.corsOrigins ?? true,
    methods: ["GET", "POST"],
    allowedHeaders: ["content-type", "x-api-key"],
  });

  // /health stays at the root; everything else is under /api/v1.
  app.setGlobalPrefix("api/v1", { exclude: ["health"] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks(); // OnModuleDestroy → WatcherService.stop()

  // Swagger UI at /docs (outside the api/v1 prefix). OpenAPI JSON at /docs-json.
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Levi Relayer API")
    .setDescription(
      "Off-chain security firewall for the Levi Sui contract — encrypt → analyze → verdict."
    )
    .setVersion("0.1.0")
    .addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }, "x-api-key")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(cfg.port, "0.0.0.0");

  const log = new Logger("Bootstrap");
  log.log(`Levi relayer (gas sponsor + RelayerCap) listening on http://localhost:${cfg.port}`);
  log.log(`Swagger UI: http://localhost:${cfg.port}/docs`);
  if (!cfg.publicBaseUrl.endsWith(`:${cfg.port}`)) {
    log.warn(`PUBLIC_BASE_URL (${cfg.publicBaseUrl}) port ≠ listen port (${cfg.port}) — set PORT to match`);
  }
  if (!cfg.relayerX25519Secret) {
    log.warn("RELAYER_X25519_SECRET not set — payload decryption will fail. Run `npm run set-key`.");
  }
}

void bootstrap();
