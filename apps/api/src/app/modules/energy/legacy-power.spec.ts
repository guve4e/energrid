import { normalizeLegacyPower } from './legacy-power-normalizer';
import { legacyPowerConfig } from './legacy-power.config';

const timestamp = new Date('2026-10-10T01:00:00Z');
const binding = {
  id: 'boiler',
  displayName: 'Boiler',
  tenantId: 'tenant-demo',
  siteId: 'site-home',
  sourceDeviceId: 'boiler',
};

describe('legacy power normalization boundary', () => {
  it.each([
    [{ value: { value: 2800 } }, 2800],
    [{ value: 0 }, 0],
    [{ value: '123.5', unit: 'W' }, 123.5],
    [{ value: { value: '2.8' }, unit: 'kW' }, 2800],
    [{ value: '1e3' }, 1000],
  ])('normalizes %j without leaking legacy objects', (document, powerW) => {
    expect(normalizeLegacyPower({ timestamp, ...document })).toEqual({
      observedAt: timestamp.toISOString(),
      powerW,
    });
  });
  it.each([
    null,
    undefined,
    true,
    false,
    '',
    ' ',
    'invalid',
    NaN,
    Infinity,
    -1,
    {},
    { value: null },
    { value: true },
  ])('does not convert %j to a real power measurement', (value) => {
    expect(normalizeLegacyPower({ timestamp, value })?.powerW).toBeNull();
  });
  it.each(['A', 'kWh', '', false])('rejects unexpected units %s', (unit) => {
    expect(
      normalizeLegacyPower({ timestamp, value: 100, unit })?.powerW,
    ).toBeNull();
  });
  it.each([undefined, '2026-10-10', new Date('invalid'), null, 0])(
    'rejects an invalid BSON timestamp %j',
    (time) => {
      expect(normalizeLegacyPower({ timestamp: time, value: 100 })).toBeNull();
    },
  );
});

describe('explicit legacy asset bindings', () => {
  it('is disabled by default and does not discover arbitrary devices', () => {
    expect(legacyPowerConfig({})).toEqual({
      uri: null,
      database: 'mqtt',
      bindings: [],
    });
  });
  it('parses only supported fields and keeps the source mapping at the adapter boundary', () => {
    const config = legacyPowerConfig({
      LEGACY_TELEMETRY_ASSETS: JSON.stringify([
        {
          ...binding,
          oldObject: { arbitrary: true },
          capacityLiters: 80,
          schedule: {
            start: '04:00',
            end: '06:00',
            effectiveFrom: '2026-05-04',
          },
        },
      ]),
    });
    expect(config.bindings[0]).toEqual({
      ...binding,
      timezone: 'Europe/Sofia',
      activeThresholdW: 500,
      capacityLiters: 80,
      schedule: { start: '04:00', end: '06:00', effectiveFrom: '2026-05-04' },
    });
    expect(config.bindings[0]).not.toHaveProperty('oldObject');
  });
  it.each(['invalid', '{}', 'null', '[null]'])(
    'rejects malformed configuration %s',
    (json) => {
      expect(() =>
        legacyPowerConfig({ LEGACY_TELEMETRY_ASSETS: json }),
      ).toThrow();
    },
  );
  it.each([
    { id: '../boiler' },
    { sourceDeviceId: '' },
    { tenantId: null },
    { siteId: '' },
    { timezone: 'invalid' },
    { activeThresholdW: 0 },
    { activeThresholdW: '500' },
    { capacityLiters: -1 },
    { schedule: null },
    { schedule: { start: '25:00', end: '06:00' } },
    { schedule: { start: '04:00', end: '04:00' } },
    { schedule: { start: '04:00', end: '06:00', effectiveFrom: '2026-02-30' } },
  ])('rejects invalid binding fields %j', (changes) => {
    expect(() =>
      legacyPowerConfig({
        LEGACY_TELEMETRY_ASSETS: JSON.stringify([{ ...binding, ...changes }]),
      }),
    ).toThrow();
  });
  it('rejects duplicate canonical asset IDs', () => {
    expect(() =>
      legacyPowerConfig({
        LEGACY_TELEMETRY_ASSETS: JSON.stringify([binding, binding]),
      }),
    ).toThrow();
  });
  it('allows a reference window without inventing an effective date', () => {
    const config = legacyPowerConfig({
      LEGACY_TELEMETRY_MONGO_URI: ' private-uri ',
      LEGACY_TELEMETRY_DATABASE: 'history',
      LEGACY_TELEMETRY_ASSETS: JSON.stringify([
        {
          ...binding,
          timezone: 'UTC',
          activeThresholdW: 100,
          schedule: { start: '04:00', end: '06:00' },
        },
      ]),
    });
    expect(config.uri).toBe('private-uri');
    expect(config.database).toBe('history');
    expect(config.bindings[0].schedule).toEqual({
      start: '04:00',
      end: '06:00',
    });
  });
});
