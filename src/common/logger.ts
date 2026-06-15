// Minimal structured logger usable from services, scripts, and tests. Never log secrets
// (signer key, x25519 secret, API key). Services may also use NestJS's own Logger.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(name = "levi"): Logger {
  const emit =
    (level: LogLevel) =>
    (...args: unknown[]) => {
      const sink = level === "debug" ? console.log : console[level];
      sink(`${new Date().toISOString()} [${level.toUpperCase()}] ${name}:`, ...args);
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
