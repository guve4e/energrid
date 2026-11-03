import type { DiscoveryOwnership } from '../devices/device-discovery-memory.store';
import type { DeviceRegistryService } from '../devices/device-registry.service';

/** Keep discovery candidates site-owned; scanning never authorizes enrollment or control. */
export function registerOwnedDiscoveryCandidate(
  registry: Pick<DeviceRegistryService, 'registerDiscoveredDevice'>,
  candidate: Parameters<DeviceRegistryService['registerDiscoveredDevice']>[0],
  ownership: DiscoveryOwnership,
  siteName: string,
): boolean {
  return registry.registerDiscoveredDevice({
    ...candidate,
    tenantId: ownership.tenantId,
    siteId: ownership.siteId,
    siteName,
    metadata: {
      ...candidate.metadata,
      discoveryTenantId: ownership.tenantId,
      discoverySiteId: ownership.siteId,
    },
  });
}

export function sameDiscoveryOwner(a: DiscoveryOwnership, b: DiscoveryOwnership): boolean {
  return a.tenantId === b.tenantId && a.siteId === b.siteId;
}
