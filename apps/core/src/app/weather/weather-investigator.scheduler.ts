import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WeatherInvestigatorService } from './weather-investigator.service';

@Injectable()
export class WeatherInvestigatorScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private running = false;
  private failures = 0;
  private intervalMs = 60 * 60000;
  private readonly logger = new Logger(WeatherInvestigatorScheduler.name);
  constructor(private readonly investigator: WeatherInvestigatorService) {}

  onModuleInit() {
    if (
      process.env.ENERGRID_LAB_MODE !== 'true' ||
      process.env.WEATHER_INVESTIGATOR_ENABLED !== 'true'
    )
      return;
    const configured = Number(
      process.env.WEATHER_INVESTIGATOR_INTERVAL_MINUTES || 60,
    );
    this.intervalMs =
      Math.min(
        24 * 60,
        Math.max(5, Number.isFinite(configured) ? configured : 60),
      ) * 60000;
    void this.runCycle();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runCycle() {
    if (this.running || process.env.ENERGRID_LAB_MODE !== 'true') return;
    this.running = true;
    try {
      const result = await this.investigator.run();
      if (result.status === 'completed' || result.status === 'already-running')
        this.failures = 0;
      else {
        this.failures++;
        this.logger.warn(`Weather investigation status: ${result.status}`);
      }
    } catch (error) {
      this.failures++;
      this.logger.warn(`Weather investigation unavailable: ${String(error)}`);
    } finally {
      this.running = false;
      if (
        process.env.ENERGRID_LAB_MODE === 'true' &&
        process.env.WEATHER_INVESTIGATOR_ENABLED === 'true'
      ) {
        const retryDelay = Math.min(
          15 * 60000,
          60000 * 2 ** Math.max(0, this.failures - 1),
        );
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
