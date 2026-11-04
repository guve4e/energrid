import {
  Body,
  ConflictException,
  Controller,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard'
import { DeviceDiscoveryMemoryStore } from '../devices/device-discovery-memory.store'
import { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service'
import { DeviceRegistryService } from '../devices/device-registry.service'
import { energridDiscoveryCandidate } from '../devices/adapters/inbound/energrid/energrid-discovery-candidate'
import { NetworkEndpointInvestigatorService } from '../llm/network-endpoint-investigator.service'
import { ReadOnlyHttpIdentityProbe } from '../llm/read-only-http-identity-probe'
import { NetworkEndpointIdentityRefresh } from '../llm/network-endpoint-identity-refresh'
import { assertPortalAdministrator } from './portal-authorization'
import { sameDiscoveryOwner } from './portal-discovery-candidate'
import type { DeviceProxyRequest } from './portal-device-proxy.service'

/**
 * Snapshot-bound investigation and explicitly approved, bounded read-only probing.
 * A request can only target an endpoint recorded in the active tenant/site snapshot.
 * Probe authorization and fresh-identity verification remain delegated to the
 * existing deterministic outbound adapters.
 */
@ApiExcludeController()
@Controller('portal')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalSnapshotEndpointInvestigationController {
  constructor(
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly discoveryMemory: DeviceDiscoveryMemoryStore,
    private readonly lanDiscovery: DeviceLanDiscoveryService,
    @Optional() private readonly networkEndpointInvestigator?: NetworkEndpointInvestigatorService,
    @Optional() private readonly networkEndpointProbe?: ReadOnlyHttpIdentityProbe,
    @Optional() private readonly networkEndpointIdentityRefresh?: NetworkEndpointIdentityRefresh,
  ) {}

  private discoveryOwner() {
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    return { ownership: { tenantId: tenant.id, siteId: site.id }, siteName: site.name }
  }

  private async resolveSnapshotEndpoint(scanId: string, scopeId: string, ipAddress: string, endpointId: string) {
    const ownership = this.discoveryOwner().ownership
    const snapshot = await this.discoveryMemory.getSnapshot(scanId, ownership)
    // The store enforces ownership; verify again before any LLM or network operation.
    if (!snapshot?.ownership || !sameDiscoveryOwner(snapshot.ownership, ownership)) {
      throw new NotFoundException('Network discovery snapshot was not found')
    }
    const target = snapshot.endpoints.find(endpoint =>
      endpoint.networkZoneId === scopeId && endpoint.ipAddress === ipAddress && endpoint.id === endpointId,
    )
    if (!target) throw new NotFoundException('Endpoint was not found in the selected snapshot')
    return { snapshot, target, ownership }
  }

  @Post('network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/investigate')
  async investigateSnapshotEndpoint(
    @Param('scanId') scanId: string,
    @Param('scopeId') scopeId: string,
    @Param('ipAddress') ipAddress: string,
    @Param('endpointId') endpointId: string,
    @Body() body: { cloudDataConsent?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    if (!this.networkEndpointInvestigator) {
      throw new ServiceUnavailableException('Network endpoint investigation is unavailable')
    }
    const { snapshot, target, ownership } = await this.resolveSnapshotEndpoint(scanId, scopeId, ipAddress, endpointId)
    if (energridDiscoveryCandidate(target)) {
      throw new ConflictException('Recognized Energrid devices use first-party identity and enrollment; LLM investigation is disabled.')
    }
    const history = await this.discoveryMemory.listSnapshots(ownership, 50)
    return this.networkEndpointInvestigator.investigate(
      snapshot,
      { scopeId, ipAddress, endpointId },
      body?.cloudDataConsent === true,
      history.filter(item => item.scanId !== snapshot.scanId),
    )
  }

  @Post('network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/probe-http')
  async probeSnapshotEndpointHttp(
    @Param('scanId') scanId: string,
    @Param('scopeId') scopeId: string,
    @Param('ipAddress') ipAddress: string,
    @Param('endpointId') endpointId: string,
    @Body() body: { approved?: unknown; refreshId?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    if (!this.networkEndpointProbe) throw new ServiceUnavailableException('Read-only endpoint investigation is unavailable')
    const { target } = await this.resolveSnapshotEndpoint(scanId, scopeId, ipAddress, endpointId)
    if (body?.approved !== true) return this.networkEndpointProbe.run(target, this.lanDiscovery.getZones(), false)
    if (typeof body.refreshId !== 'string' || !this.networkEndpointIdentityRefresh) {
      return { outcome: 'rejected' as const, reasonCode: 'fresh_identity_verification_required' }
    }
    const refreshedTarget = this.networkEndpointIdentityRefresh.consumeVerifiedRefresh(
      body.refreshId,
      target,
      this.lanDiscovery.getZones(),
    )
    if (!refreshedTarget) {
      return { outcome: 'rejected' as const, reasonCode: 'fresh_identity_verification_required' }
    }
    return this.networkEndpointProbe.run(refreshedTarget, this.lanDiscovery.getZones(), true)
  }

  @Post('network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/refresh-identity')
  async refreshSnapshotEndpointIdentity(
    @Param('scanId') scanId: string,
    @Param('scopeId') scopeId: string,
    @Param('ipAddress') ipAddress: string,
    @Param('endpointId') endpointId: string,
    @Body() body: { approved?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    if (!this.networkEndpointIdentityRefresh) throw new ServiceUnavailableException('Targeted identity refresh is unavailable')
    const { target } = await this.resolveSnapshotEndpoint(scanId, scopeId, ipAddress, endpointId)
    return this.networkEndpointIdentityRefresh.refresh(target, this.lanDiscovery.getZones(), body?.approved === true)
  }

}
