import { Body, Controller, Get, Header, Param, Post, Req, Sse, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { map } from 'rxjs';
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { DeviceMqttIngestService } from '../devices/device-mqtt-ingest.service';
import { MqttEvidenceCaptureService } from '../devices/mqtt/mqtt-evidence-capture.service';
import type { DeviceProxyRequest } from './portal-device-proxy.service';
import { assertPortalAdministrator } from './portal-authorization';

/** Administrative MQTT evidence and diagnostics, never device enrollment. */
@ApiExcludeController()
@Controller('portal')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalMqttDiagnosticsController {
  constructor(
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly mqttIngest: DeviceMqttIngestService,
    private readonly mqttEvidence: MqttEvidenceCaptureService,
  ) {}

  @Get('mqtt/evidence/:deviceId/status')
  async getKitchenMqttEvidenceStatus(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return this.mqttEvidence.getCaptureStatus(
      { tenantId: tenant.id, siteId: site.id },
      deviceId,
    )
  }
  @Get('bus/mqtt')
  getMqttBus(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request)
    return this.mqttIngest.getDebugState()
  }

  @Sse('bus/mqtt/events')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('X-Accel-Buffering', 'no')
  streamMqttBus(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request)
    return this.mqttIngest.streamDebugMessages().pipe(
      map((message) => ({
        type: 'mqtt_message',
        data: message,
      })),
    )
  }

  @Post('bus/mqtt/publish')
  publishMqtt(
    @Body() body: { topic?: string; payload?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    return this.mqttIngest.publishDebugMessage(body?.topic, body?.payload)
  }
}
