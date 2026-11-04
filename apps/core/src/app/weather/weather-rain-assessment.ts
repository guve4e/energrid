import { forecastWindow, HOUR_MS, WeatherHour, WeatherSnapshot } from './weather-data-quality';

export type RainDuration = 'unknown' | 'none' | 'passing' | 'intermittent' | 'prolonged' | 'all-day';

export interface RainAssessment {
  duration: RainDuration;
  headline: string;
  summary: string;
  totalMm: number | null;
  litersPerSquareMeter: number | null;
  maxHourlyMm: number | null;
  maxRainChance: number | null;
  wetHours: number;
  assessedHours: number;
  startsAt: string | null;
  endsAt: string | null;
}

const WINDOW_HOURS = 24;
const rainCodes = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

export function assessRain(snapshot: WeatherSnapshot): RainAssessment {
  const now = Date.now();
  const hours = forecastWindow(snapshot, now).slice(0, WINDOW_HOURS);
  const windowStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  // A seven-hour risk forecast can be usable while its 24-hour rainfall outlook is not.
  // Require every expected hourly slot; missing data must never become a zero-rain claim.
  const assessedHours = hours.findIndex((hour, index) =>
    Date.parse(hour.time ?? '') !== windowStart + index * HOUR_MS || !hasRainData(hour));
  const consecutiveHours = assessedHours === -1 ? hours.length : assessedHours;
  if (consecutiveHours !== WINDOW_HOURS || hours.length !== WINDOW_HOURS) {
    return {
      ...unavailableRainAssessment(),
      headline: 'Incomplete 24-hour rain outlook',
      summary: `Only ${consecutiveHours} of 24 consecutive forecast hours have valid rain data. The next 24 hours cannot be classified as dry.`,
      assessedHours: consecutiveHours,
    };
  }

  const wetHours = hours.filter(isWetHour);
  const totalMm = sum(hours.map((hour) => hour.precipitationMm));
  const maxHourlyMm = max(hours.map((hour) => hour.precipitationMm));
  const maxRainChance = max(hours.map((hour) => hour.rainChance));
  const duration = rainDuration(wetHours.length, hours.length);

  return {
    duration,
    headline: rainHeadline(duration),
    summary: rainSummary(duration, totalMm, wetHours.length, hours.length),
    totalMm,
    litersPerSquareMeter: totalMm,
    maxHourlyMm,
    maxRainChance,
    wetHours: wetHours.length,
    assessedHours: hours.length,
    startsAt: wetHours[0]?.time ?? null,
    endsAt: wetHours[wetHours.length - 1]?.time ?? null,
  };
}

export function unavailableRainAssessment(): RainAssessment {
  return {
    duration: 'unknown',
    headline: 'Rain assessment unavailable',
    summary: 'Rain data is missing or stale.',
    totalMm: null,
    litersPerSquareMeter: null,
    maxHourlyMm: null,
    maxRainChance: null,
    wetHours: 0,
    assessedHours: 0,
    startsAt: null,
    endsAt: null,
  };
}

function hasRainData(hour: WeatherHour): boolean {
  return Number.isFinite(hour.precipitationMm) && hour.precipitationMm! >= 0 &&
    Number.isFinite(hour.rainChance) && hour.rainChance! >= 0 && hour.rainChance! <= 100;
}

function isWetHour(hour: WeatherHour): boolean {
  return hour.precipitationMm! >= 0.1 || hour.rainChance! >= 50 ||
    rainCodes.has(hour.weatherCode ?? -1);
}

function rainDuration(wetHours: number, assessedHours: number): Exclude<RainDuration, 'unknown'> {
  if (!wetHours) return 'none';
  if (wetHours <= 2) return 'passing';
  if (assessedHours >= 18 && wetHours / assessedHours >= 0.75) return 'all-day';
  if (wetHours >= 8) return 'prolonged';
  return 'intermittent';
}

function rainHeadline(duration: Exclude<RainDuration, 'unknown'>): string {
  return ({
    none: 'No meaningful rain expected',
    passing: 'Passing rain possible',
    intermittent: 'Intermittent rain expected',
    prolonged: 'Long rain window expected',
    'all-day': 'Rain likely through most of the day',
  })[duration];
}

function rainSummary(duration: Exclude<RainDuration, 'unknown'>, totalMm: number, wetHours: number, assessedHours: number): string {
  if (duration === 'none') return 'No measurable rain is expected in the next 24 hours.';
  const amount = `${round(totalMm)} mm (${round(totalMm)} L/m²)`;
  return `${amount} over ${wetHours} of ${assessedHours} forecast hours.`;
}

function max(values: Array<number | null | undefined>) {
  const clean = values.filter((value): value is number => typeof value === 'number');
  return clean.length ? Math.max(...clean) : 0;
}

function sum(values: Array<number | null | undefined>) {
  return round(values.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0));
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
