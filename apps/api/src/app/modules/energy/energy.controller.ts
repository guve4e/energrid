import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { assertPortalAdministrator } from '../portal/portal.controller';
import type { DeviceProxyRequest } from '../portal/portal-device-proxy.service';
import { EnergyService } from './energy.service';
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard';

@Controller('portal/energy')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class EnergyController {
  constructor(private readonly energy: EnergyService) {}

  @Get('assets')
  assets(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request);
    return this.energy.assets();
  }

  @Get('assets/:assetId/history')
  history(
    @Req() request: DeviceProxyRequest,
    @Param('assetId') assetId: string,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
  ) {
    assertPortalAdministrator(request);
    return this.energy.dashboard(assetId, from, to);
  }
}
