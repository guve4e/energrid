import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WeatherProviderService } from './weather-provider.service';
import { WeatherRiskEngine } from './weather-risk.engine';
import { WeatherIntelligenceService } from './weather-intelligence.service';
import { WeatherVerificationService } from './weather-verification.service';
import { compareWeather } from './weather-comparison';

@Injectable()
export class WeatherVerificationScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(WeatherVerificationScheduler.name);
  constructor(private readonly provider: WeatherProviderService,
    private readonly risk: WeatherRiskEngine, private readonly intelligence: WeatherIntelligenceService,
    private readonly verification: WeatherVerificationService) {}

  onModuleInit() {
    if (process.env.WEATHER_VERIFICATION_ENABLED === 'false') return;
    void this.runCycle();
    this.timer = setInterval(() => { void this.runCycle(); }, 60 * 60000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async runCycle() {
    if (this.running) return;
    this.running = true;
    try {
      const snapshots = await Promise.all([this.provider.getSnapshot('icon_seamless'), this.provider.getSnapshot('ncep_gfs_seamless')]);
      const { selected } = compareWeather(snapshots, null, this.risk, this.intelligence);
      await this.verification.record(snapshots, selected.snapshot);
    } catch (error) { this.logger.warn(`Forecast recording unavailable: ${String(error)}`); }
    finally {
      try { await this.verification.evaluate(); }
      catch (error) { this.logger.warn(`Forecast evaluation unavailable: ${String(error)}`); }
      this.running = false;
    }
  }
}
