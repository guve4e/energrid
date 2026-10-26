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
    const componentObservation = device.observations?.find(observation =>
      observation.source === 'http_rpc' &&
      observation.attribute === 'shelly.component_status' &&
      observation.value === component &&
      typeof observation.method === 'string' &&
      typeof observation.observedAt === 'string',
    );
    // The component must have been confirmed by its own read-only status RPC.
    // A component list or an MQTT claim alone is not onboarding evidence.
    if (!componentObservation) continue;
    const componentVerificationMethod = componentObservation.method;
    const componentVerifiedAt = componentObservation.observedAt;
    if (typeof componentVerificationMethod !== 'string' || typeof componentVerifiedAt !== 'string') continue;
    const verifiedPower = device.observations?.some(observation =>
      observation.source === 'http_rpc' &&
      observation.attribute === 'shelly.measurement_capability' &&
      observation.value === `${component}:power`,
    ) === true;
    candidates.set(id, {
      id,
      displayName: `${device.id} ${component}`,
      protocol: 'http',
      transport: 'http',
      driver: 'shelly-lan',
      source: 'http',
      target: `${baseUrl}/rpc/${relay ? 'Switch' : 'EM1'}.GetStatus?id=${channel}`,
      capabilities: [...(relay ? ['switch' as const] : []), ...(verifiedPower || !relay ? ['power' as const] : [])],
      confidence: 0.9,
      reason: 'Shelly identity and channel reported by the local HTTP API.',
      metadata: {
        physicalId: device.id,
        component,
        channel,
        httpBaseUrl: baseUrl,
        ipAddress: device.ipAddress,
        identityEvidenceSource: 'verified_shelly_http_rpc',
        identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo',
        identityVerifiedAt: device.discoveredAt,
        componentEvidenceSource: 'verified_shelly_component_status_rpc',
        componentVerificationMethod,
        componentVerifiedAt,
        requiresEnrollmentPlacement: true,
        shellyMqttObservationApprovalRequired: verifiedPower,
        ...(verifiedPower ? { verifiedMeasurementFields: 'power' } : {}),
        ...(device.macAddress ? { macAddress: device.macAddress } : {}),
        ...(device.deviceReportedMacAddress ? { deviceReportedMacAddress: device.deviceReportedMacAddress } : {}),
        ...(device.hostname ? { hostname: device.hostname } : {}),
        ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
        networkScope: `${device.gatewayId || 'gateway-unknown'}:${device.networkZoneId}`,
        networkObservedAt: device.discoveredAt,
      },
    });
  }
  return [...candidates.values()];
}
