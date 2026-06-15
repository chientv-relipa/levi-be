import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { RELAYER_CONFIG, type RelayerConfig } from "../../config/relayer-config";

// N2 — per-IP fixed-window rate limit (applies to all routes). Singleton guard, so the
// buckets persist for the life of the app instance.
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(@Inject(RELAYER_CONFIG) private readonly cfg: RelayerConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const now = Date.now();
    let bucket = this.buckets.get(req.ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.cfg.rateLimitWindowMs };
      this.buckets.set(req.ip, bucket);
    }
    bucket.count++;
    if (bucket.count > this.cfg.rateLimitMax) {
      void reply.header("retry-after", Math.ceil((bucket.resetAt - now) / 1000));
      throw new HttpException("rate limit exceeded", HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
