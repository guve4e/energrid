import type { DeviceControlState } from '@energrid/domain-devices';

export interface ControlSetupDevice {
  id: string;
  trustStatus: string;
  capabilities: Array<{ actions: string[] }>;
  adapter: { protocol: string; driver: string; target?: string };
  metadata?: Record<string, string | number | boolean>;
  control?: DeviceControlState;
  memberDeviceIds?: string[];
}

export function canSwitchDevice(device: ControlSetupDevice): boolean {
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
  if (binding?.kind === 'shelly-mqtt')
    return `MQTT · relay ${binding.channel} · ${binding.topic}`;
  if (binding?.kind === 'shelly-http')
    return `HTTP · relay ${binding.channel} · ${binding.baseUrl}`;
  if (binding?.kind === 'generic-mqtt') return `MQTT · ${binding.topic}`;
  if (device.memberDeviceIds?.length) return 'Member control routes';
  if (device.adapter.protocol === 'simulated') return 'Simulation';
  return device.control?.reason || 'Control not configured';
}
