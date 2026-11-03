import type { DeviceControlState } from '@energrid/domain-devices';

export interface ControlSetupDevice {
  id: string;
  tenantId?: string;
  siteId?: string;
  trustStatus: string;
  capabilities: Array<{ actions: string[] }>;
  adapter: { protocol: string; driver: string; target?: string };
  metadata?: Record<string, string | number | boolean>;
  control?: DeviceControlState;
  memberDeviceIds?: string[];
}

export function canSwitchDevice(
  device: ControlSetupDevice,
  httpIdentityVerified = false,
): boolean {
  const binding = device.control?.binding;
  if (binding?.kind === 'shelly-http' && !httpIdentityVerified &&
      !hasSiteLocalShellyCommandPreflight(device)) return false;
  return (
    device.trustStatus === 'approved' &&
    device.control?.status === 'ready' &&
    device.capabilities.some(
      (c) => c.actions.includes('turn_on') && c.actions.includes('turn_off'),
    )
  );
}

/**
 * A site-local Shelly command performs fresh identity/component/status checks
 * on the authorized observer before it sends Switch.Set. Requiring a separate
 * one-minute browser-side verification would add a fragile manual step without
 * strengthening that server-side preflight.
 */
export function hasSiteLocalShellyCommandPreflight(device: ControlSetupDevice): boolean {
  const metadata = device.metadata;
  const binding = device.control?.binding;
  return binding?.kind === 'shelly-http' &&
    device.adapter.driver.includes('shelly') &&
    metadata?.identityEvidenceSource === 'verified_site_local_shelly_rpc' &&
    metadata?.componentEvidenceSource === 'verified_site_local_shelly_rpc' &&
    typeof metadata.siteLocalObserverId === 'string' && metadata.siteLocalObserverId.length > 0 &&
    typeof metadata.networkScope === 'string' && metadata.networkScope.length > 0 &&
    typeof metadata.physicalId === 'string' && metadata.physicalId.toLowerCase() === binding.physicalId.toLowerCase() &&
    metadata.component === `switch:${binding.channel}` &&
    device.id === `${binding.physicalId}:${metadata.component}`;
}

export function controlRouteLabel(device: ControlSetupDevice): string {
  const binding = device.control?.binding;
  if (!binding && device.adapter.driver.includes('shelly'))
    return 'Execution is resolved from the authorized network scope after permission is enabled';
  if (binding?.kind === 'shelly-switch')
    return 'Resolved automatically from the authorized network scope';
  if (binding?.kind === 'shelly-mqtt') return 'Existing authorized MQTT route';
  if (binding?.kind === 'shelly-http' && device.metadata?.identityEvidenceSource === 'verified_site_local_shelly_rpc' &&
      typeof device.metadata?.siteLocalObserverId === 'string' && hasSiteLocalShellyCommandPreflight(device))
    return 'Site-local RPC route · identity and component checked before each command';
  if (binding?.kind === 'shelly-http') return 'Configured local RPC route · current endpoint verification required';
  if (binding?.kind === 'shelly-virtual-lab') return 'Configured remote RPC route · current scope verification required';
  if (binding?.kind === 'generic-mqtt') return `MQTT · ${binding.topic}`;
  if (device.memberDeviceIds?.length) return 'Member control routes';
  if (device.adapter.protocol === 'simulated') return 'Simulation';
  return device.control?.reason || 'Control not configured';
}
