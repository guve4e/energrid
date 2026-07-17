import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { RiverCollectorService } from './river-collector.service';
import { RiverHistoryService } from './river-history.service';
import {
  RiverHistoricalContextService,
  RiverHistoricalMetric,
} from './river-historical-context.service';
import { RiverRegionalIntelligenceService } from './river-regional-intelligence.service';
import { RiverHydrologicalIntelligenceService } from './river-hydrological-intelligence.service';

import { RiverForecastPerformanceService } from './forecast-monitoring/river-forecast-performance.service';
@Controller('river')
export class RiverController {
  constructor(
    private readonly collector: RiverCollectorService,
    private readonly history: RiverHistoryService,
    private readonly historicalContext: RiverHistoricalContextService,
    private readonly regionalIntelligence: RiverRegionalIntelligenceService,
    private readonly hydrologicalIntelligence: RiverHydrologicalIntelligenceService,
    private readonly forecastPerformance: RiverForecastPerformanceService,
  ) {}

  @Post('collect')
  collectNow() {
    return this.collector.collectNow();
  }

  @Get('history/:station')
  getHistory(@Param('station') station: string) {
    return this.history.getRecent(station, 48);
  }

  @Get('trend/:station')
  getTrend(@Param('station') station: string) {
    return this.history.getStationTrend(station, 336);
  }
  @Get('historical-context/:stationCode')
  getHistoricalContext(
    @Param('stationCode') stationCode: string,
    @Query('value') rawValue: string,
    @Query('metric') rawMetric = 'water_level',
  ) {
    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
      throw new BadRequestException(
        'Query parameter "value" must be a valid number',
      );
    }

    const supportedMetrics: RiverHistoricalMetric[] = [
      'water_level',
      'water_discharge',
      'water_temperature',
    ];

    if (!supportedMetrics.includes(rawMetric as RiverHistoricalMetric)) {
      throw new BadRequestException(
        'Query parameter "metric" must be one of: ' +
          supportedMetrics.join(', '),
      );
    }

    return this.historicalContext.getContext(
      stationCode,
      rawMetric as RiverHistoricalMetric,
      value,
    );
  }
  @Get('regional-context/vidin')
  getVidinRegionalContext() {
    return this.regionalIntelligence.getVidinContext();
  }

  @Get('hydrological-context/vidin')
  getVidinHydrologicalContext() {
    return this.hydrologicalIntelligence.getVidinContext();
  }
  @Get('forecast-performance/:station')
  getForecastPerformance(
    @Param('station') station: string,
    @Query('days') rawDays = '90',
  ) {
    const parsedDays = Number(rawDays);

    const days = Number.isFinite(parsedDays) ? parsedDays : 90;

    return this.forecastPerformance.getPerformance(station, days);
  }
}
