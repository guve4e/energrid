import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WeatherInvestigatorService } from './weather-investigator.service';
import type { WeatherInvestigatorScheduleState } from './weather-investigator-readiness';

@Injectable()
export class WeatherInvestigatorScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private running = false;
  private destroyed = false;
  private failures = 0;
  // Keep the default collection cadence below the read model's 30-minute freshness limit.
  private intervalMs = 15 * 60000;
  private lastAttemptAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastOutcome: WeatherInvestigatorScheduleState['lastOutcome'] = null;
  private nextAttemptAt: string | null = null;
  private readonly logger = new Logger(WeatherInvestigatorScheduler.name);
  constructor(private readonly investigator: WeatherInvestigatorService) {}

  onModuleInit() {
    this.destroyed = false;
    if (
      process.env.ENERGRID_LAB_MODE !== 'true' ||
      process.env.WEATHER_INVESTIGATOR_ENABLED !== 'true'
    )
      return;
    const configured = Number(
      process.env.WEATHER_INVESTIGATOR_INTERVAL_MINUTES || 15,
    );
    this.intervalMs =
      Math.min(
        24 * 60,
        Math.max(5, Number.isFinite(configured) ? configured : 15),
      ) * 60000;
    void this.runCycle();
  }

  onModuleDestroy() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextAttemptAt = null;
  }

  snapshot(): WeatherInvestigatorScheduleState {
    return {
      enabled: process.env.ENERGRID_LAB_MODE === 'true' &&
        process.env.WEATHER_INVESTIGATOR_ENABLED === 'true',
      running: this.running,
      intervalMinutes: this.intervalMs / 60000,
      consecutiveFailures: this.failures,
      lastAttemptAt: this.lastAttemptAt,
      lastCompletedAt: this.lastCompletedAt,
      lastOutcome: this.lastOutcome,
      nextAttemptAt: this.nextAttemptAt,
    };
  }

  async runCycle() {
    if (this.destroyed || this.running || process.env.ENERGRID_LAB_MODE !== 'true' ||
        process.env.WEATHER_INVESTIGATOR_ENABLED !== 'true') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextAttemptAt = null;
    this.running = true;
    this.lastAttemptAt = new Date().toISOString();
    try {
      const result = await this.investigator.run();
      this.lastOutcome = result.status === 'completed' || result.status === 'already-running' ||
        result.status === 'weather-unavailable' || result.status === 'stale-or-incomplete'
        ? result.status : 'error';
      if (result.status === 'completed') this.lastCompletedAt = new Date().toISOString();
      if (result.status === 'completed' || result.status === 'already-running')
        this.failures = 0;
      else {
        this.failures++;
        this.logger.warn(`Weather investigation status: ${result.status}`);
      }
    } catch {
      this.failures++;
      this.lastOutcome = 'error';
      // A stable, non-sensitive failure signal; details belong in bounded server diagnostics.
      this.logger.warn('Weather investigation cycle failed');
    } finally {
      this.running = false;
      if (
        !this.destroyed && process.env.ENERGRID_LAB_MODE === 'true' &&
        process.env.WEATHER_INVESTIGATOR_ENABLED === 'true'
      ) {
        const retryDelay = Math.min(
          15 * 60000,
          60000 * 2 ** Math.max(0, this.failures - 1),
        );
        this.nextAttemptAt = new Date(Date.now() + (this.failures ? retryDelay : this.intervalMs)).toISOString();
        this.timer = setTimeout(
          () => {
            void this.runCycle();
          },
          this.failures ? retryDelay : this.intervalMs,
        );
        this.timer.unref();
      }
    }
  }
}
