import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

import { RELAYER_CONFIG, type RelayerConfig } from "../../config/relayer-config";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// N2 — require x-api-key on write (POST) routes when RELAYER_API_KEY is set. Reads are public.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(RELAYER_CONFIG) private readonly cfg: RelayerConfig) {
    if (!cfg.apiKey) {
      new Logger("ApiKeyGuard").warn("RELAYER_API_KEY not set — write routes are UNAUTHENTICATED");
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.cfg.apiKey) return true; // auth disabled
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (req.method !== "POST") return true;

    const provided = req.headers["x-api-key"];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!value || !safeEqual(value, this.cfg.apiKey)) {
      throw new UnauthorizedException("invalid or missing x-api-key");
    }
    return true;
  }
}
