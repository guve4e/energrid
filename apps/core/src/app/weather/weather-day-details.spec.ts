import { buildDailyOutlook } from './weather-daily-outlook';
import { buildWeatherDayDetails } from './weather-day-details';
import {
  HOUR_MS,
  WeatherDay,
  WeatherHour,
  WeatherSnapshot,
} from './weather-data-quality';

const day = (date = '2026-10-10', rainTotalMm = 0): WeatherDay => ({
  date,
  rainTotalMm,
  tempMin: 10,
  tempMax: 20,
  rainChanceMax: 30,
  weatherCode: 3,
  condition: 'Overcast',
  windMaxKmh: 10,
  gustMaxKmh: 20,
});
const hour = (
  time: string,
  overrides: Partial<WeatherHour> = {},
): WeatherHour => ({
  time,
  temperature: 15,
  feelsLike: 14,
  humidity: 60,
  pressure: 1010,
  windKmh: 10,
  gustKmh: 20,
  rainChance: 30,
  precipitationMm: 0,
  rainMm: 0,
  showersMm: 0,
  weatherCode: 3,
  condition: 'Overcast',
  ...overrides,
});
const snapshot = (
  model: string,
  daily: WeatherDay[],
  hourly: WeatherHour[],
): WeatherSnapshot => ({
  model,
  daily,
  hourly,
  provider: 'open-meteo',
  availability: 'available',
  location: 'Vidin',
  coordinates: { latitude: 43.99, longitude: 22.87 },
  units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' },
  fetchedAt: '2026-10-10T10:00:00Z',
  current: hour('2026-10-10T10:00:00Z'),
  alerts: [],
});
function details(sources: WeatherSnapshot[]) {
  return buildWeatherDayDetails(
    buildDailyOutlook(sources[0], sources).days,
    sources,
  );
}

