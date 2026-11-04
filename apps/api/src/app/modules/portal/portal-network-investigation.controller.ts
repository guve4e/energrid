import {
  Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard';
import { DeviceAiInvestigationService } from '../llm/device-ai-investigation.service';
import { DeviceInvestigationWorkflowService } from '../llm/device-investigation-workflow.service';
import type { DeviceInvestigationScope } from '../llm/device-investigation-history.store';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service';
import { DeviceDiscoveryMemoryStore } from '../devices/device-discovery-memory.store';
import { energridDiscoveryCandidate } from '../devices/adapters/inbound/energrid/energrid-discovery-candidate';
import type { DeviceProxyRequest } from './portal-device-proxy.service';
import { assertPortalAdministrator } from './portal-authorization';

/** Existing passive investigation/history and explicitly approved proposed-action HTTP boundary. */
@ApiExcludeController()
@Controller('portal')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalNetworkInvestigationController {
  constructor(
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly lanDiscovery: DeviceLanDiscoveryService,
    private readonly discoveryMemory: DeviceDiscoveryMemoryStore,
    private readonly deviceAi: DeviceAiInvestigationService,
    private readonly investigationWorkflow: DeviceInvestigationWorkflowService,
  ) {}

  @Post('network/:deviceId/investigate')
  async investigateNetworkDeviceWithAi(
    @Param('deviceId') deviceId: string,
    @Body() body: { cloudDataConsent?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)

    const device = await this.resolveInvestigationTarget(deviceId)
    if (energridDiscoveryCandidate(device)) {
      throw new ConflictException('Recognized Energrid devices use first-party identity and enrollment; LLM investigation is disabled.')
    }
    const scope = this.investigationScope(device)
    return this.deviceAi.investigate(
      scope,
      deviceId,
      [device],
      body?.cloudDataConsent === true,
    )
  }

  @Post('network/:deviceId/investigations/:investigationId/actions/:proposalId/execute')
  async executeInvestigationAction(
    @Param('deviceId') deviceId: string,
    @Param('investigationId') investigationId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: { approved?: unknown; cloudDataConsent?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    const target = await this.resolveInvestigationTarget(deviceId)
    if (energridDiscoveryCandidate(target)) {
      throw new ConflictException('Recognized Energrid devices do not accept LLM-proposed actions.')
    }
    const scope = this.investigationScope(target)
    return this.investigationWorkflow.executeProposedAction({
      scope,
      deviceId,
      investigationId,
      proposalId,
      target,
      zones: this.lanDiscovery.getZones(),
      approved: body?.approved === true,
      cloudDataConsent: body?.cloudDataConsent === true,
    })
  }

  @Post('network/:deviceId/profile-investigations')
  async investigateNetworkMqttProfile(
    @Param('deviceId') deviceId: string,
    @Body() body: { cloudDataConsent?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return this.deviceAi.investigateStoredMqttProfile(
      { tenantId: tenant.id, siteId: site.id },
      deviceId,
      body?.cloudDataConsent === true,
    )
  }

  @Get('network/:deviceId/profile-investigations')
  async listNetworkMqttProfiles(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return this.deviceAi.listMqttProfileInvestigations(
      { tenantId: tenant.id, siteId: site.id },
      deviceId,
      50,
    )
  }

  @Get('investigations/availability')
  getInvestigationAvailability(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request)
    return this.deviceAi.getProviderAvailability()
  }

  @Get('network/:deviceId/profile-investigations/:investigationId')
  async getNetworkMqttProfile(
    @Param('deviceId') deviceId: string,
    @Param('investigationId') investigationId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return this.deviceAi.getMqttProfileInvestigation(
      { tenantId: tenant.id, siteId: site.id },
      deviceId,
      investigationId,
    )
  }

  @Get('network/:deviceId/investigations')
  async listNetworkDeviceInvestigations(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    const device = await this.resolveInvestigationTarget(deviceId)
    return this.deviceAi.listHistory(this.investigationScope(device), deviceId, 50)
  }

  @Get('network/:deviceId/investigations/:investigationId')
  async getNetworkDeviceInvestigation(
    @Param('deviceId') deviceId: string,
    @Param('investigationId') investigationId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    const device = await this.resolveInvestigationTarget(deviceId)
    return this.deviceAi.getHistoryRecord(this.investigationScope(device), deviceId, investigationId)
  }

  private async resolveInvestigationTarget(deviceId: string) {
    const live = this.lanDiscovery.getLastScan().find(device => device.id === deviceId)
    if (live) return live
    const remembered = (await this.discoveryMemory.list(this.discoveryOwner().ownership))
      .find(record => record.device.id === deviceId)
    if (remembered) return remembered.device
    throw new NotFoundException('Discovered device not found in this site')
  }

  private investigationScope(device: {
    id: string
    networkZoneId: string
    gatewayId?: string
  }): DeviceInvestigationScope {
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    return {
      tenantId: tenant.id,
      siteId: site.id,
      networkId: `${device.gatewayId || 'gateway-unknown'}:${device.networkZoneId}`,
    }
  }

  private discoveryOwner() {
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    return { ownership: { tenantId: tenant.id, siteId: site.id } }
  }
}
