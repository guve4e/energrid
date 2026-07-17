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
import {ForecastEngine} from "./river/engines/forecast.engine";

@Module({
  controllers: [WeatherController, RiverController],
  providers: [
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
    RiverForecastService
  ],
})
export class WeatherModule {}
