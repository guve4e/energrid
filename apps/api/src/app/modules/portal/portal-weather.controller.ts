import { BadRequestException, Body, Controller, Get, Param, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { assertPortalAdministrator } from './portal.controller';
import { DeviceProxyRequest } from './portal-device-proxy.service';
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard';
import { DeviceRegistryService } from '../devices/device-registry.service';

/** Admin-only Portal bridge. The private Core API stays behind its server token. */
@Controller('portal/weather')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalWeatherController {
  constructor(private readonly registry: DeviceRegistryService) {}

  @Get('dashboard')
  dashboard(@Req() request: DeviceProxyRequest) { return this.read(request, '/weather/dashboard'); }
  @Get('performance')
  performance(@Req() request: DeviceProxyRequest) { return this.read(request, '/weather/performance'); }
  @Get('river-performance')
  riverPerformance(@Req() request: DeviceProxyRequest) { return this.read(request, '/river/forecast-performance/Vidin'); }

  @Get('investigator/findings')
  async investigatorFindings(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request);
    const scope = this.registry.getSnapshot();
    return this.investigatorRequest(`/weather/investigator/findings?tenantId=${encodeURIComponent(scope.tenant.id)}&siteId=${encodeURIComponent(scope.site.id)}`);
  }

  @Post('investigator/run')
  async runInvestigation(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request);
    const scope = this.registry.getSnapshot();
    return this.investigatorRequest('/weather/investigator/run', { tenantId: scope.tenant.id, siteId: scope.site.id });
  }

  @Post('investigator/findings/:id/acknowledge')
  async acknowledgeFinding(@Req() request: DeviceProxyRequest, @Param('id') id: string, @Body() body: { action?: unknown }) {
    assertPortalAdministrator(request);
    if (body?.action !== 'acknowledged' && body?.action !== 'dismissed') throw new BadRequestException('Invalid weather finding action');
    const scope = this.registry.getSnapshot();
    return this.investigatorRequest(`/weather/investigator/findings/${encodeURIComponent(id)}/acknowledge`, {
      action: body.action, tenantId: scope.tenant.id, siteId: scope.site.id,
    });
  }

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

  private async investigatorRequest(path: string, body?: Record<string, string>) {
    const base = (process.env.ENERGRID_CORE_URL || 'http://127.0.0.1:3020').replace(/\/$/, '');
    const token = process.env.WEATHER_INVESTIGATOR_API_TOKEN?.trim();
    if (!token) throw new ServiceUnavailableException('Weather investigation bridge is not configured.');
    try {
      const response = await fetch(`${base}/core${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('Core request failed');
      return await response.json();
    } catch {
      throw new ServiceUnavailableException('Weather investigator unavailable. Check that LAB Core and its storage are ready.');
    }
  }
}
