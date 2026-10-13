import {
  ElectricalReading,
  summarizeElectricalHour,
  validateElectricalReading,
  utcInstant,
} from './electrical-reading';

const hour = '2026-10-11T01:00:00.000Z';
const reading = (
  patch: Partial<ElectricalReading> = {},
): ElectricalReading => ({
  schemaVersion: 1,
  tenantId: 'home',
  siteId: 'vidin',
  deviceId: 'meter-1',
  channel: 'em1:0',
  metric: 'power',
  value: 3000,
  unit: 'W',
  quality: 'measured',
  observedAt: hour,
  receivedAt: '2026-10-11T05:00:00.000Z',
  timestampBasis: 'device-observed',
  source: 'shelly',
  ...patch,
});
const point = (
  minute: number,
  value: number | null = 3000,
  patch: Partial<ElectricalReading> = {},
) =>
  reading({
    observedAt: new Date(Date.parse(hour) + minute * 60000).toISOString(),
    value,
    quality: value === null ? 'invalid' : 'measured',
    ...patch,
  });

describe('electrical reading v1 runtime contract', () => {
  it('returns only canonical fields and normalizes timestamps', () => {
    const input = {
      ...reading(),
      observedAt: '2026-10-11T01:00:00Z',
      oldMongoObject: {},
    };
    expect(validateElectricalReading(input)).toEqual(reading());
  });
  it('preserves signed power and explicitly invalid readings', () => {
    expect(validateElectricalReading(reading({ value: -200 })).value).toBe(
      -200,
    );
    expect(
      validateElectricalReading(reading({ value: null, quality: 'invalid' }))
        .value,
    ).toBeNull();
  });
  it.each(['energy_import_total', 'energy_export_total'] as const)(
    'accepts a cumulative %s in kWh',
    (metric) => {
      expect(
        validateElectricalReading(reading({ metric, unit: 'kWh', value: 12.5 }))
          .metric,
      ).toBe(metric);
    },
  );
  it.each([
    null,
    [],
    'power',
    { schemaVersion: 2 },
    { metric: 'temperature' },
    { unit: 'kW' },
    { metric: 'energy_import_total', unit: 'Wh' },
    { metric: 'energy_export_total', unit: 'kWh', value: -1 },
    { value: true },
    { value: '3000' },
    { value: null },
    { value: NaN },
    { value: Infinity },
    { value: 5, quality: 'invalid' },
    { quality: 'estimated' },
    { timestampBasis: 'unknown' },
    { observedAt: '2026-10-11' },
    { observedAt: '2026-02-30T00:00:00Z' },
    { observedAt: '2026-10-11T24:00:00Z' },
    { observedAt: '2026-10-11T01:00:00+03:00' },
    { receivedAt: 'invalid' },
    { observedAt: '2026-10-11T05:05:00.001Z' },
    { tenantId: '' },
    { siteId: 'a/b' },
    { deviceId: ' '.repeat(121) },
    { channel: {} },
    { source: 'url://secret' },
  ])('rejects malformed readings: %j', (patch) => {
    const input =
      patch && typeof patch === 'object' && !Array.isArray(patch)
        ? { ...reading(), ...patch }
        : patch;
    expect(() => validateElectricalReading(input)).toThrow();
  });
  it('rejects a reading without required fields', () => {
    expect(() => validateElectricalReading({})).toThrow();
  });
  it('accepts the five minute clock skew boundary, and old backfill', () => {
    expect(
      validateElectricalReading(reading({ observedAt: '2026-10-11T05:05:00Z' }))
        .observedAt,
    ).toContain('05:05');
    expect(
      validateElectricalReading(reading({ observedAt: '2020-01-01T00:00:00Z' }))
        .observedAt,
    ).toContain('2020');
  });
  it.each([undefined, '', '2026-01-01', '2026-02-29T00:00:00Z'])(
    'rejects invalid UTC instants %s',
    (value) => {
      expect(() => utcInstant(value)).toThrow();
    },
  );
});

