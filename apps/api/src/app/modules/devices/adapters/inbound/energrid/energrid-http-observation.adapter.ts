import type { NetworkDiscoveryZone, NetworkDiscoveredDevice, RegisteredDevice } from '../../../device-registry.types';
import type { KnownNetworkDevice } from '../../../device-discovery-memory.store';

export const ENERGRID_HTTP_OBSERVATION_SOURCE = 'energrid-http-status';
export const ENERGRID_HTTP_STATUS_SELECTOR = '/api/v1/status';
/** Shared firmware sample cursor used by HTTP and the isolated Lab MQTT path. */
export const ENERGRID_SAMPLE_CURSOR_SOURCE = 'energrid-esp8266-sample';

export interface EnergridHttpSample {
  values: { temperatureC: number; humidityPct: number };
  counters: { uptimeMs: number; sampleCount: number; lastSampleUptimeMs: number };
  sampleId?: string;
}

/** Stable firmware sample identity shared by all approved transports. */
export function energridFirmwareSampleEvidenceId(deviceId: string, sampleId: string): string | null {
  if (!/^esp8266:[0-9a-f]{6}$/i.test(deviceId) || !/^[0-9a-f]{32}:\d+:\d+$/.test(sampleId)) return null;
  return `energrid-device-sample:${deviceId.toLowerCase()}:${sampleId}`;
}

export interface EnergridHttpEndpoint {
  identityUrl: string;
  statusUrl: string;
  record: KnownNetworkDevice;
  identityFresh: boolean;
  renewalDue: boolean;
}

/** Resolve the current endpoint only from fresh, scope-matched discovery evidence. */
export function resolveEnergridHttpEndpoint(
  device: RegisteredDevice,
  records: readonly KnownNetworkDevice[],
  zones: readonly NetworkDiscoveryZone[],
  now = Date.now(),
  freshnessMs = 10 * 60_000,
  renewalLeadMs = 60_000,
): EnergridHttpEndpoint | null {
  if (device.adapter.driver !== 'energrid-esp8266' || device.adapter.protocol !== 'http') return null;
  const physicalId = String(device.metadata?.physicalId || '').toLowerCase();
  const networkScope = String(device.metadata?.networkScope || '');
  const zone = zones.find(item => item.id === networkScope);
  const configuredTarget = device.adapter.target;
  if (!/^esp8266:[0-9a-f]{6}$/.test(physicalId) || !networkScope || !zone || !configuredTarget ||
    device.id !== `device:${networkScope}:${physicalId}`) return null;

  const record = records.find(item => {
    const observed = item.device.observations || [];
    const identityAt = new Set(observed.filter(e => e.source === 'http_identity' &&
      e.attribute === 'identity.device_id' && e.value === physicalId &&
      e.scopeId === networkScope && e.method === 'GET /api/v1/identity').map(e => e.observedAt));
    const verifiedAt = observed.filter(e => e.source === 'http_identity' &&
      e.attribute === 'identity.verified' && e.value === true &&
      e.scopeId === networkScope && e.method === 'GET /api/v1/identity' && identityAt.has(e.observedAt));
    const verified = verifiedAt.some(e => {
      const observedAt = Date.parse(e.observedAt);
      return Number.isFinite(observedAt) && observedAt <= now + 30_000;
    });
    return item.identity === `device:${networkScope}:${physicalId}` &&
      item.device.id.toLowerCase() === physicalId && item.device.networkZoneId === networkScope &&
      item.device.protocol === 'http' && !item.device.identityConflict && verified;
  });
  if (!record || !isIPv4(record.device.ipAddress) || !addressBelongsToZone(record.device.ipAddress, zone)) return null;

  let configured: URL;
  try { configured = new URL(configuredTarget); } catch { return null; }
  if (configured.protocol !== 'http:' || configured.username || configured.password) return null;
  const authority = `${record.device.ipAddress}${configured.port ? `:${configured.port}` : ''}`;
  const identityTimes = new Set((record.device.observations || []).filter(e =>
    e.source === 'http_identity' && e.attribute === 'identity.device_id' &&
    e.value === physicalId && e.scopeId === networkScope &&
    e.method === 'GET /api/v1/identity').map(e => e.observedAt));
  const verifiedTimes = (record.device.observations || []).filter(e =>
    e.source === 'http_identity' && e.attribute === 'identity.verified' &&
    e.value === true && e.scopeId === networkScope &&
    e.method === 'GET /api/v1/identity' && identityTimes.has(e.observedAt))
    .map(e => Date.parse(e.observedAt))
    .filter(Number.isFinite);
  const latestVerifiedAt = verifiedTimes.length ? Math.max(...verifiedTimes) : Number.NaN;
  const evidenceAgeMs = now - latestVerifiedAt;
  const identityFresh = Number.isFinite(latestVerifiedAt) && evidenceAgeMs <= freshnessMs;
  return {
    identityUrl: `http://${authority}/api/v1/identity`,
    statusUrl: `http://${authority}${ENERGRID_HTTP_STATUS_SELECTOR}`,
    record,
    identityFresh,
    renewalDue: !identityFresh || evidenceAgeMs >= freshnessMs - renewalLeadMs,
  };
}

/**
 * Revalidate the endpoint already bound to an enrolled installation when no
 * scoped Discovery Memory record is available. This is only a bounded
 * candidate: the caller must GET /api/v1/identity and match the exact physical
 * ID before recording evidence or requesting status.
 */
