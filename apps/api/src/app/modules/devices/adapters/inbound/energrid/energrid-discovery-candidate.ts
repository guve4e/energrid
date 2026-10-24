import type { NetworkDiscoveredDevice } from '../../../device-registry.types';
import type { DiscoveredDeviceConfig } from '../../../device-registry.service';

const idPattern = /^esp8266:[0-9a-f]{6}$/i;

/** Convert verified discovery-memory evidence into the registry's pending-candidate port. */
export function energridDiscoveryCandidate(
  device: NetworkDiscoveredDevice,
): DiscoveredDeviceConfig | null {
  const verified = device.observations?.some(item =>
    item.source === 'http_identity' && item.attribute === 'identity.verified' && item.value === true,
  );
  const firmwareId = device.observations?.find(item =>
    item.source === 'http_identity' && item.attribute === 'identity.device_id',
  )?.value;
  if (!verified || typeof firmwareId !== 'string' || firmwareId !== device.id || !idPattern.test(firmwareId)) return null;
  if (device.identityConflict) return null;

  const networkScope = device.networkZoneId.trim();
  if (!networkScope || !device.ipAddress) return null;
  const observedAt = device.observations?.find(item =>
    item.source === 'http_identity' && item.attribute === 'identity.device_id',
  )?.observedAt || device.discoveredAt;
  const model = device.observations?.find(item =>
    item.source === 'http_identity' && item.attribute === 'device.model',
  )?.value;
  const firmwareVersion = device.observations?.find(item =>
    item.source === 'http_identity' && item.attribute === 'firmware.version',
  )?.value;
  const capabilities = device.observations?.filter(item =>
    item.source === 'http_identity' && item.attribute === 'device.capability',
  ).map(item => item.value).filter((value): value is string => value === 'temperature' || value === 'humidity') ?? [];

  return {
    id: `device:${networkScope}:${firmwareId.toLowerCase()}`,
    displayName: typeof model === 'string' ? model : 'Energrid ESP8266 sensor',
    suggestedName: typeof model === 'string' ? model : 'Energrid ESP8266 sensor',
    protocol: 'http',
    transport: 'http',
    driver: 'energrid-esp8266',
    target: `http://${device.ipAddress}/api/v1/status`,
    capabilities: [...new Set(capabilities)] as ('temperature' | 'humidity')[],
    source: 'http',
    confidence: 1,
    reason: 'Stable firmware identity verified by bounded GET /api/v1/identity. Measurements remain unauthorized until separately approved.',
    metadata: {
      physicalId: firmwareId.toLowerCase(),
      ipAddress: device.ipAddress,
      networkScope,
      networkObservedAt: observedAt,
      firmwareVersion: typeof firmwareVersion === 'string' ? firmwareVersion : '',
      observationApprovalRequired: true,
      identityEvidenceSource: 'bounded GET /api/v1/identity',
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
      ...(device.hostname ? { hostname: device.hostname } : {}),
      ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
    },
  };
}
