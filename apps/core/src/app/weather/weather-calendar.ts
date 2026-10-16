import { HOUR_MS } from './weather-data-quality';

export const WEATHER_TIMEZONE = 'Europe/Sofia';

export function weatherDate(
  instant: Date | number,
  timezone = WEATHER_TIMEZONE,
) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function validWeatherDate(value: string) {
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
  );
}

/** UTC boundaries of a local calendar day, including 23/25-hour DST days. */
export function weatherDayWindow(date: string, timezone = WEATHER_TIMEZONE) {
  if (!validWeatherDate(date)) throw new Error('Invalid weather calendar date');
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const hours = Array.from(
    { length: 50 },
    (_, i) => midnight + (i - 13) * HOUR_MS,
  ).filter((time) => weatherDate(time, timezone) === date);
  if (!hours.length) throw new Error('Weather day has no hourly boundaries');
  return {
    startsAt: new Date(hours[0]),
    endsAt: new Date(hours.at(-1)! + HOUR_MS),
    expectedHours: hours.length,
  };
}
