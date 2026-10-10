import {
  DailyOutlookDay,
  isPopulatedDailyForecast,
} from './weather-daily-outlook';
import {
  HOUR_MS,
  WeatherDay,
  WeatherHour,
  WeatherSnapshot,
} from './weather-data-quality';

export interface WeatherDayDetails {
  date: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  sourceProvider: string;
  sourceModel: string | null;
  hours: WeatherHour[];
  coverage: {
    status: 'complete' | 'partial' | 'unavailable';
    availableHours: number;
    expectedHours: number;
    precipitationHours: number;
  };
  statistics: {
    wetHours: number | null;
    maxHourlyMm: number | null;
    peakRainAt: string | null;
    peakGustAt: string | null;
    meanHumidityPct: number | null;
    meanPressureHpa: number | null;
    rainWindows: Array<{ startsAt: string; endsAt: string }>;
  };
  models: Array<WeatherDay & { provider: string; model: string | null }>;
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const fields = [
  'temperature',
  'feelsLike',
  'humidity',
  'pressure',
  'windKmh',
  'gustKmh',
  'rainChance',
  'precipitationMm',
  'weatherCode',
] as const;

/** Each day's detail follows its chosen model, independently of the current-weather selection. */
export function buildWeatherDayDetails(
  days: DailyOutlookDay[],
  snapshots: WeatherSnapshot[],
  timezone = 'Europe/Sofia',
): WeatherDayDetails[] {
  const dateFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = (instant: number) => dateFormat.format(new Date(instant));
  const sources = [
    ...new Map(
      snapshots
        .filter((s) => s.availability === 'available')
        .map((s) => [`${s.provider}:${s.model ?? ''}`, s]),
    ).values(),
  ];

  return days
    .filter((day) => validCalendarDate(day.date))
    .map((day) => {
      const source = sources.find(
        (s) =>
          s.provider === day.sourceProvider &&
          (s.model ?? null) === day.sourceModel,
      );
      const hours = [
        ...new Map(
          (source?.hourly ?? [])
            .filter((hour) => {
              const instant = Date.parse(hour.time ?? '');
              return (
                Number.isFinite(instant) &&
                localDate(instant) === day.date &&
                fields.some((field) => finite(hour[field]))
              );
            })
            .map((hour) => [Date.parse(hour.time!), hour]),
        ).values(),
      ].sort((a, b) => Date.parse(a.time!) - Date.parse(b.time!));
      // Counting actual local-day instants also handles 23/25-hour daylight-saving days.
      const midnight = Date.parse(`${day.date}T00:00:00Z`);
      const instants = Array.from(
        { length: 50 },
        (_, i) => midnight + (i - 13) * HOUR_MS,
      ).filter((instant) => localDate(instant) === day.date);
      const expectedHours = instants.length;
      const precipitation = hours.filter(
        (hour) => finite(hour.precipitationMm) && hour.precipitationMm >= 0,
      );
      const wet = precipitation.filter((hour) => hour.precipitationMm! >= 0.1);
      const peakRain = peak(precipitation, 'precipitationMm');
      const peakGust = peak(hours, 'gustKmh');
      const rainWindows: WeatherDayDetails['statistics']['rainWindows'] = [];
      for (const hour of wet) {
        const start = hour.time!;
        const end = new Date(Date.parse(start) + HOUR_MS).toISOString();
        const previous = rainWindows.at(-1);
        if (previous && Date.parse(previous.endsAt) === Date.parse(start))
          previous.endsAt = end;
        else rainWindows.push({ startsAt: start, endsAt: end });
      }
      return {
        date: day.date,
        timezone,
        startsAt: new Date(instants[0]).toISOString(),
        endsAt: new Date(instants.at(-1)! + HOUR_MS).toISOString(),
        sourceProvider: day.sourceProvider,
        sourceModel: day.sourceModel,
        hours,
        coverage: {
          status: !hours.length
            ? 'unavailable'
            : hours.length === expectedHours &&
                hours.every((hour) =>
                  fields.every((field) => finite(hour[field])),
                )
              ? 'complete'
              : 'partial',
          availableHours: hours.length,
          expectedHours,
          precipitationHours: precipitation.length,
        },
        statistics: {
          wetHours: precipitation.length ? wet.length : null,
          maxHourlyMm: peakRain?.precipitationMm ?? null,
          peakRainAt:
            peakRain && peakRain.precipitationMm! > 0 ? peakRain.time : null,
          peakGustAt: peakGust?.time ?? null,
          meanHumidityPct: mean(hours.map((hour) => hour.humidity)),
          meanPressureHpa: mean(hours.map((hour) => hour.pressure)),
          rainWindows,
        },
        models: sources.flatMap((s) => {
          const forecast = s.daily.find((d) => d.date === day.date);
          return forecast && isPopulatedDailyForecast(forecast)
            ? [{ ...forecast, provider: s.provider, model: s.model ?? null }]
            : [];
        }),
      };
    });
}

function peak(hours: WeatherHour[], field: 'precipitationMm' | 'gustKmh') {
  return hours
    .filter((hour) => finite(hour[field]) && hour[field]! >= 0)
    .reduce<WeatherHour | null>(
      (best, hour) => (!best || hour[field]! > best[field]! ? hour : best),
      null,
    );
}

function mean(values: Array<number | null>) {
  const available = values.filter(finite);
  return available.length
    ? Math.round(
        (available.reduce((sum, value) => sum + value, 0) / available.length) *
          10,
      ) / 10
    : null;
}

function validCalendarDate(value: string) {
  const instant = Date.parse(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(instant) &&
    new Date(instant).toISOString().slice(0, 10) === value
  );
}
