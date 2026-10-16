import { HOUR_MS } from './weather-data-quality';
import type { WeatherObservation } from './weather-verification.service';
import { dailyPeriodConfiguration } from './weather-station-daily';

export function weatherObservationMode(env = process.env): 'hourly' | 'daily' {
  return env.METEOSTAT_GRANULARITY === 'daily' ? 'daily' : 'hourly';
}

export function weatherObservationSource(env = process.env) {
  if (env.WEATHER_OBSERVATION_PROVIDER === 'meteostat') {
    const station = env.METEOSTAT_STATION_ID ?? '';
    const label = env.METEOSTAT_INTERVAL_LABEL;
    if (weatherObservationMode(env) === 'daily') {
      const period = dailyPeriodConfiguration(env);
      return /^[A-Za-z0-9]{5}$/.test(station)
        ? `meteostat:${station}:daily-${period.verified ? 'local-Europe-Sofia-v1' : 'unverified'}`
        : '';
    }
    return /^[A-Za-z0-9]{5}$/.test(station) &&
      (label === 'start' || label === 'end')
      ? `meteostat:${station}:hourly-${label}`
      : '';
  }
  return env.WEATHER_OBSERVATION_SOURCE ?? '';
}

export interface MeteostatHour {
  time?: unknown;
  temp?: unknown;
  prcp?: unknown;
  wpgt?: unknown;
}

export function meteostatObservations(
  rows: MeteostatHour[],
  label: 'start' | 'end',
  now: Date,
) {
  const readings = new Map<string, WeatherObservation>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.time !== 'string' ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(row.time)
    )
      continue;
    const time = Date.parse(`${row.time.replace(' ', 'T')}Z`);
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 19).replace('T', ' ') !== row.time
    )
      continue;
    const end = label === 'end' ? time : time + HOUR_MS;
    for (const [metric, value, instant] of [
      ['temperature_c', row.temp, time],
      ['precipitation_mm', row.prcp, end],
      ['gust_kmh', row.wpgt, end],
    ] as const) {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        instant > now.getTime() ||
        instant < now.getTime() - 30 * 24 * HOUR_MS ||
        (metric === 'temperature_c'
          ? value < -100 || value > 70
          : value < 0 || value > 1000)
      )
        continue;
      const observation: WeatherObservation = {
        metric,
        value,
        observedAt: new Date(instant).toISOString(),
        ...(metric === 'temperature_c'
          ? {}
          : { windowStartAt: new Date(end - HOUR_MS).toISOString() }),
      };
      const key = `${metric}:${instant}`;
      if (readings.has(key) && readings.get(key)!.value !== value)
        throw new Error('Conflicting station observations');
      readings.set(key, observation);
    }
  }
  return [...readings.values()];
}

export function stationDistanceKm(latitude: number, longitude: number) {
  const radians = (n: number) => (n * Math.PI) / 180;
  const a =
    Math.sin(radians(latitude - 43.9916) / 2) ** 2 +
    Math.cos(radians(latitude)) *
      Math.cos(radians(43.9916)) *
      Math.sin(radians(longitude - 22.8728) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
