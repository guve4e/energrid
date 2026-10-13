import {
  analyzePowerHistory,
  localDateAt,
  PowerObservation,
} from './power-history';

const asset = { timezone: 'Europe/Sofia', activeThresholdW: 500 };
const range = {
  from: '2026-10-10T00:00:00.000Z',
  to: '2026-10-10T01:00:00.000Z',
};
const at = (minute: number, powerW: number | null): PowerObservation => ({
  observedAt: new Date(Date.parse(range.from) + minute * 60000).toISOString(),
  powerW,
});
const continuous = (from: string, to: string, watts = 1000) =>
  Array.from(
    { length: (Date.parse(to) - Date.parse(from)) / 60000 + 1 },
    (_, i) => ({
      observedAt: new Date(Date.parse(from) + i * 60000).toISOString(),
      powerW: watts,
    }),
  );

describe('power history analysis', () => {
  it('integrates elapsed time, not the arithmetic mean of samples', () => {
    const result = analyzePowerHistory(
      [at(0, 3000), at(1, 0), at(5, 0)],
      { ...range, to: at(5, 0).observedAt },
      asset,
    );
    expect(result.summary.energyKwh).toBeCloseTo(0.05);
    expect(result.summary.averagePowerW).toBe(600);
    expect(result.summary.activeMinutes).toBe(1);
    expect(result.summary.coveragePct).toBe(100);
    expect(result.summary.peakPowerW).toBe(3000);
  });
  it('represents a measured zero differently from no measurements', () => {
    const measured = analyzePowerHistory(
      [at(0, 0), at(5, 0)],
      { ...range, to: at(5, 0).observedAt },
      asset,
    );
    expect(measured.summary.energyKwh).toBe(0);
    expect(measured.summary.activeMinutes).toBe(0);
    const missing = analyzePowerHistory([], range, asset);
    expect(missing.summary.energyKwh).toBeNull();
    expect(missing.summary.averagePowerW).toBeNull();
    expect(missing.summary.peakPowerW).toBeNull();
    expect(missing.summary.activeMinutes).toBeNull();
    expect(missing.summary.coveragePct).toBe(0);
    expect(missing.hourly).toHaveLength(1);
    expect(missing.daily).toHaveLength(1);
  });
  it('does not extrapolate a final reading or bridge a long outage', () => {
    const result = analyzePowerHistory(
      [at(0, 3000), at(2, 3000), at(50, 3000)],
      range,
      asset,
    );
    expect(result.summary.energyKwh).toBeCloseTo(0.1);
    expect(result.summary.coveragePct).toBeCloseTo((100 * 2) / 60);
    expect(result.summary.coveredSeconds).toBe(120);
  });
  it('clips bracketed intervals at both requested boundaries', () => {
    const result = analyzePowerHistory(
      [at(-1, 3000), at(1, 3000), at(3, 0)],
      { from: at(0, 0).observedAt, to: at(2, 0).observedAt },
      asset,
    );
    expect(result.summary.energyKwh).toBeCloseTo(0.1);
    expect(result.summary.coveragePct).toBe(100);
    expect(result.hourly[0].expectedSeconds).toBe(120);
  });
  it('sorts and deduplicates observations without double counting', () => {
    const result = analyzePowerHistory(
      [at(5, 1000), at(0, 1000), at(0, 1000)],
      { ...range, to: at(5, 0).observedAt },
      asset,
    );
    expect(result.summary.energyKwh).toBeCloseTo(1 / 12);
    expect(result.duplicateReadings).toBe(1);
    expect(result.conflictingReadings).toBe(0);
  });
  it('breaks continuity at conflicting duplicate timestamps', () => {
    const result = analyzePowerHistory(
      [at(0, 1000), at(2, 1000), at(2, 0), at(4, 1000), at(5, 1000)],
      { ...range, to: at(5, 0).observedAt },
      asset,
    );
    expect(result.summary.coveredSeconds).toBe(60);
    expect(result.conflictingReadings).toBe(1);
  });
  it.each([null, NaN, Infinity, -1])(
    'treats invalid power %s as a continuity break',
    (power) => {
      const result = analyzePowerHistory(
        [at(0, 1000), at(2, power), at(4, 1000)],
        { ...range, to: at(4, 0).observedAt },
        asset,
      );
      expect(result.summary.energyKwh).toBeNull();
      expect(result.invalidReadings).toBe(1);
    },
  );
  it('rejects invalid timestamps', () => {
    expect(
      analyzePowerHistory(
        [{ observedAt: 'invalid', powerW: 1000 }],
        range,
        asset,
      ).invalidReadings,
    ).toBe(1);
  });
  it('splits energy into hourly and local daily buckets with conserved totals', () => {
    const query = { from: '2026-10-10T20:30:00Z', to: '2026-10-10T21:30:00Z' };
    const result = analyzePowerHistory(
      continuous(query.from, query.to),
      query,
      asset,
    );
    expect(result.hourly).toHaveLength(2);
    expect(result.daily.map((day) => day.date)).toEqual([
      '2026-10-10',
      '2026-10-11',
    ]);
    expect(result.daily.map((day) => day.energyKwh)).toEqual([0.5, 0.5]);
    expect(
      result.hourly.reduce((sum, hour) => sum + (hour.energyKwh ?? 0), 0),
    ).toBe(result.summary.energyKwh);
  });
  it('respects minute-precise schedule boundaries', () => {
    const query = { from: '2026-10-10T00:59:00Z', to: '2026-10-10T01:04:00Z' };
    const result = analyzePowerHistory(
      continuous(query.from, query.to, 3000),
      query,
      { ...asset, schedule: { start: '04:01', end: '04:03' } },
    );
    expect(result.summary.outsideScheduleKwh).toBeCloseTo(0.15);
    expect(result.summary.energyKwh).toBeCloseTo(0.25);
  });
  it('supports an overnight schedule', () => {
    const query = { from: '2026-10-10T20:00:00Z', to: '2026-10-11T05:00:00Z' };
    const result = analyzePowerHistory(
      continuous(query.from, query.to),
      query,
      { ...asset, schedule: { start: '23:00', end: '07:00' } },
    );
    expect(result.summary.energyKwh).toBe(9);
    expect(result.summary.outsideScheduleKwh).toBe(1);
  });
  it('does not apply a schedule before its effective date', () => {
    const query = { from: '2026-05-03T20:00:00Z', to: '2026-05-04T00:00:00Z' };
    const result = analyzePowerHistory(
      continuous(query.from, query.to),
      query,
      {
        ...asset,
        schedule: { start: '04:00', end: '06:00', effectiveFrom: '2026-05-04' },
      },
    );
    expect(result.summary.outsideScheduleKwh).toBeNull();
    expect(result.daily[0].outsideScheduleKwh).toBeNull();
    expect(result.daily[1].outsideScheduleKwh).toBe(3);
  });
  it.each([
    ['2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z', 23],
    ['2026-10-24T21:00:00Z', '2026-10-25T22:00:00Z', 25],
  ])(
    'handles Sofia DST day %s without assuming 24 hours',
    (from, to, hours) => {
      const result = analyzePowerHistory(
        continuous(from, to),
        { from, to },
        asset,
      );
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0].energyKwh).toBe(hours);
      expect(result.daily[0].expectedSeconds).toBe(hours * 3600);
      expect(result.hourly).toHaveLength(hours);
      expect(result.summary.coveragePct).toBe(100);
    },
  );
  it('keeps repeated local DST hours as distinct UTC intervals', () => {
    const query = { from: '2026-10-25T00:00:00Z', to: '2026-10-25T02:00:00Z' };
    const result = analyzePowerHistory(
      continuous(query.from, query.to),
      query,
      asset,
    );
    expect(result.hourly.map((hour) => hour.localHour)).toEqual([
      '03:00',
      '03:00',
    ]);
    expect(result.hourly[0].from).not.toBe(result.hourly[1].from);
  });
  it('handles fractional-offset local days without assigning midnight to the previous day', () => {
    const query = { from: '2026-10-10T17:30:00Z', to: '2026-10-10T19:30:00Z' };
    const result = analyzePowerHistory(
      continuous(query.from, query.to),
      query,
      { ...asset, timezone: 'Asia/Kolkata' },
    );
    expect(result.hourly.map((hour) => hour.localHour)).toEqual([
      '23:00',
      '00:00',
    ]);
    expect(result.daily.map((day) => day.energyKwh)).toEqual([1, 1]);
    expect(result.daily.map((day) => day.date)).toEqual([
      '2026-10-10',
      '2026-10-11',
    ]);
  });
  it('leaves outside-schedule energy unknown when no schedule is assigned', () => {
    expect(
      analyzePowerHistory(continuous(range.from, range.to), range, asset)
        .summary.outsideScheduleKwh,
    ).toBeNull();
  });
  it.each([
    { from: 'invalid', to: range.to },
    { from: range.from, to: 'invalid' },
    { from: range.from, to: range.from },
    { from: range.to, to: range.from },
    { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' },
  ])('rejects invalid or oversized ranges %j', (query) => {
    expect(() => analyzePowerHistory([], query, asset)).toThrow(
      'Invalid power history range',
    );
  });
  it.each([0, -1, NaN, Infinity])('rejects an invalid gap limit %s', (gap) => {
    expect(() => analyzePowerHistory([], range, asset, gap)).toThrow();
  });
  it('rejects invalid settings and schedule times', () => {
    expect(() =>
      analyzePowerHistory([], range, { ...asset, activeThresholdW: NaN }),
    ).toThrow();
    expect(() =>
      analyzePowerHistory([], range, {
        ...asset,
        schedule: { start: '25:00', end: '06:00' },
      }),
    ).toThrow();
    expect(() =>
      analyzePowerHistory([], range, {
        ...asset,
        schedule: { start: '04:00', end: '04:00' },
      }),
    ).toThrow();
  });
  it.each(['invalid', '2026-99-99', '2026-02-30'])(
    'rejects invalid schedule effective dates %s',
    (effectiveFrom) => {
      expect(() =>
        analyzePowerHistory([], range, {
          ...asset,
          schedule: { start: '04:00', end: '06:00', effectiveFrom },
        }),
      ).toThrow('Invalid schedule effective date');
    },
  );
  it('formats a local date independently of the host timezone', () => {
    expect(localDateAt('2026-10-10T22:00:00Z', 'Europe/Sofia')).toBe(
      '2026-10-11',
    );
  });
});
describe('measurement source changes', () => {
  it('never integrates across replacement meters, even if readings are close together', () => {
    const from = '2026-10-11T01:00:00.000Z',
      to = '2026-10-11T01:10:00.000Z';
    const result = analyzePowerHistory(
      [
        { observedAt: from, powerW: 3000, seriesId: 'old' },
        {
          observedAt: '2026-10-11T01:05:00.000Z',
          powerW: 3000,
          seriesId: 'new',
        },
        { observedAt: to, powerW: 3000, seriesId: 'new' },
      ],
      { from, to },
      { timezone: 'UTC', activeThresholdW: 500 },
    );
    expect(result.summary.energyKwh).toBe(0.25);
    expect(result.summary.coveragePct).toBe(50);
  });
});
