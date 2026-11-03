import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Optional,
  Param,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { DeviceFirmwareDiagnosticsService } from '../devices/device-firmware-diagnostics';
import type { DeviceHealthHistoryQuery } from '../devices/device-health-history';
import type { DeviceProxyRequest } from './portal-device-proxy.service';
import { PortalDeviceMeasurementsService } from './portal-device-measurements.service';
import { PortalDeviceElectricalMeasurementsService } from './portal-device-electrical-measurements.service';
import { assertPortalAdministrator } from './portal-authorization';

/** Read-only observation, measurement and diagnostic HTTP boundary. */
@ApiExcludeController()
@Controller('portal')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalDeviceTelemetryController {
  constructor(
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly deviceMeasurements: PortalDeviceMeasurementsService,
    private readonly deviceElectricalMeasurements: PortalDeviceElectricalMeasurementsService,
    @Optional() private readonly firmwareDiagnostics?: DeviceFirmwareDiagnosticsService,
  ) {}

  @Get('devices/:deviceId/observations')
  async getDeviceObservations(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    return this.deviceMeasurements.current({ tenantId: tenant.id, siteId: site.id }, deviceId)
  }

  @Get('devices/:deviceId/read-model')
  async getDeviceReadModel(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    return this.deviceMeasurements.readModel({ tenantId: tenant.id, siteId: site.id }, deviceId)
  }

  @Get('devices/:deviceId/measurements')
  async getDeviceMeasurementHistory(
    @Param('deviceId') deviceId: string,
    @Query('metric') metric: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('limit') limit: unknown,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    return this.deviceMeasurements.history(
      { tenantId: tenant.id, siteId: site.id }, deviceId, metric, from, to, limit,
    )
  }

  @Get('devices/:deviceId/electrical-measurements')
  async getDeviceElectricalMeasurementHistory(
    @Param('deviceId') deviceId: string,
    @Query('metric') metric: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    return this.deviceElectricalMeasurements.history(deviceId, metric, from, to)
  }

  @Get('devices/:deviceId/firmware-diagnostics')
  async getDeviceFirmwareDiagnostics(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    if (!this.firmwareDiagnostics) throw new ServiceUnavailableException('Firmware diagnostics are unavailable')
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    const enrolled = this.deviceRegistry.getDevices().find(device => {
      const physicalId = String(device.metadata?.physicalId || '').toLowerCase()
      const networkScope = String(device.metadata?.networkScope || '')
      return device.id === deviceId && device.tenantId === tenant.id && device.siteId === site.id &&
        device.trustStatus === 'approved' && device.adapter.driver === 'energrid-esp8266' &&
        /^esp8266:[0-9a-f]{6}$/.test(physicalId) && device.id === `device:${networkScope}:${physicalId}`
    })
    if (!enrolled) throw new NotFoundException('Approved Energrid device was not found in this site')
    const result = await this.firmwareDiagnostics.get({ tenantId: tenant.id, siteId: site.id }, deviceId)
    return result ?? { deviceId, available: false, events: [], restartCount10m: 0 }
  }

  @Get('device-health/history')
  async getDeviceHealthHistory(
    @Query('deviceId') deviceId: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('granularity') granularity: unknown,
    @Query('limit') limit: unknown,
    @Query('timezone') timezone: unknown,
    @Query('cursor') cursor: unknown,
    @Query('metrics') metrics: unknown,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    if (!this.firmwareDiagnostics) throw new ServiceUnavailableException('Device health history is unavailable')
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    const selectedGranularity = typeof granularity === 'string' ? granularity : 'hourly'
    if (!['raw', 'hourly', 'daily', 'events', 'failures'].includes(selectedGranularity)) {
      throw new BadRequestException('Unsupported device health history granularity')
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit)
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000)) {
      throw new BadRequestException('Device health history limit must be between 1 and 1000')
    }
    if ((typeof cursor === 'string' && cursor.length > 600) ||
        (typeof metrics === 'string' && metrics.split(',').length > 25)) {
      throw new BadRequestException('Device health history cursor or metric selection is too large')
    }
    const query: DeviceHealthHistoryQuery = {
      granularity: selectedGranularity as DeviceHealthHistoryQuery['granularity'],
      ...(typeof deviceId === 'string' && deviceId.trim() ? { deviceId: deviceId.trim() } : {}),
      ...(typeof from === 'string' ? { from } : {}),
      ...(typeof to === 'string' ? { to } : {}),
      ...(typeof timezone === 'string' ? { timezone } : {}),
      ...(typeof cursor === 'string' ? { cursor } : {}),
      ...(typeof metrics === 'string' && metrics.trim() ? { metrics: metrics.split(',').map(value => value.trim()).filter(Boolean) } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    }
    const authorizedDevices = this.deviceRegistry.getDevices().flatMap(device => {
      const physicalDeviceId = String(device.metadata?.physicalId || '').toLowerCase()
      const networkScope = String(device.metadata?.networkScope || '')
      return device.tenantId === tenant.id && device.siteId === site.id && device.trustStatus === 'approved' &&
        device.adapter.driver === 'energrid-esp8266' && /^esp8266:[0-9a-f]{6}$/.test(physicalDeviceId) &&
        device.id === `device:${networkScope}:${physicalDeviceId}`
        ? [{ deviceId: device.id, physicalDeviceId }] : []
    })
    if (query.deviceId && !authorizedDevices.some(device => device.deviceId === query.deviceId)) {
      throw new NotFoundException('Approved diagnostic device was not found in this site')
    }
    try {
      return await this.firmwareDiagnostics.queryHistory({ tenantId: tenant.id, siteId: site.id }, query, authorizedDevices)
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('Invalid device health history') ||
          error.message.startsWith('Invalid device health query'))) {
        throw new BadRequestException(error.message)
      }
      throw error
    }
  }
}