describe('pure UTC hourly summaries', () => {
  it('integrates bracketed power, not a sum of samples', () => {
    const points = Array.from({ length: 13 }, (_, i) => point(i * 5));
    expect(summarizeElectricalHour(points, hour)).toEqual({
      hour,
      sampleCount: 12,
      invalidCount: 0,
      minimum: 3000,
      maximum: 3000,
      sampleMean: 3000,
      firstValue: 3000,
      lastValue: 3000,
      firstObservedAt: hour,
      lastObservedAt: point(55).observedAt,
      sources: ['shelly'],
      timestampBases: ['device-observed'],
      counterResets: 0,
      estimatedImportKwh: 3,
      estimatedExportKwh: 0,
      coveredSeconds: 3600,
    });
  });
  it('separates import and export, and is order independent', () => {
    const result = summarizeElectricalHour(
      [point(10, 0), point(0, 3000), point(5, -1000)],
      hour,
    );
    expect(result.estimatedImportKwh).toBe(0.25);
    expect(result.estimatedExportKwh).toBeCloseTo(1 / 12);
    expect(result.coveredSeconds).toBe(600);
  });
  it('clips intervals to the hour and does not count boundary samples twice', () => {
    const result = summarizeElectricalHour(
      [point(-2), point(2), point(58), point(62)],
      hour,
    );
    expect(result.sampleCount).toBe(2);
    expect(result.coveredSeconds).toBe(240);
    expect(result.estimatedImportKwh).toBe(0.2);
  });
  it('does not bridge outages, invalid values, or extrapolate an unbracketed point', () => {
    const result = summarizeElectricalHour(
      [point(0), point(5, null), point(10), point(16)],
      hour,
    );
    expect(result.coveredSeconds).toBe(0);
    expect(result.invalidCount).toBe(1);
    expect(result.estimatedImportKwh).toBeNull();
    expect(
      summarizeElectricalHour([point(0)], hour).estimatedImportKwh,
    ).toBeNull();
  });
  it('distinguishes covered zero from missing energy', () => {
    expect(
      summarizeElectricalHour([point(0, 0), point(5, 0)], hour)
        .estimatedImportKwh,
    ).toBe(0);
    expect(summarizeElectricalHour([], hour)).toEqual(
      expect.objectContaining({
        sampleCount: 0,
        minimum: null,
        maximum: null,
        sampleMean: null,
        estimatedImportKwh: null,
      }),
    );
  });
  it('stores counter endpoints and detects a reset instead of summing cumulative totals', () => {
    const counter = { metric: 'energy_import_total', unit: 'kWh' } as const;
    const result = summarizeElectricalHour(
      [
        point(-1, 99, counter),
        point(0, 100, counter),
        point(10, 102, counter),
        point(20, 1, counter),
      ],
      hour,
    );
    expect(result.firstValue).toBe(100);
    expect(result.lastValue).toBe(1);
    expect(result.counterResets).toBe(1);
    expect(result.estimatedImportKwh).toBeNull();
    expect(result.coveredSeconds).toBe(0);
  });
  it('does not compare counters across an invalid sample', () => {
    const counter = { metric: 'energy_export_total', unit: 'kWh' } as const;
    expect(
      summarizeElectricalHour(
        [point(0, 10, counter), point(1, null, counter), point(2, 1, counter)],
        hour,
      ).counterResets,
    ).toBe(0);
  });
  it('rejects mixed devices, channels, metrics or non-hour boundaries', () => {
    for (const patch of [
      { deviceId: 'other' },
      { channel: 'em1:1' },
      { siteId: 'other' },
      { metric: 'energy_import_total' as const },
    ])
      expect(() =>
        summarizeElectricalHour([point(0), point(1, 10, patch)], hour),
      ).toThrow('mixed');
    expect(() => summarizeElectricalHour([], point(1).observedAt)).toThrow(
      'boundary',
    );
  });
  it('keeps repeated local DST hours distinct using UTC boundaries', () => {
    const first = '2026-10-25T00:00:00.000Z',
      second = '2026-10-25T01:00:00.000Z';
    expect(summarizeElectricalHour([], first).hour).not.toBe(
      summarizeElectricalHour([], second).hour,
    );
  });
});
