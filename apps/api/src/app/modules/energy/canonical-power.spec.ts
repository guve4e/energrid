import { canonicalPowerConfig } from './canonical-power.config';
import { CanonicalPowerHistoryReader } from './canonical-power-history.reader';
import { TelemetryStore } from '../telemetry/telemetry.store';
import { testReading } from '../telemetry/telemetry-test.fixture';
import { TelemetryHistoryController } from './telemetry-history.controller';
import { TelemetryIngestService } from '../telemetry/telemetry-ingest.service';
import type { DeviceProxyRequest } from '../portal/portal-device-proxy.service';

const from = '2026-10-11T01:00:00.000Z',
  to = '2026-10-11T02:00:00.000Z';
const asset = () => ({
  id: 'boiler',
  displayName: 'Boiler',
  tenantId: 'tenant-demo',
  siteId: 'site-home',
  timezone: 'Europe/Sofia',
  activeThresholdW: 500,
  capacityLiters: 80,
  schedule: { start: '04:00', end: '06:00', effectiveFrom: '2026-05-01' },
  meters: [{ deviceId: 'meter', channel: 'em1:0', from }],
});
const config = (entries: unknown = [asset()]) =>
  canonicalPowerConfig({ TELEMETRY_POWER_ASSETS: JSON.stringify(entries) });
const setup = () => {
  const store = {
    read: jest.fn().mockResolvedValue([testReading()]),
    hourly: jest.fn().mockResolvedValue([]),
  };
  return {
    store,
    reader: new CanonicalPowerHistoryReader(
      config(),
      store as unknown as TelemetryStore,
    ),
  };
};
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = process.env;
  process.env = {
    ...saved,
    PORTAL_TENANT_ID: 'tenant-demo',
    PORTAL_SITE_ID: 'site-home',
    PORTAL_CONTROL_TOKEN: 'test-token',
  };
});
afterEach(() => {
  process.env = saved;
});

describe('explicit asset to physical channel assignments', () => {
  it('keeps legacy history as the default and has no invented assignments', () => {
    expect(canonicalPowerConfig({})).toEqual({
      source: 'legacy',
      bindings: [],
    });
    expect(config().bindings[0].measurementSources).toEqual(asset().meters);
  });
  it('selects canonical history only explicitly', () => {
    expect(
      canonicalPowerConfig({ ENERGY_HISTORY_SOURCE: 'telemetry' }).source,
    ).toBe('telemetry');
    expect(() =>
      canonicalPowerConfig({ ENERGY_HISTORY_SOURCE: 'both' }),
    ).toThrow();
    expect(() =>
      canonicalPowerConfig({ TELEMETRY_POWER_ASSETS: '{bad' }),
    ).toThrow();
  });
  it.each([
    null,
    {},
    [null],
    [{ ...asset(), id: 'not/a/url' }],
    [{ ...asset(), displayName: '' }],
    [{ ...asset(), timezone: 'unknown' }],
    [{ ...asset(), activeThresholdW: 0 }],
    [{ ...asset(), meters: [] }],
    [{ ...asset(), meters: [null] }],
    [{ ...asset(), meters: [{ deviceId: 'meter', channel: '', from }] }],
    [
      {
        ...asset(),
        meters: [{ deviceId: 'meter', channel: 'em1:0', from: '2026-01-01' }],
      },
    ],
    [
      {
        ...asset(),
        meters: [{ deviceId: 'meter', channel: 'em1:0', from, to: from }],
      },
    ],
    [{ ...asset(), capacityLiters: -1 }],
    [
      {
        ...asset(),
        schedule: { start: '04:00', end: '06:00', effectiveFrom: 'invalid' },
      },
    ],
    [{ ...asset(), schedule: { start: 'bad', end: '06:00' } }],
    [{ ...asset(), schedule: { start: '04:00', end: '04:00' } }],
    [
      {
        ...asset(),
        schedule: { start: '04:00', end: '06:00', effectiveFrom: '2026-02-30' },
      },
    ],
    [asset(), asset()],
  ])('rejects invalid configuration %j', (entries) => {
    expect(() => config(entries)).toThrow();
  });
  it('rejects overlapping sources on one appliance and double assignments across appliances', () => {
    expect(() =>
      config([
        {
          ...asset(),
          meters: [
            ...asset().meters,
            { deviceId: 'other', channel: 'em1:0', from },
          ],
        },
      ]),
    ).toThrow('overlap');
    expect(() =>
      config([asset(), { ...asset(), id: 'other-appliance' }]),
    ).toThrow('overlapping assets');
  });
  it('allows dated replacements, gaps and reuse after an assignment ends', () => {
    const old = { deviceId: 'old', channel: 'em1:0', from, to };
    const replacement = { deviceId: 'new', channel: 'em1:0', from: to };
    expect(
      config([{ ...asset(), meters: [replacement, old] }]).bindings[0].meters,
    ).toEqual([old, replacement]);
    expect(
      config([
        { ...asset(), meters: [old] },
        {
          ...asset(),
          id: 'second',
          meters: [{ ...old, from: to, to: undefined }],
        },
      ]).bindings,
    ).toHaveLength(2);
  });
});

