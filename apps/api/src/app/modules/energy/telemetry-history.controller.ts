import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { assertPortalControlToken } from '../portal/portal.controller';
import type { DeviceProxyRequest } from '../portal/portal-device-proxy.service';
import { TelemetryIngestService } from '../telemetry/telemetry-ingest.service';
import { CanonicalPowerHistoryReader } from './canonical-power-history.reader';

@Controller('portal/energy/telemetry')
export class TelemetryHistoryController {
  constructor(
    private readonly ingest: TelemetryIngestService,
    private readonly history: CanonicalPowerHistoryReader,
  ) {}

  @Get('status')
  status(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request);
    return this.ingest.status();
  }

  @Get('assets/:assetId/hourly')
  async hourly(
    @Req() request: DeviceProxyRequest,
    @Param('assetId') id: string,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
  ) {
    assertPortalControlToken(request);
    try {
      return await this.history.summaries(id, from, to);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Choose past UTC'))
        throw new BadRequestException(error.message);
      throw error;
    }
  }
}
