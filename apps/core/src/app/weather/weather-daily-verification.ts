import { buildDailyOutlook } from './weather-daily-outlook';
import {
  assessWeather,
  HOUR_MS,
  WeatherDay,
  WeatherSnapshot,
} from './weather-data-quality';
import {
  validWeatherDate,
  weatherDate,
  weatherDayWindow,
  WEATHER_TIMEZONE,
} from './weather-calendar';

export const DAILY_POLICY_VERSION = 'daily-cautious:weather-v1';
export const DAILY_METRICS = [
  'precipitation_mm',
  'gust_kmh',
  'temperature_min_c',
  'temperature_max_c',
] as const;
export type DailyVerificationMetric = (typeof DAILY_METRICS)[number];

export interface DailyPrediction {
  location: string;
  provider: string;
  modelVersion: string;
  issuedAt: Date;
  issuedHour: Date;
  targetDate: string;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  leadDays: number;
  metric: DailyVerificationMetric;
  predicted: number;
  input: {
    sourceModel: string | null;
    fetchedAt: string;
    day: WeatherDay;
    agreement?: string;
    selectionReason?: string;
  };
}

export function dailyPredictions(
  snapshots: WeatherSnapshot[],
  selected: WeatherSnapshot,
  now = new Date(),
): DailyPrediction[] {
  const usable = [
    ...new Map(
      snapshots
        .filter(
          (s) => s.model && assessWeather(s, now.getTime()).forecastUsable,
        )
        .map((s) => [`${s.provider}:${s.model}`, s]),
    ).values(),
  ];
  const today = weatherDate(now);
  const issuedHour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const predictions: DailyPrediction[] = [];
  const add = (
    snapshot: WeatherSnapshot,
    day: WeatherDay,
    provider: string,
    modelVersion: string,
    extra: { agreement?: string; selectionReason?: string } = {},
  ) => {
    if (!validWeatherDate(day.date)) return;
    const leadDays =
      (Date.parse(day.date) - Date.parse(today)) / (24 * HOUR_MS);
    if (leadDays < 1 || leadDays > 10) return;
    const window = weatherDayWindow(day.date);
    if (window.startsAt <= now) return;
    for (const [metric, value] of [
      ['precipitation_mm', day.rainTotalMm],
      ['gust_kmh', day.gustMaxKmh],
      ['temperature_min_c', day.tempMin],
      ['temperature_max_c', day.tempMax],
    ] as const) {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (metric.startsWith('temperature_')
          ? value < -100 || value > 70
          : value < 0)
      )
        continue;
      predictions.push({
        location: `${snapshot.coordinates.latitude.toFixed(5)},${snapshot.coordinates.longitude.toFixed(5)}`,
        provider,
        modelVersion,
        issuedAt: now,
        issuedHour,
        targetDate: day.date,
        timezone: WEATHER_TIMEZONE,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        leadDays,
        metric,
        predicted: value,
        input: {
          sourceModel: snapshot.model ?? null,
          fetchedAt: snapshot.fetchedAt,
          day,
          ...extra,
        },
      });
    }
  };
  for (const snapshot of usable) {
    for (const day of snapshot.daily)
      add(
        snapshot,
        day,
        snapshot.provider,
        `${snapshot.model}:weather-daily-v1`,
      );
  }
  // Save the policy actually used by daily cards, not the globally selected model's entire outlook.
  for (const day of buildDailyOutlook(selected, snapshots, 12).days) {
    const source = usable.find(
      (s) => s.provider === day.sourceProvider && s.model === day.sourceModel,
    );
    if (source)
      add(source, day, 'energrid', DAILY_POLICY_VERSION, {
        agreement: day.agreement,
        selectionReason: day.selectionReason,
      });
  }
  return predictions;
}

export interface IntervalMeasurement {
  id: string;
  observedAt: string;
  windowStartAt: string;
  value: number;
}

/** Missing or misaligned intervals must never become a smaller daily total or a zero. */
export function measuredDailyValue(
  metric: 'precipitation_mm' | 'gust_kmh',
  startsAt: Date,
  endsAt: Date,
  observations: IntervalMeasurement[],
) {
  const expected = (endsAt.getTime() - startsAt.getTime()) / HOUR_MS;
  if (
    !Number.isInteger(expected) ||
    expected < 23 ||
    expected > 25 ||
    observations.length !== expected
  )
    return null;
  const sorted = [...observations].sort(
    (a, b) => Date.parse(a.windowStartAt) - Date.parse(b.windowStartAt),
  );
  for (const [i, observation] of sorted.entries()) {
    const start = startsAt.getTime() + i * HOUR_MS;
    if (
      Date.parse(observation.windowStartAt) !== start ||
      Date.parse(observation.observedAt) !== start + HOUR_MS ||
      !Number.isFinite(observation.value) ||
      observation.value < 0
    )
      return null;
  }
  const values = sorted.map((o) => o.value);
  return {
    value:
      metric === 'precipitation_mm'
        ? values.reduce((a, b) => a + b, 0)
        : Math.max(...values),
    observationIds: sorted.map((o) => o.id),
    hours: expected,
  };
}
