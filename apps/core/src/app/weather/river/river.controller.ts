import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RiverCollectorService } from './river-collector.service';
import { RiverHistoryService } from './river-history.service';
import {
  RiverHistoricalContextService,
  RiverHistoricalMetric,
} from './river-historical-context.service';
import { RiverRegionalIntelligenceService } from './river-regional-intelligence.service';
import { RiverHydrologicalIntelligenceService } from './river-hydrological-intelligence.service';

import { RiverForecastPerformanceService } from './forecast-monitoring/river-forecast-performance.service';
@ApiTags('river')
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
  @ApiOperation({ summary: 'Collect river readings now' })
  collectNow() {
    return this.collector.collectNow();
  }

  @Get('history/:station')
  @ApiOperation({ summary: 'Get recent river history for a station' })
  @ApiParam({ name: 'station', example: 'vidin' })
  getHistory(@Param('station') station: string) {
    return this.history.getRecent(station, 48);
  }

  @Get('trend/:station')
  @ApiOperation({ summary: 'Get river trend for a station' })
  @ApiParam({ name: 'station', example: 'vidin' })
  getTrend(@Param('station') station: string) {
    return this.history.getStationTrend(station, 336);
  }
  @Get('historical-context/:stationCode')
  @ApiOperation({ summary: 'Compare a river value with historical context' })
  @ApiParam({ name: 'stationCode', example: 'vidin' })
  @ApiQuery({ name: 'value', example: 320 })
  @ApiQuery({
    name: 'metric',
    required: false,
    enum: ['water_level', 'water_discharge', 'water_temperature'],
  })
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
  @ApiOperation({ summary: 'Get Vidin regional river context' })
  getVidinRegionalContext() {
    return this.regionalIntelligence.getVidinContext();
  }

  @Get('hydrological-context/vidin')
  @ApiOperation({ summary: 'Get Vidin hydrological river context' })
  getVidinHydrologicalContext() {
    return this.hydrologicalIntelligence.getVidinContext();
  }
  @Get('forecast-performance/:station')
  @ApiOperation({ summary: 'Get forecast performance for a station' })
  @ApiParam({ name: 'station', example: 'vidin' })
  @ApiQuery({ name: 'days', required: false, example: 90 })
  getForecastPerformance(
    @Param('station') station: string,
    @Query('days') rawDays = '90',
  ) {
    const parsedDays = Number(rawDays);

    const days = Number.isFinite(parsedDays) ? parsedDays : 90;

    return this.forecastPerformance.getPerformance(station, days);
  }
}
