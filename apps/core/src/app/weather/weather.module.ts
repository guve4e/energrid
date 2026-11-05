import { Module } from '@nestjs/common';
import { WeatherController } from './weather.controller';
import { WeatherService } from './weather.service';
import { WeatherProviderService } from './weather-provider.service';
import { WeatherRiskEngine } from './weather-risk.engine';
import { DanubeProviderService } from './danube-provider.service';
import { WeatherIntelligenceService } from './weather-intelligence.service';
import { AppdDanubeProviderService } from './river/appd-danube-provider.service';
import { DanubePortalProviderService } from './river/danube-portal-provider.service';
import { RiverIntelligenceService } from './river/river-intelligence.service';
import { RiverService } from './river/river.service';
import { RiverHistoryService } from './river/river-history.service';
import { RiverSourceObservationStore } from './river/river-source-observation.store';
import { RiverCollectorService } from './river/river-collector.service';
import { RiverController } from './river/river.controller';
import { RiverStationNormalizerService } from './river/river-station-normalizer.service';
import { RiverSchedulerService } from './river/river-scheduler.service';
import { RiverHistoricalContextService } from './river/river-historical-context.service';
import { RiverHydrologicalIntelligenceService } from './river/river-hydrological-intelligence.service';
import { RiverRegionalIntelligenceService } from './river/river-regional-intelligence.service';
import { TravelTimeEngine } from './river/engines/travel-time.engine';
import { HistoricalAnalogueEngine } from './river/analogue/historical-analogue.engine';
import { HistoricalAnalogueService } from './river/analogue/historical-analogue.service';
import { ForecastBacktestEngine } from './river/backtest/forecast-backtest.engine';
import { ConfidenceEngine } from './river/engines/confidence/confidence.engine';
import { RiverForecastService } from './river/forecast/river-forecast.service';
import { RiverForecastRecorderService } from './river/forecast-monitoring/river-forecast-recorder.service';
import { RiverForecastEvaluatorService } from './river/forecast-monitoring/river-forecast-evaluator.service';
import { RiverForecastPerformanceService } from './river/forecast-monitoring/river-forecast-performance.service';
import { ForecastEngine } from './river/engines/forecast.engine';
import { WeatherVerificationService } from './weather-verification.service';
import { WeatherVerificationController } from './weather-verification.controller';
import { WeatherVerificationScheduler } from './weather-verification.scheduler';
import { WeatherDailyVerificationService } from './weather-daily-verification.service';
import { WeatherObservationCollector } from './weather-observation-collector.service';
import { WeatherStationDailyService } from './weather-station-daily.service';
import { WeatherInvestigatorController } from './weather-investigator.controller';
import { WEATHER_INVESTIGATOR_PROVIDER, WeatherInvestigatorService } from './weather-investigator.service';
import { WeatherInvestigatorScheduler } from './weather-investigator.scheduler';
import { ApiWeatherInvestigatorProvider, FixtureWeatherInvestigatorProvider } from './weather-investigator';
import { DwdForecastTileController } from './dwd-forecast-tile.controller';
import { DwdForecastTileService } from './dwd-forecast-tile.service';

@Module({
  controllers: [WeatherController, RiverController, WeatherVerificationController, WeatherInvestigatorController, DwdForecastTileController],
  providers: [
    WeatherVerificationService,
    WeatherVerificationScheduler,
    WeatherDailyVerificationService,
    WeatherObservationCollector,
    WeatherStationDailyService,
    WeatherInvestigatorService,
    WeatherInvestigatorScheduler,
    DwdForecastTileService,
    { provide: WEATHER_INVESTIGATOR_PROVIDER, useFactory: () =>
      process.env.ENERGRID_LAB_MODE === 'true' &&
      process.env.WEATHER_INVESTIGATOR_PROVIDER === 'api-llm' &&
      !!process.env.WEATHER_INVESTIGATOR_OPAQUE_SITE_ID?.trim()
        ? new ApiWeatherInvestigatorProvider()
        : new FixtureWeatherInvestigatorProvider() },
    WeatherService,
    WeatherProviderService,
    WeatherRiskEngine,
    DanubeProviderService,
    WeatherIntelligenceService,
    AppdDanubeProviderService,
    DanubePortalProviderService,
    RiverIntelligenceService,
    RiverService,
    RiverHistoryService,
    RiverSourceObservationStore,
    RiverCollectorService,
    RiverStationNormalizerService,
    RiverSchedulerService,
    RiverHistoricalContextService,
    RiverHydrologicalIntelligenceService,
    RiverRegionalIntelligenceService,
    TravelTimeEngine,
    HistoricalAnalogueEngine,
    HistoricalAnalogueService,
    ForecastEngine,
    ConfidenceEngine,
    ForecastBacktestEngine,
    RiverForecastService,
    RiverForecastRecorderService,
    RiverForecastEvaluatorService,
    RiverForecastPerformanceService,
  ],
})
export class WeatherModule {}
