// Background safety net: polls `ActionSubmitted` events and feeds each action to the engine.
//
// Actions submitted through the API are verdicted synchronously; the watcher catches anything
// submitted out-of-band (an agent calling submit_action directly) so no pending action is left
// un-judged. The engine is idempotent + race-safe, so overlap with the API path is harmless.
//
// Cursor advances only after a full batch is handled. If an action throws an operator fault
// (missing key, RPC down) the batch aborts without advancing, and the next tick retries from
// the same cursor — already-verdicted actions short-circuit on their status.

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { RELAYER_CONFIG, type RelayerConfig } from "../config/relayer-config";
import { SuiService } from "../sui/sui.service";
import { EngineService } from "../engine/engine.service";
import { RELAYER_STORE, type RelayerStore } from "../store/store.interface";

@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("Watcher");
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sui: SuiService,
    private readonly engine: EngineService,
    @Inject(RELAYER_STORE) private readonly store: RelayerStore,
    @Inject(RELAYER_CONFIG) private readonly cfg: RelayerConfig
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Poll once: process every new ActionSubmitted event, then advance the cursor. */
  async runOnce(): Promise<number> {
    const cursor = this.store.getCursor();
    const { events, nextCursor } = await this.sui.queryActionSubmitted(cursor);

    for (const ev of events) {
      const res = await this.engine.processAction(ev.action); // throws on operator fault
      this.logger.log(
        `${ev.action} → ${res.decision} (${res.rawScore}) ${res.skipped ? "[skipped]" : `via ${res.analyzer}`}`
      );
    }

    if (events.length > 0) this.store.setCursor(nextCursor);
    return events.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.log(`started (poll every ${this.cfg.pollIntervalMs}ms)`);
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.runOnce();
    } catch (e) {
      this.logger.error(`tick failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.tick(), this.cfg.pollIntervalMs);
    }
  }
}
