import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard';
import { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { shellyLanCandidates } from '../devices/adapters/inbound/shelly/shelly-lan-candidates';
import type { DeviceProxyRequest } from './portal-device-proxy.service';
import { assertPortalAdministrator } from './portal-authorization';
import { registerOwnedDiscoveryCandidate, sameDiscoveryOwner } from './portal-discovery-candidate';

const networkScanDeadlineMs = 180_000;

type DisconnectAwareResponse = {
  writableEnded: boolean;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
};

/** Site-scoped, consent-gated network scan and read-only Shelly candidate verification. */
@ApiExcludeController()
@Controller('portal')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalNetworkDiscoveryScanController {
  constructor(
    private readonly lanDiscovery: DeviceLanDiscoveryService,
    private readonly deviceRegistry: DeviceRegistryService,
  ) {}

  private discoveryOwner() {
    const { tenant, site } = this.deviceRegistry.getSnapshot();
    return { ownership: { tenantId: tenant.id, siteId: site.id }, siteName: site.name };
  }

  @Post('network/scan')
  async scanNetwork(
    @Body() body: { scopeIds?: unknown; fullSubnetConfirmed?: unknown },
    @Req() request: DeviceProxyRequest,
    @Res({ passthrough: true }) response?: DisconnectAwareResponse,
  ) {
    assertPortalAdministrator(request)
    if (!Array.isArray(body?.scopeIds) || body.scopeIds.length === 0 ||
      body.scopeIds.some(id => typeof id !== 'string' || !id.trim()) ||
      typeof body.fullSubnetConfirmed !== 'boolean') {
      throw new BadRequestException('Choose network scopes and explicitly confirm any full-subnet scan')
    }
    const scopeIds = body.scopeIds as string[]
    const uniqueScopeIds = new Set(scopeIds)
    if (uniqueScopeIds.size !== scopeIds.length) {
      throw new BadRequestException('Selected network scopes must be unique')
    }
    const configured = this.lanDiscovery.getZones()
    const selected = configured.filter(zone => uniqueScopeIds.has(zone.id))
    if (selected.length !== uniqueScopeIds.size) {
      throw new BadRequestException('One or more selected network scopes are not configured')
    }
    if (selected.some(zone => zone.cidr && zone.collectionSource !== 'virtual-lab') && body.fullSubnetConfirmed !== true) {
      throw new BadRequestException('Full-subnet discovery requires explicit operator confirmation')
    }
    if (selected.some(zone => zone.collectionSource === 'virtual-lab') && body.fullSubnetConfirmed !== true) {
      throw new BadRequestException('Virtual Lab discovery requires explicit operator confirmation')
    }
    const controller = new AbortController()
    const abortIfDisconnected = () => {
      if (response && !response.writableEnded) controller.abort()
    }
    response?.once('close', abortIfDisconnected)
    let scan: Awaited<ReturnType<DeviceLanDiscoveryService['scanNow']>>
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        this.lanDiscovery.scanNow({
          scopeIds: body.scopeIds as string[],
          fullSubnetConfirmed: body.fullSubnetConfirmed,
          signal: controller.signal,
        }),
        new Promise<null>(resolve => {
          deadlineTimer = setTimeout(() => {
            controller.abort()
            resolve(null)
          }, networkScanDeadlineMs)
        }),
      ])
      if (!result) {
        throw new GatewayTimeoutException(
          'Network scan exceeded the 180-second execution limit. The observer may not be able to reach the selected subnet; check its network route or use an observer on that network. No conclusion about device availability was made.',
        )
      }
      // A disconnected client must not cause late discovery results to mutate
      // registry candidates even if an adapter ignores the abort signal.
      if (controller.signal.aborted) {
        throw new ServiceUnavailableException('Network scan was cancelled; no discovery candidates were registered.')
      }
      scan = result
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      response?.off('close', abortIfDisconnected)
    }
    const active = this.discoveryOwner()
    const scanOwner = scan.snapshot.ownership
    if (!scanOwner || !sameDiscoveryOwner(scanOwner, active.ownership)) {
      throw new ForbiddenException('The scan belongs to a different authorized site; no candidates were registered.')
    }
    const currentSiteDevices = this.deviceRegistry.getDevices(true).filter(device =>
      device.tenantId === scanOwner.tenantId && device.siteId === scanOwner.siteId,
    )
    for (const device of scan.devices) {
      const freshComponents = new Set((device.components || []).map(item => item.component))
      const historicalComponents = [...new Set(currentSiteDevices.flatMap(existing =>
        existing.metadata?.physicalId === device.id && typeof existing.metadata?.component === 'string' &&
        !freshComponents.has(existing.metadata.component) && /^(?:switch|em1|cover):\d+$/.test(existing.metadata.component)
          ? [existing.metadata.component] : [],
      ))].sort()
      for (const candidate of shellyLanCandidates(device)) {
        const candidateWithConflict = historicalComponents.length
          ? { ...candidate,
              reason: `${candidate.reason} Historical component evidence ${historicalComponents.join(', ')} conflicts with the fresh RPC component profile and is preserved for operator reconciliation.`,
              metadata: { ...candidate.metadata, historicalComponentConflicts: historicalComponents.join(','), requiresProfileReconciliation: true },
            }
          : candidate
        registerOwnedDiscoveryCandidate(this.deviceRegistry, candidateWithConflict, scanOwner, active.siteName)
      }
    }
    return scan
  }

  @Post('discovery/:deviceId/verify-shelly')
  async verifyShellyDiscoveryCandidate(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    const { ownership } = this.discoveryOwner()
    return this.lanDiscovery.verifyShellyCandidate(deviceId, ownership)
  }
}
