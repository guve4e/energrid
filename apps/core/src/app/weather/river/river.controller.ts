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
import { RiverHistoricalContextService } from './river-historical-context.service';
import { RiverRegionalIntelligenceService } from './river-regional-intelligence.service';

@Controller('river')
export class RiverController {
  constructor(
    private readonly collector: RiverCollectorService,
    private readonly history: RiverHistoryService,
    private readonly historicalContext: RiverHistoricalContextService,
    private readonly regionalIntelligence: RiverRegionalIntelligenceService,
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
  ) {
    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
      throw new BadRequestException(
        'Query parameter "value" must be a valid number',
      );
    }

    return this.historicalContext.getWaterLevelContext(stationCode, value);
  }
  @Get('regional-context/vidin')
  getVidinRegionalContext() {
    return this.regionalIntelligence.getVidinContext();
  }
}
