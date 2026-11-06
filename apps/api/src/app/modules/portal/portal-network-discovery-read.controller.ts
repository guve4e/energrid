import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { DeviceDiscoveryMemoryStore, type DiscoveryOwnership } from '../devices/device-discovery-memory.store';
import { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service';
import { compareNetworkSnapshots } from '../devices/network-discovery-snapshot';
import { lookupMacVendor } from '../devices/mac-vendor-lookup';
import { projectNetworkRoles } from '../devices/network-role-evidence';
import { configuredSiteLocalObservers, type AuthorizedSiteLocalObserver } from '../devices/site-local-shelly-evidence-intake';
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from '../devices/enrollment/device-enrollment.module';
import type { PhysicalDeviceInventoryService } from '../devices/enrollment/physical-device-inventory.service';
import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository';
import { projectShellyEndpointRecoveryProposals } from './shelly-endpoint-recovery-projection';
import type { DeviceProxyRequest } from './portal-device-proxy.service';
import { assertPortalAdministrator } from './portal-authorization';

/** Read-only, active-site network discovery snapshots and memory. Scanning and approvals stay elsewhere. */
@ApiExcludeController()
@Controller('portal')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalNetworkDiscoveryReadController {
  constructor(
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly discoveryMemory: DeviceDiscoveryMemoryStore,
    private readonly lanDiscovery: DeviceLanDiscoveryService,
    @Optional()
    @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
  ) {}

  private discoveryOwner(): DiscoveryOwnership {
    const { tenant, site } = this.deviceRegistry.getSnapshot();
    return { tenantId: tenant.id, siteId: site.id };
  }

  @Get('network/snapshots')
  async listNetworkSnapshots(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request)
    const ownership = this.discoveryOwner()
    const snapshots = await this.discoveryMemory.listHistoricalSnapshots(ownership, 50)
    const devices = this.deviceRegistry.getDevices(true)
    let inventories: PhysicalDeviceInventoryRecord[] = []
    let inventoryAvailable = !!this.physicalInventory
    try { inventories = await this.physicalInventory?.list(ownership) || [] } catch { inventoryAvailable = false }
    let observers: AuthorizedSiteLocalObserver[] | null = []
    try { observers = configuredSiteLocalObservers() } catch { observers = null }
    return { snapshots: snapshots.map(snapshot => ({
      ...snapshot,
      endpointRecoveryProposals: projectShellyEndpointRecoveryProposals({
        snapshot, owner: ownership, devices, inventories, inventoryAvailable, observers,
      }),
      networkRoles: projectNetworkRoles(snapshot),
      endpoints: snapshot.endpoints.map(endpoint => {
        const vendor = lookupMacVendor(endpoint.macAddress)
        return vendor.status === 'matched'
          ? { ...endpoint, macVendorClue: vendor }
          : endpoint
      }),
    })) }
  }

  @Get('network/capabilities')
  async networkCapabilities(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request)
    const runtime = await this.lanDiscovery.getRuntimeCapabilities()
    return { ...runtime, instance: instanceAuthorityDiagnostics() }
  }

  @Get('network/snapshots/:fromScanId/compare/:toScanId')
  async compareNetworkSnapshotRoute(
    @Param('fromScanId') fromScanId: string,
    @Param('toScanId') toScanId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    const ownership = this.discoveryOwner()
    const [previous, current] = await Promise.all([
      this.discoveryMemory.getSnapshot(fromScanId, ownership),
      this.discoveryMemory.getSnapshot(toScanId, ownership),
    ])
    if (!previous || !current) throw new NotFoundException('Network discovery snapshot was not found')
    return compareNetworkSnapshots(previous, current)
  }

  @Get('network/memory')
  async getNetworkDiscoveryMemory(@Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request)

    const ownership = this.discoveryOwner()
    const [devices, summary] = await Promise.all([
      this.discoveryMemory.list(ownership),
      this.discoveryMemory.summary(ownership),
    ])

    return { summary, devices }
  }

  @Get('network/memory/summary')
  async getNetworkDiscoveryMemorySummary(
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    return this.discoveryMemory.summary(this.discoveryOwner())
  }
}

function instanceAuthorityDiagnostics() {
  const allowedModes = ['development-isolated', 'site-authority', 'observer'] as const
  const configuredMode = process.env.ENERGRID_INSTANCE_MODE?.trim()
  const mode = configuredMode && (allowedModes as readonly string[]).includes(configuredMode)
    ? configuredMode as typeof allowedModes[number]
    : configuredMode
      ? 'invalid-configuration'
      : process.env.NODE_ENV === 'production' ? 'unconfigured-production' : 'development-isolated'
  const configuredId = process.env.ENERGRID_INSTANCE_ID?.trim() || ''
  const instanceId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(configuredId) ? configuredId : null
  return {
    instanceId,
    mode,
    configured: !!instanceId && mode !== 'invalid-configuration' && mode !== 'unconfigured-production',
    authorityModeIsConfigured: !!configuredMode && mode === 'site-authority',
    note: 'This diagnostic describes local configuration only; it does not enforce uniqueness or transfer authority between instances.',
  }
}
