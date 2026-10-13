import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { assertPortalControlToken } from '../portal/portal.controller';
import type { DeviceProxyRequest } from '../portal/portal-device-proxy.service';
import { EnergyService } from './energy.service';

@Controller('portal/energy')
export class EnergyController {
  constructor(private readonly energy: EnergyService) {}

  @Get('assets')
  assets(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request);
    return this.energy.assets();
  }

  @Get('assets/:assetId/history')
  history(
    @Req() request: DeviceProxyRequest,
    @Param('assetId') assetId: string,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
  ) {
    assertPortalControlToken(request);
    return this.energy.dashboard(assetId, from, to);
  }
}