describe('reusable weather day details', () => {
  it("uses each day's cautious model and keeps the other model available for comparison", () => {
    const icon = snapshot(
      'icon',
      [day()],
      [hour('2026-10-10T10:00:00Z', { temperature: 25 })],
    );
    const gfs = snapshot(
      'gfs',
      [day('2026-10-10', 30)],
      [hour('2026-10-10T10:00:00Z', { precipitationMm: 5 })],
    );
    const [result] = details([icon, gfs]);
    expect(result.sourceModel).toBe('gfs');
    expect(result.hours[0].precipitationMm).toBe(5);
    expect(result.models.map((m) => m.rainTotalMm)).toEqual([0, 30]);
  });

  it("groups UTC hours by the forecast location's calendar date, including the previous UTC evening", () => {
    const source = snapshot(
      'icon',
      [day()],
      [
        hour('2026-10-09T20:00:00Z'),
        hour('2026-10-09T21:00:00Z'),
        hour('2026-10-10T20:00:00Z'),
        hour('2026-10-10T21:00:00Z'),
        hour('invalid'),
      ],
    );
    const [result] = details([source]);
    expect(result.hours.map((h) => h.time)).toEqual([
      '2026-10-09T21:00:00Z',
      '2026-10-10T20:00:00Z',
    ]);
    expect(result.coverage).toMatchObject({
      status: 'partial',
      availableHours: 2,
      expectedHours: 24,
    });
  });

  it.each([
    ['2026-03-29', '2026-03-28T22:00:00Z', 23],
    ['2026-10-25', '2026-10-24T21:00:00Z', 25],
  ] as const)(
    'counts actual hours on daylight-saving day %s',
    (date, start, count) => {
      const hours = Array.from({ length: count }, (_, i) =>
        hour(new Date(Date.parse(start) + i * HOUR_MS).toISOString()),
      );
      const [result] = details([snapshot('icon', [day(date)], hours)]);
      expect(result.coverage).toEqual({
        status: 'complete',
        availableHours: count,
        expectedHours: count,
        precipitationHours: count,
      });
    },
  );

  it('sorts and deduplicates hours and separates rain windows at dry or missing hours', () => {
    const hours = [
      hour('2026-10-10T03:00:00Z', { precipitationMm: 2, gustKmh: 40 }),
      hour('2026-10-10T00:00:00Z', { precipitationMm: 0.5 }),
      hour('2026-10-10T01:00:00Z', { precipitationMm: 1 }),
      hour('2026-10-10T00:00:00Z', { precipitationMm: 0.5 }),
      hour('2026-10-10T05:00:00Z', { precipitationMm: 0.2 }),
    ];
    const [result] = details([snapshot('icon', [day()], hours)]);
    expect(result.coverage.availableHours).toBe(4);
    expect(result.statistics).toMatchObject({
      wetHours: 4,
      maxHourlyMm: 2,
      peakRainAt: '2026-10-10T03:00:00Z',
      peakGustAt: '2026-10-10T03:00:00Z',
      meanHumidityPct: 60,
      meanPressureHpa: 1010,
      rainWindows: [
        {
          startsAt: '2026-10-10T00:00:00Z',
          endsAt: '2026-10-10T02:00:00.000Z',
        },
        {
          startsAt: '2026-10-10T03:00:00Z',
          endsAt: '2026-10-10T04:00:00.000Z',
        },
        {
          startsAt: '2026-10-10T05:00:00Z',
          endsAt: '2026-10-10T06:00:00.000Z',
        },
      ],
    });
  });

  it('distinguishes zero rainfall from missing rainfall and excludes padded empty hours', () => {
    const missing = hour('2026-10-10T01:00:00Z', {
      precipitationMm: null,
      humidity: null,
      pressure: null,
    });
    const empty = Object.fromEntries(
      Object.keys(missing).map((key) => [
        key,
        key === 'time' ? '2026-10-10T02:00:00Z' : null,
      ]),
    ) as unknown as WeatherHour;
    const [result] = details([snapshot('icon', [day()], [missing, empty])]);
    expect(result.coverage).toMatchObject({
      status: 'partial',
      availableHours: 1,
      precipitationHours: 0,
    });
    expect(result.statistics).toMatchObject({
      wetHours: null,
      maxHourlyMm: null,
      peakRainAt: null,
      meanHumidityPct: null,
    });
    const [dry] = details([
      snapshot('icon', [day()], [hour('2026-10-10T00:00:00Z')]),
    ]);
    expect(dry.statistics).toMatchObject({
      wetHours: 0,
      maxHourlyMm: 0,
      peakRainAt: null,
      rainWindows: [],
    });
  });

  it("does not borrow another model's hours when the chosen model only has daily data", () => {
    const icon = snapshot('icon', [day()], [hour('2026-10-10T10:00:00Z')]);
    const gfs = snapshot('gfs', [day('2026-10-10', 30)], []);
    const [result] = details([icon, gfs]);
    expect(result.coverage.status).toBe('unavailable');
    expect(result.hours).toEqual([]);
    expect(result.statistics.wetHours).toBeNull();
  });

  it('supports another forecast timezone and ignores unavailable model comparisons', () => {
    const source = snapshot(
      'icon',
      [day()],
      [hour('2026-10-10T01:00:00Z'), hour('2026-10-10T09:00:00Z')],
    );
    const offline = {
      ...source,
      model: 'offline',
      availability: 'unavailable' as const,
    };
    const result = buildWeatherDayDetails(
      buildDailyOutlook(source, [source]).days,
      [source, offline],
      'America/New_York',
    )[0];
    expect(result.hours.map((h) => h.time)).toEqual(['2026-10-10T09:00:00Z']);
    expect(result.models).toHaveLength(1);
  });
  it('rejects malformed calendar dates without failing the whole dashboard', () => {
    const source = snapshot(
      'icon',
      [day('invalid'), day('2026-02-30'), day()],
      [],
    );
    expect(details([source]).map((result) => result.date)).toEqual([
      '2026-10-10',
    ]);
  });
});
