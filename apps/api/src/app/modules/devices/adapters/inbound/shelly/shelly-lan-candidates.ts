import { privateShellyBaseUrl } from '@energrid/domain-devices';
import type { NetworkDiscoveredDevice } from '../../../device-registry.types';
import type { DiscoveredDeviceConfig } from '../../../device-registry.service';

export function shellyLanCandidates(
  device: NetworkDiscoveredDevice,
): DiscoveredDeviceConfig[] {
  if (
    device.vendor !== 'Shelly' ||
    device.status !== 'online' ||
    !device.generation ||
    device.generation < 2 ||
    !/^shelly[a-z0-9._-]{1,114}$/i.test(device.id)
  )
    return [];
  let baseUrl: string;
  try {
    baseUrl = privateShellyBaseUrl(`http://${device.ipAddress}`);
  } catch {
    return [];
  }
  const candidates = new Map<string, DiscoveredDeviceConfig>();
  for (const { component, channel } of device.components || []) {
    if (
      !Number.isInteger(channel) ||
      channel < 0 ||
      channel > 31 ||
      !['switch', 'em1'].some((kind) => component === `${kind}:${channel}`)
    )
      continue;
    const relay = component.startsWith('switch:');
    const id = `${device.id}:${component}`;
    candidates.set(id, {
      id,
      displayName: `${device.id} ${component}`,
      protocol: 'http',
      transport: 'http',
      driver: 'shelly-lan',
      source: 'http',
      target: `${baseUrl}/rpc/${relay ? 'Switch' : 'EM1'}.GetStatus?id=${channel}`,
      capabilities: [relay ? 'switch' : 'power'],
      confidence: 0.9,
      reason: 'Shelly identity and channel reported by the local HTTP API.',
      metadata: {
        physicalId: device.id,
        component,
        channel,
        httpBaseUrl: baseUrl,
      },
    });
  }
  return [...candidates.values()];
}
