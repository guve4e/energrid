import type { DiscoveryMemoryResponse, DiscoveryNetworkZone, NetworkDevice } from './discovery-contracts';

/** A persistent identity or endpoint reference is not proof of live reachability. */
export function networkDiscoveryIdentity(device: NetworkDevice): string {
  const mac = device.macAddress?.trim().toLowerCase();
  if (mac && mac !== 'ff:ff:ff:ff:ff:ff') return `mac:${mac}`;
  if (device.vendor === 'Shelly' && device.id.toLowerCase().startsWith('shelly')) {
    return `shelly:${device.id.toLowerCase()}`;
  }
  return `endpoint:${device.networkZoneId}:${device.ipAddress}`;
}

export function mergeCurrentAndRememberedDevices(
  live: NetworkDevice[],
  memory: DiscoveryMemoryResponse | null,
): NetworkDevice[] {
  const liveIdentities = new Set(live.map(networkDiscoveryIdentity));
  const liveEndpoints = new Set(live.map(device => `${device.networkZoneId}:${device.ipAddress}`));

  const historical = (memory?.devices || [])
    .filter(record =>
      !liveIdentities.has(record.identity) &&
      !liveEndpoints.has(`${record.device.networkZoneId}:${record.device.ipAddress}`),
    )
    .map(record => ({ ...record.device, status: 'unknown' as NetworkDevice['status'] }));

  return [...live, ...historical];
}

export function isEnergridCapableNetworkDevice(device: NetworkDevice): boolean {
  return [device.vendor, device.model, device.app]
    .some(value => (value || '').toLowerCase().includes('shelly'));
}

export type NetworkView = 'all' | 'capable';

export function filterNetworkDevices(
  devices: NetworkDevice[],
  view: NetworkView,
  query: string,
): NetworkDevice[] {
  const term = query.trim().toLowerCase();
  const base = term || view === 'all' ? devices : devices.filter(isEnergridCapableNetworkDevice);
  if (!term) return base;

  return base.filter(device => [
    device.id, device.ipAddress, device.hostname, device.macAddress,
    device.vendor, device.model, device.protocol, device.app,
    device.reason, device.networkZoneName,
  ].filter(Boolean).some(value => String(value).toLowerCase().includes(term)));
}

export function networkInventoryStats(
  devices: NetworkDevice[],
  live: NetworkDevice[],
  memory: DiscoveryMemoryResponse | null,
  zones: DiscoveryNetworkZone[],
) {
  const currentResponses = live.filter(device => device.status === 'online').length;
  const vendors = new Set(devices.map(device => device.vendor || 'Unknown'));
  const shelly = devices.filter(device => device.vendor?.toLowerCase() === 'shelly').length;
  const capable = devices.filter(isEnergridCapableNetworkDevice).length;

  return [
    { label: 'Online in last API scan', value: String(currentResponses), detail: 'from process-local scan results' },
    { label: 'Remembered endpoints', value: String(memory?.summary.known ?? 0), detail: 'retained in Discovery Memory' },
    { label: 'Energrid capable', value: String(capable), detail: `${devices.length ? Math.round(capable / devices.length * 100) : 0}% of current and remembered endpoints` },
    { label: 'Shelly devices', value: String(shelly), detail: `${currentResponses} online in the last API scan` },
    { label: 'Zones', value: String(zones.length), detail: zones.map(zone => zone.cidr || zone.name).join(', ') || 'none' },
    { label: 'Vendors', value: String(vendors.size), detail: [...vendors].slice(0, 3).join(', ') },
  ];
}
