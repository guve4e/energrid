import { HOUR_MS } from './weather-data-quality';
import {
  validWeatherDate,
  weatherDate,
  weatherDayWindow,
  WEATHER_TIMEZONE,
} from './weather-calendar';

export const STATION_DAILY_METRICS = [
  'precipitation_mm',
  'gust_kmh',
  'temperature_min_c',
  'temperature_max_c',
] as const;
export type StationDailyMetric = (typeof STATION_DAILY_METRICS)[number];
export interface MeteostatDay {
  date?: unknown;
  prcp?: unknown;
  wpgt?: unknown;
  tmin?: unknown;
  tmax?: unknown;
}
export interface StationDailyObservation {
  date: string;
  metric: StationDailyMetric;
  value: number;
  timezone: string;
  periodBasis: 'unverified' | 'local-calendar-day';
  startsAt: string | null;
  endsAt: string | null;
  periodReference: string | null;
  original: MeteostatDay;
}

export function dailyPeriodConfiguration(env = process.env) {
  const reference = env.METEOSTAT_DAILY_PERIOD_REFERENCE?.trim();
  return env.METEOSTAT_DAILY_PERIOD_VERIFIED === 'true' &&
    env.METEOSTAT_DAILY_TIMEZONE === WEATHER_TIMEZONE &&
    reference
    ? { verified: true, reference, timezone: WEATHER_TIMEZONE }
    : { verified: false, reference: null, timezone: WEATHER_TIMEZONE };
}

export function meteostatDailyObservations(
  rows: MeteostatDay[],
  now: Date,
  period = dailyPeriodConfiguration(),
  stationTimezone = WEATHER_TIMEZONE,
): StationDailyObservation[] {
  const results = new Map<string, StationDailyObservation>();
  const verified = period.verified && stationTimezone === period.timezone;
  for (const row of rows) {
    if (
      !row ||
      typeof row.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}( 00:00:00)?$/.test(row.date)
    )
      continue;
    const date = row.date.slice(0, 10);
    if (
      !validWeatherDate(date) ||
      date >= weatherDate(now) ||
      Date.parse(date) < Date.parse(weatherDate(now)) - 30 * 24 * HOUR_MS
    )
      continue;
    if (
      typeof row.tmin === 'number' &&
      typeof row.tmax === 'number' &&
      row.tmin > row.tmax
    )
      throw new Error('Invalid station daily temperature range');
    const window = verified ? weatherDayWindow(date, period.timezone) : null;
    for (const [metric, value] of [
      ['precipitation_mm', row.prcp],
      ['gust_kmh', row.wpgt],
      ['temperature_min_c', row.tmin],
      ['temperature_max_c', row.tmax],
    ] as const) {
      const temperature = metric.startsWith('temperature_');
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (temperature ? value < -100 || value > 70 : value < 0 || value > 1000)
      )
        continue;
      const key = `${date}:${metric}`;
      if (results.has(key) && results.get(key)!.value !== value)
        throw new Error('Conflicting station daily observations');
      results.set(key, {
        date,
        metric,
        value,
        timezone: stationTimezone,
        periodBasis: verified ? 'local-calendar-day' : 'unverified',
        startsAt: window?.startsAt.toISOString() ?? null,
        endsAt: window?.endsAt.toISOString() ?? null,
        periodReference: verified ? period.reference : null,
        original: row,
      });
    }
  }
  return [...results.values()];
}
