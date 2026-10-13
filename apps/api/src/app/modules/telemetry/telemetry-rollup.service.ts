import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { TELEMETRY_CONFIG, TelemetryConfig } from './telemetry.config';
import { TelemetryStore } from './telemetry.store';

@Injectable()
export class TelemetryRollupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryRollupService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  constructor(
    @Inject(TELEMETRY_CONFIG) private readonly config: TelemetryConfig,
    private readonly store: TelemetryStore,
  ) {}

  onModuleInit() {
    if (!this.config.enabled) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.rollupIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  runCycle(): Promise<number> {
    if (!this.config.enabled) return Promise.resolve(0);
    if (this.running) return this.running;
    this.running = this.refresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async refresh() {
    let count = 0;
    while (count < 500 && (await this.store.refreshOneHour())) count++;
    return count;
  }

  private async tick() {
    try {
      await this.runCycle();
    } catch {
      this.logger.warn(
        'Telemetry summaries could not refresh; queued hours remain pending.',
      );
    }
  }
}
