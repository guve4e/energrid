import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WeatherProviderService } from './weather-provider.service';
import { WeatherRiskEngine } from './weather-risk.engine';
import { WeatherIntelligenceService } from './weather-intelligence.service';
import { WeatherVerificationService } from './weather-verification.service';
import { compareWeather } from './weather-comparison';
import { WeatherDailyVerificationService } from './weather-daily-verification.service';
import { WeatherObservationCollector } from './weather-observation-collector.service';
import { weatherObservationMode, weatherObservationSource } from './weather-observations';
import { WeatherCoordinates } from './weather-observations';

@Injectable()
export class WeatherVerificationScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(WeatherVerificationScheduler.name);
  constructor(private readonly provider: WeatherProviderService,
    private readonly risk: WeatherRiskEngine, private readonly intelligence: WeatherIntelligenceService,
    private readonly verification: WeatherVerificationService,
    private readonly daily: WeatherDailyVerificationService,
    private readonly observations: WeatherObservationCollector) {}

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
    let coordinates: WeatherCoordinates | undefined;
    let observationSource = weatherObservationSource();
    try {
      const snapshots = await Promise.all([this.provider.getSnapshot('icon_seamless'), this.provider.getSnapshot('ncep_gfs_seamless')]);
      coordinates = snapshots[0]?.coordinates;
      const { selected } = compareWeather(snapshots, null, this.risk, this.intelligence);
      const recordings = await Promise.allSettled([
        this.verification.record(snapshots, selected.snapshot),
        this.daily.record(snapshots, selected.snapshot),
      ]);
      for (const [index, result] of recordings.entries()) {
        if (result.status === 'rejected') this.logger.warn(`${index ? 'Daily' : 'Hourly'} forecast recording unavailable: ${String(result.reason)}`);
      }
    } catch (error) { this.logger.warn(`Forecast recording unavailable: ${String(error)}`); }
    finally {
      try {
        const collection = await this.observations.collect(new Date(), coordinates);
        if (collection.source) observationSource = collection.source;
      }
      catch { this.logger.warn('Weather observation collection unavailable'); }
      try { await this.verification.evaluate(observationSource); }
      catch (error) { this.logger.warn(`Forecast evaluation unavailable: ${String(error)}`); }
      try { await this.daily.evaluate(observationSource, weatherObservationMode()); }
      catch (error) { this.logger.warn(`Daily forecast evaluation unavailable: ${String(error)}`); }
      this.running = false;
    }
  }
}
