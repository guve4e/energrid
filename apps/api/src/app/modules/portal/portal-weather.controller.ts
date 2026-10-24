import { Controller, Get, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { assertPortalAdministrator } from './portal.controller';
import { DeviceProxyRequest } from './portal-device-proxy.service';
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard';

/** Only these read endpoints are exposed. The private core API stays private. */
@Controller('portal/weather')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalWeatherController {
  @Get('dashboard')
  dashboard(@Req() request: DeviceProxyRequest) { return this.read(request, '/weather/dashboard'); }
  @Get('performance')
  performance(@Req() request: DeviceProxyRequest) { return this.read(request, '/weather/performance'); }
  @Get('river-performance')
  riverPerformance(@Req() request: DeviceProxyRequest) { return this.read(request, '/river/forecast-performance/Vidin'); }

  private async read(request: DeviceProxyRequest, path: string) {
    assertPortalAdministrator(request);
    const base = (process.env.ENERGRID_CORE_URL || 'http://127.0.0.1:3020').replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/core${path}`, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Core request failed');
      return await response.json();
    } catch {
      throw new ServiceUnavailableException('Weather service unavailable. Check that the core service is running.');
    }
  }
}
