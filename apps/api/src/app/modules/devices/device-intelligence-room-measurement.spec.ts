import { DeviceIntelligenceQueryService } from './device-intelligence-query.service';

const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
const deviceId = 'device:upstream-lan:esp8266:324864';
const observedAt = new Date(Date.now() - 2_000).toISOString();

function installation(
  id = deviceId,
  zoneName = 'Kitchen',
  tenantId = scope.tenantId,
  siteId = scope.siteId,
) {
  const device = {
    id,
    tenantId,
    siteId,
    kind: 'physical',
    trustStatus: 'approved',
    displayName: id === deviceId ? 'Energrid ESP8266 DHT22' : `Sensor ${id}`,
    zoneName,
    capabilities: [],
    assistantEnabled: true,
  };
  return { schemaVersion: 1, device, updatedAt: observedAt };
}

function harness(options: {
  installations?: ReturnType<typeof installation>[];
  state?: Record<string, unknown> | null;
} = {}) {
  const records = options.installations ?? [installation()];
  const registry = {
    ensureInstallationsLoaded: jest.fn(),
    getDevices: jest.fn(() => records.map(record => record.device)),
  };
  const store = {
    get: jest.fn(async (_siteId: string, id: string) => records.find(record => record.device.id === id) ?? null),
    list: jest.fn(async (siteId: string) => records.filter(record => record.device.siteId === siteId)),
  };
  const enrollment = { find: jest.fn(async () => ({ status: 'enrolled' })) };
  const reader = { read: jest.fn(async () => options.state === undefined ? ({
    deviceId,
    fields: {
      temperature: { value: 19.4, sourceId: 'energrid-http-status', receivedAt: observedAt },
      humidity: { value: 54.2, sourceId: 'energrid-http-status', receivedAt: observedAt },
    },
  } as never) : options.state as never) };
  const service = new DeviceIntelligenceQueryService(
    registry as never,
    store as never,
    enrollment as never,
    reader as never,
  );
  return { service, registry, store, reader };
}

describe('DeviceIntelligenceQueryService room measurements', () => {
  it.each([
    ['кухнята', 'temperature'],
    ['kuhnqta', 'temperature'],
    ['kitchen', 'humidity'],
  ])('resolves %s to the requested approved Core metric', async (room, metric) => {
    const { service, reader } = harness();
    const result = await service.readRoomMeasurement(scope, room, metric);
    expect(result).toMatchObject({
      status: 'measurement', deviceId, metric,
      value: metric === 'temperature' ? 19.4 : 54.2,
      unit: metric === 'temperature' ? 'Cel' : '%RH',
      sourceId: 'energrid-http-status', observedAt,
      freshness: 'fresh',
    });
    expect(reader.read).toHaveBeenCalledWith(scope, deviceId);
  });

  it('preserves stale status and source time instead of presenting a stale value as fresh', async () => {
    const staleAt = new Date(Date.now() - 300_000).toISOString();
    const state = {
      deviceId,
      fields: { temperature: {
        value: 19.4, sourceId: 'energrid-http-status', receivedAt: staleAt,
        measuredAt: staleAt,
      } },
    };
    const { service } = harness({ state });
    expect(await service.readRoomMeasurement(scope, 'Kitchen', 'temperature'))
      .toMatchObject({ status: 'measurement', value: 19.4, freshness: 'stale', observedAt: staleAt, ageSeconds: 300 });
  });

  it('returns unavailable when the approved reader has no field or revoked authority', async () => {
    const noField = harness({ state: { deviceId, fields: {} } });
    expect(await noField.service.readRoomMeasurement(scope, 'Kitchen', 'temperature'))
      .toMatchObject({ status: 'unavailable', deviceId, metric: 'temperature' });
    const revoked = harness({ state: null });
    expect(await revoked.service.readRoomMeasurement(scope, 'Kitchen', 'humidity'))
      .toMatchObject({ status: 'unavailable', deviceId, metric: 'humidity' });
  });

  it('does not resolve across tenant/site boundaries and refuses multiple devices in one room', async () => {
    const wrongTenant = harness({ installations: [installation(deviceId, 'Kitchen', 'tenant-other')] });
    await expect(wrongTenant.service.readRoomMeasurement(scope, 'Kitchen', 'temperature'))
      .resolves.toEqual({ status: 'not_found' });
    const wrongSite = harness({ installations: [installation(deviceId, 'Kitchen', scope.tenantId, 'site-other')] });
    await expect(wrongSite.service.readRoomMeasurement(scope, 'Kitchen', 'temperature'))
      .resolves.toEqual({ status: 'not_found' });

    const ambiguous = harness({ installations: [
      installation(),
      installation('device:another-sensor', 'Kitchen'),
    ] });
    await expect(ambiguous.service.readRoomMeasurement(scope, 'Kitchen', 'temperature'))
      .resolves.toMatchObject({ status: 'ambiguous', deviceIds: ['device:another-sensor', deviceId] });
    expect(ambiguous.reader.read).not.toHaveBeenCalled();
  });

  it('rejects unsupported metric names without querying observations', async () => {
    const { service, reader } = harness();
    await expect(service.readRoomMeasurement(scope, 'Kitchen', 'pressure'))
      .resolves.toEqual({ status: 'not_found' });
    expect(reader.read).not.toHaveBeenCalled();
  });
});
