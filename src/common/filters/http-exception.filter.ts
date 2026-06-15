import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";

// Shape every error response as `{ error: message }` to preserve the client contract
// (the agent `protect()` client reads `body.error`). Nest's default is
// `{ statusCode, message, error }`, which would break that.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Api");

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "internal error";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      const raw = typeof resp === "string" ? resp : (resp as any)?.message ?? exception.message;
      message = Array.isArray(raw) ? raw.join("; ") : String(raw); // ValidationPipe → string[]
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status >= 500) this.logger.error(`request error: ${message}`);
    void reply.status(status).send({ error: message });
  }
}