describe('canonical history reader', () => {
  it('queries canonical measurements, independently of Mongo documents', async () => {
    const { reader, store } = setup();
    const result = await reader.read('boiler', { from, to });
    expect(store.read).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-demo',
        siteId: 'site-home',
        deviceId: 'meter',
        channel: 'em1:0',
        metric: 'power',
      },
      from,
      to,
    );
    expect(result.source).toBe('energrid-postgres-power');
    expect(result.timestampBasis).toBe('device-observed');
    expect(result.observations[0].powerW).toBe(3000);
    expect(result.observations[0].seriesId).toContain('meter/em1:0/');
  });
  it('preserves invalid continuity breaks and separates export from appliance consumption', async () => {
    const { reader, store } = setup();
    store.read.mockResolvedValue([
      testReading({ value: null, quality: 'invalid' }),
      testReading({ value: -200 }),
    ]);
    expect(
      (await reader.read('boiler', { from, to })).observations.map(
        (o) => o.powerW,
      ),
    ).toEqual([null, 0]);
  });
  it('identifies mixed clock provenance', async () => {
    const { reader, store } = setup();
    store.read.mockResolvedValue([
      testReading(),
      testReading({ timestampBasis: 'collector-received' }),
    ]);
    expect((await reader.read('boiler', { from, to })).timestampBasis).toBe(
      'mixed',
    );
  });
  it('excludes readings before an assignment and does not query disjoint periods', async () => {
    const { reader, store } = setup();
    store.read.mockResolvedValue([
      testReading({ observedAt: '2026-10-11T00:59:00Z' }),
    ]);
    expect((await reader.read('boiler', { from, to })).observations).toEqual(
      [],
    );
    store.read.mockClear();
    expect(
      (await reader.read('boiler', { from: '2026-10-10T00:00:00Z', to: from }))
        .observations,
    ).toEqual([]);
    expect(store.read).not.toHaveBeenCalled();
  });
  it('does not cross tenant/site boundaries or query unknown assets', async () => {
    const { reader, store } = setup();
    await expect(reader.read('unknown', { from, to })).rejects.toThrow(
      'not assigned',
    );
    process.env.PORTAL_TENANT_ID = 'other';
    await expect(reader.read('boiler', { from, to })).rejects.toThrow(
      'not assigned',
    );
    expect(store.read).not.toHaveBeenCalled();
  });
  it('sanitizes database failures without falling back to legacy history', async () => {
    const { reader, store } = setup();
    store.read.mockRejectedValue(new Error('private-host:secret'));
    await expect(reader.read('boiler', { from, to })).rejects.toThrow(
      'Energrid reading history is unavailable',
    );
    try {
      await reader.read('boiler', { from, to });
    } catch (e) {
      expect(String(e)).not.toContain('secret');
    }
  });
  it('returns stored summaries and excludes partially assigned hours', async () => {
    const { reader, store } = setup();
    store.hourly.mockResolvedValue([
      { hour: '2026-10-11T00:00:00.000Z' },
      { hour: from },
    ]);
    const result = await reader.summaries('boiler', '2026-10-11T00:00:00Z', to);
    expect(result.series[0].buckets).toEqual([{ hour: from }]);
    expect(result.freshness).toBe('asynchronous');
  });
  it('rejects excess assigned rows rather than producing a partial energy total', async () => {
    const { reader, store } = setup();
    store.read.mockResolvedValue(Array(100001).fill(testReading()));
    await expect(reader.read('boiler', { from, to })).rejects.toThrow(
      'choose a shorter period',
    );
  });
  it('sanitizes summary storage failures', async () => {
    const { reader, store } = setup();
    store.hourly.mockRejectedValue(new Error('private-host:secret'));
    await expect(reader.summaries('boiler', from, to)).rejects.toThrow(
      'hourly summaries are unavailable',
    );
  });
  it.each([
    [from, from],
    ['invalid', to],
    [from, '2099-01-01T00:00:00Z'],
    ['2024-01-01T00:00:00Z', to],
    ['2026-10-11T01:01:00Z', to],
  ])('rejects invalid summary ranges %s %s', async (start, end) => {
    await expect(
      setup().reader.summaries('boiler', start, end),
    ).rejects.toThrow('Choose past UTC');
  });
});

describe('history status and rollup authorization', () => {
  const request = (token?: string) =>
    ({
      headers: token ? { authorization: `Bearer ${token}` } : {},
      url: '/',
    }) as DeviceProxyRequest;
  it('requires the portal token for both endpoints', async () => {
    const controller = new TelemetryHistoryController(
      { status: jest.fn() } as unknown as TelemetryIngestService,
      setup().reader,
    );
    expect(() => controller.status(request())).toThrow();
    await expect(
      controller.hourly(request('wrong'), 'boiler', from, to),
    ).rejects.toThrow();
  });
  it('returns safe status and scoped summaries for authorized requests', async () => {
    const status = { enabled: false, pending: 0 };
    const controller = new TelemetryHistoryController(
      { status: () => status } as TelemetryIngestService,
      setup().reader,
    );
    expect(controller.status(request('test-token'))).toEqual(status);
    expect(
      (await controller.hourly(request('test-token'), 'boiler', from, to))
        .resolution,
    ).toBe('UTC-hour');
    await expect(
      controller.hourly(request('test-token'), 'boiler', 'bad', to),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.hourly(request('test-token'), 'unknown', from, to),
    ).rejects.toMatchObject({ status: 404 });
  });
});
