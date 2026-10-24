import { energridHttpObservationApproval } from './energrid-http-observation-approval';
import { parseEnergridHttpSample, resolveEnergridHttpEndpoint } from './energrid-http-observation.adapter';
import type { KnownNetworkDevice } from '../../../device-discovery-memory.store';
import type { NetworkDiscoveryZone, RegisteredDevice } from '../../../device-registry.types';

const device = {
  id: 'device:upstream-lan:esp8266:324864',
  tenantId: 'tenant-a', siteId: 'site-a',
  adapter: { driver: 'energrid-esp8266', protocol: 'http', target: 'http://192.168.1.198:8080/api/v1/status' },
  metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' },
} as unknown as RegisteredDevice;
const zones: NetworkDiscoveryZone[] = [{
  id: 'upstream-lan', name: 'Upstream LAN', cidr: '192.168.1.0/24', seedIps: [],
}];

function evidence(patch: Partial<KnownNetworkDevice['device']> = {}, lastSeenAt = '2026-10-23T12:00:00.000Z') {
  const observedAt = lastSeenAt;
  return {
    schemaVersion: 1 as const, identity: 'device:upstream-lan:esp8266:324864',
    firstSeenAt: observedAt, lastSeenAt: observedAt, lastScanId: 'scan-1',
    device: {
      id: 'esp8266:324864', ipAddress: '192.168.1.211', networkZoneId: 'upstream-lan',
      networkZoneName: 'Upstream LAN', protocol: 'http', confidence: 1, status: 'online',
      discoveredAt: observedAt, reason: 'verified', ...patch,
      observations: [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
        { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
      ],
    },
  } satisfies KnownNetworkDevice;
}

const status = {
  schemaVersion: 1, deviceId: 'esp8266:324864', uptimeMs: 12000, sampleIntervalMs: 2000,
  sensor: { state: 'ok', sampleCount: 6, failureCount: 0, lastSampleUptimeMs: 10000,
    readingAgeMs: 2000, temperatureC: 22.5, humidityPct: 48 },
};

describe('Energrid HTTP observation adapter', () => {
  it('selects only fresh, verified endpoint evidence within the enrolled network scope', () => {
    expect(resolveEnergridHttpEndpoint(device, [evidence()], zones, Date.parse('2026-10-23T12:01:00.000Z'))).toMatchObject({
      identityUrl: 'http://192.168.1.211:8080/api/v1/identity',
      statusUrl: 'http://192.168.1.211:8080/api/v1/status',
      identityFresh: true,
      renewalDue: false,
    });
    const expired = resolveEnergridHttpEndpoint(device, [evidence({}, '2026-10-23T11:00:00.000Z')], zones, Date.parse('2026-10-23T12:01:00.000Z'));
    expect(expired).toMatchObject({ identityUrl: 'http://192.168.1.211:8080/api/v1/identity', identityFresh: false, renewalDue: true });
    expect(resolveEnergridHttpEndpoint(device, [evidence()], zones, Date.parse('2026-10-23T12:09:30.000Z')))
      .toMatchObject({ identityFresh: true, renewalDue: true });
    const staleIdentity = evidence({}, '2026-10-23T11:00:00.000Z');
    staleIdentity.lastSeenAt = '2026-10-23T12:00:00.000Z';
    expect(resolveEnergridHttpEndpoint(device, [staleIdentity], zones, Date.parse('2026-10-23T12:01:00.000Z'))).not.toBeNull();
    expect(resolveEnergridHttpEndpoint(device, [evidence({ networkZoneId: 'guest-lan' })], zones, Date.parse('2026-10-23T12:01:00.000Z'))).toBeNull();
    expect(resolveEnergridHttpEndpoint(device, [evidence({ ipAddress: '192.168.2.211' })], zones, Date.parse('2026-10-23T12:01:00.000Z'))).toBeNull();
    expect(resolveEnergridHttpEndpoint(device, [evidence({ identityConflict: { reason: 'multiple_macs_for_endpoint', macAddresses: ['a', 'b'] } })], zones, Date.parse('2026-10-23T12:01:00.000Z'))).toBeNull();
  });

  it('accepts valid firmware 0.2 status samples and rejects identity, bad, and stale data', () => {
    expect(parseEnergridHttpSample(status, 'esp8266:324864')).toMatchObject({ accepted: true, sample: { values: { temperatureC: 22.5, humidityPct: 48 } } });
    expect(parseEnergridHttpSample({ ...status, deviceId: 'esp8266:other' }, 'esp8266:324864')).toMatchObject({ accepted: false, reason: 'status_identity_mismatch' });
    expect(parseEnergridHttpSample({ ...status, sensor: { ...status.sensor, temperatureC: Infinity } }, 'esp8266:324864')).toMatchObject({ accepted: false, reason: 'invalid_sensor_values' });
    expect(parseEnergridHttpSample({ ...status, sensor: { ...status.sensor, readingAgeMs: 20_000 } }, 'esp8266:324864')).toMatchObject({ accepted: false, reason: 'stale_sensor_sample' });
    expect(parseEnergridHttpSample({ ...status, sensor: { ...status.sensor, state: 'error', temperatureC: null } }, 'esp8266:324864')).toMatchObject({ accepted: false, reason: 'sensor_not_ok' });
  });

  it('creates explicit approval for only temperature and humidity from the Energrid status source', () => {
    const approval = energridHttpObservationApproval(device.id);
    expect(Object.keys(approval.bindings[0].fields)).toEqual(['temperature', 'humidity']);
    expect(approval.bindings[0]).toMatchObject({ sourceId: 'energrid-http-status', selector: '/api/v1/status' });
    expect(approval.policy.allowedSourcesByField).toEqual({
      temperature: ['energrid-http-status'], humidity: ['energrid-http-status'],
    });
    expect(() => energridHttpObservationApproval('not-an-energrid-device')).toThrow();
  });

  it('correlates stable firmware identity only through approved discovery scope, not by IP', () => {
    const first = resolveEnergridHttpEndpoint(device, [evidence()], zones, Date.parse('2026-10-23T12:01:00.000Z'));
    const changedIp = evidence();
    changedIp.device.ipAddress = '192.168.1.250';
    const moved = resolveEnergridHttpEndpoint(device, [changedIp], zones, Date.parse('2026-10-23T12:01:00.000Z'));
    expect(first?.statusUrl).toContain('192.168.1.211');
    expect(moved?.statusUrl).toContain('192.168.1.250');
    expect(changedIp.identity).toBe('device:upstream-lan:esp8266:324864');
  });
});