export function resolveEnrolledEnergridHttpEndpoint(
  device: RegisteredDevice,
  zones: readonly NetworkDiscoveryZone[],
): EnergridHttpEndpoint | null {
  if (device.adapter.driver !== 'energrid-esp8266' || device.adapter.protocol !== 'http') return null;
  const physicalId = String(device.metadata?.physicalId || '').toLowerCase();
  const networkScope = String(device.metadata?.networkScope || '');
  const zone = zones.find(item => item.id === networkScope);
  if (!/^esp8266:[0-9a-f]{6}$/.test(physicalId) || !networkScope || !zone ||
      device.id !== `device:${networkScope}:${physicalId}` || !device.tenantId || !device.siteId ||
      !device.adapter.target) return null;

  let configured: URL;
  try { configured = new URL(device.adapter.target); } catch { return null; }
  if (configured.protocol !== 'http:' || configured.username || configured.password ||
      configured.pathname !== ENERGRID_HTTP_STATUS_SELECTOR || configured.search || configured.hash ||
      !isIPv4(configured.hostname) || !addressBelongsToZone(configured.hostname, zone)) return null;

  const observedAt = new Date().toISOString();
  const ipAddress = configured.hostname;
  const record: KnownNetworkDevice = {
    schemaVersion: 2,
    ownership: { tenantId: device.tenantId, siteId: device.siteId },
    identity: `device:${networkScope}:${physicalId}`,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    lastScanId: `enrolled-endpoint:${device.id}`,
    device: {
      id: physicalId,
      ipAddress,
      networkZoneId: networkScope,
      networkZoneName: zone.name,
      protocol: 'http',
      confidence: 0,
      status: 'unknown',
      discoveredAt: observedAt,
      reason: 'Last-known enrolled endpoint; awaiting fresh protocol identity verification.',
      observations: [],
    },
  };
  const authority = `${ipAddress}${configured.port ? `:${configured.port}` : ''}`;
  return {
    identityUrl: `http://${authority}/api/v1/identity`,
    statusUrl: `http://${authority}${ENERGRID_HTTP_STATUS_SELECTOR}`,
    record,
    identityFresh: false,
    renewalDue: true,
  };
}

function addressBelongsToZone(ipAddress: string, zone: NetworkDiscoveryZone): boolean {
  if (!isIPv4(ipAddress)) return false;
  if (zone.seedIps.includes(ipAddress)) return true;
  if (!zone.cidr) return false;
  const [network, prefixText] = zone.cidr.split('/');
  const prefix = Number(prefixText);
  const ip = ipv4Number(ipAddress);
  const base = ipv4Number(network);
  if (ip === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if ((ip & mask) !== (base & mask)) return false;
  if (prefix >= 31) return true;
  const host = ip & ~mask;
  const maxHost = 2 ** (32 - prefix) - 1;
  return host !== 0 && host !== maxHost;
}

function ipv4Number(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => (result * 256) + Number(part), 0) >>> 0;
}

/** Parse only the firmware 0.2 status schema; no arbitrary payload keys enter observation decoding. */
export function parseEnergridHttpSample(
  payload: unknown,
  expectedPhysicalId: string,
): { accepted: true; sample: EnergridHttpSample } | { accepted: false; reason: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { accepted: false, reason: 'invalid_status_payload' };
  const root = payload as Record<string, unknown>;
  if (root.schemaVersion !== 1 || typeof root.deviceId !== 'string' ||
    root.deviceId.toLowerCase() !== expectedPhysicalId.toLowerCase()) {
    return { accepted: false, reason: 'status_identity_mismatch' };
  }
  const sensor = root.sensor;
  if (!sensor || typeof sensor !== 'object' || Array.isArray(sensor)) return { accepted: false, reason: 'invalid_sensor_status' };
  const data = sensor as Record<string, unknown>;
  const counters = [root.uptimeMs, data.sampleCount, data.lastSampleUptimeMs, data.readingAgeMs, root.sampleIntervalMs];
  if (counters.some(value => !Number.isSafeInteger(value) || Number(value) < 0) ||
    Number(data.sampleCount) < 1 || Number(root.sampleIntervalMs) < 1) {
    return { accepted: false, reason: 'invalid_sample_counters' };
  }
  if (data.state !== 'ok') return { accepted: false, reason: 'sensor_not_ok' };
  if (root.sampleId !== undefined && (typeof root.sampleId !== 'string' || !energridFirmwareSampleEvidenceId(expectedPhysicalId, root.sampleId) ||
      root.sampleId.split(':')[1] !== String(data.sampleCount) || root.sampleId.split(':')[2] !== String(data.lastSampleUptimeMs))) {
    return { accepted: false, reason: 'invalid_sample_identity' };
  }
  const temperatureC = data.temperatureC;
  const humidityPct = data.humidityPct;
  if (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC) || temperatureC < -40 || temperatureC > 80 ||
    typeof humidityPct !== 'number' || !Number.isFinite(humidityPct) || humidityPct < 0 || humidityPct > 100) {
    return { accepted: false, reason: 'invalid_sensor_values' };
  }
  const maxAgeMs = Math.min(15_000, Math.max(5_000, Number(root.sampleIntervalMs) * 3));
  if (Number(data.readingAgeMs) > maxAgeMs) return { accepted: false, reason: 'stale_sensor_sample' };
  return {
    accepted: true,
    sample: {
      values: { temperatureC, humidityPct },
      counters: {
        uptimeMs: Number(root.uptimeMs),
        sampleCount: Number(data.sampleCount),
        lastSampleUptimeMs: Number(data.lastSampleUptimeMs),
      },
      ...(typeof root.sampleId === 'string' ? { sampleId: root.sampleId } : {}),
    },
  };
}

function isIPv4(value: string): boolean {
  return ipv4Number(value) !== null;
}
