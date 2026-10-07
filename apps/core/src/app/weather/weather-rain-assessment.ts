import { forecastWindow, WeatherSnapshot } from './weather-data-quality';

export type RainDuration = 'none' | 'passing' | 'intermittent' | 'prolonged' | 'all-day';

export interface RainAssessment {
  duration: RainDuration;
  headline: string;
  summary: string;
  totalMm: number;
  litersPerSquareMeter: number;
  maxHourlyMm: number;
  maxRainChance: number;
  wetHours: number;
  assessedHours: number;
  startsAt: string | null;
  endsAt: string | null;
}

const rainCodes = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

export function assessRain(snapshot: WeatherSnapshot): RainAssessment {
  const hours = forecastWindow(snapshot).slice(0, 24);
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
    duration: 'none',
    headline: 'Rain assessment unavailable',
    summary: 'Rain data is missing or stale.',
    totalMm: 0,
    litersPerSquareMeter: 0,
    maxHourlyMm: 0,
    maxRainChance: 0,
    wetHours: 0,
    assessedHours: 0,
    startsAt: null,
    endsAt: null,
  };
}

function isWetHour(hour: { precipitationMm: number | null; rainChance: number | null; weatherCode: number | null }): boolean {
  return (hour.precipitationMm ?? 0) >= 0.1 ||
    (hour.rainChance ?? 0) >= 50 ||
    rainCodes.has(hour.weatherCode ?? -1);
}

function rainDuration(wetHours: number, assessedHours: number): RainDuration {
  if (!wetHours) return 'none';
  if (wetHours <= 2) return 'passing';
  if (assessedHours >= 18 && wetHours / assessedHours >= 0.75) return 'all-day';
  if (wetHours >= 8) return 'prolonged';
  return 'intermittent';
}

function rainHeadline(duration: RainDuration): string {
  return ({
    none: 'No meaningful rain expected',
    passing: 'Passing rain possible',
    intermittent: 'Intermittent rain expected',
    prolonged: 'Long rain window expected',
    'all-day': 'Rain likely through most of the day',
  })[duration];
}

function rainSummary(duration: RainDuration, totalMm: number, wetHours: number, assessedHours: number): string {
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
