import { Controller, Get, Param, Post } from '@nestjs/common';
import { RiverCollectorService } from './river-collector.service';
import { RiverHistoryService } from './river-history.service';

@Controller('river')
export class RiverController {
  constructor(
    private readonly collector: RiverCollectorService,
    private readonly history: RiverHistoryService,
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
}
