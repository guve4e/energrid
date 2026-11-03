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
  if (binding?.kind === 'shelly-http' && !httpIdentityVerified) return false;
  return (
    device.trustStatus === 'approved' &&
    device.control?.status === 'ready' &&
    device.capabilities.some(
      (c) => c.actions.includes('turn_on') && c.actions.includes('turn_off'),
    )
  );
}

export function controlRouteLabel(device: ControlSetupDevice): string {
  const binding = device.control?.binding;
  if (!binding && device.adapter.driver.includes('shelly'))
    return 'Execution is resolved from the authorized network scope after permission is enabled';
  if (binding?.kind === 'shelly-switch')
    return 'Resolved automatically from the authorized network scope';
  if (binding?.kind === 'shelly-mqtt') return 'Existing authorized MQTT route';
  if (binding?.kind === 'shelly-http' && device.metadata?.identityEvidenceSource === 'verified_site_local_shelly_rpc' &&
      typeof device.metadata?.siteLocalObserverId === 'string')
    return 'Site-local RPC route · verify through the authorized observer before control';
  if (binding?.kind === 'shelly-http') return 'Configured local RPC route · current endpoint verification required';
  if (binding?.kind === 'shelly-virtual-lab') return 'Configured remote RPC route · current scope verification required';
  if (binding?.kind === 'generic-mqtt') return `MQTT · ${binding.topic}`;
  if (device.memberDeviceIds?.length) return 'Member control routes';
  if (device.adapter.protocol === 'simulated') return 'Simulation';
  return device.control?.reason || 'Control not configured';
}
