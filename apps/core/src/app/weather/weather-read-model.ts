import type { WeatherEvidenceSnapshot } from './weather-investigator';
import { WEATHER_TIMEZONE } from './weather-calendar';
import type { WeatherEventType, WeatherSeverity } from './weather-investigator.types';

const HOUR_MS = 3_600_000;
const MAX_FORECAST_AGE_MS = 30 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const REQUIRED_HOURS = 24;

export interface StoredWeatherFinding {
  id: string;
  evidenceSnapshotId: string;
  eventType: WeatherEventType;
  startsAt: string | Date;
  endsAt: string | Date;
  location: string;
  severity: WeatherSeverity;
  confidence: 'low' | 'medium' | 'high';
  uncertainty: string;
  evidenceRefs: string[];
  consequences: string[];
  preparation: string[];
  explanationBg: string;
  provider: string;
  model: string;
  lastUpdatedAt: string | Date;
  notificationState: string;
}

export interface StoredWeatherSnapshot {
  id: string;
  capturedAt: string | Date;
  provider: string;
  model: string | null;
  location: string;
  evidence: WeatherEvidenceSnapshot | null;
}

export interface WeatherReadModel {
  version: 1;
  scope: { tenantId: string; siteId: string };
  generatedAt: string;
  status: 'available' | 'partial' | 'stale' | 'unavailable';
  quality: { reasons: Array<'no_snapshot' | 'invalid_source' | 'stale' | 'future_capture' | 'incomplete_24h'> };
  forecast: null | {
    capturedAt: string;
    provider: string;
    model: string | null;
    location: string;
    /** LAB forecast calendar timezone, provided by Core rather than inferred by the LLM. */
    timeZone: string;
    ageMinutes: number | null;
    coverage: { expectedHours: 24; validHours: number; complete: boolean };
    hours: WeatherEvidenceSnapshot['hours'];
  };
  /** Only active findings from a fresh, sufficiently complete source are actionable. */
  findings: StoredWeatherFinding[];
  officialAlerts: { status: 'unsupported'; explanation: string };
  automationEligible: false;
}

/** Projection of persisted investigator evidence, never a live provider request or an alert decision. */
export function buildWeatherReadModel(
  scope: { tenantId: string; siteId: string },
  stored: { findings: StoredWeatherFinding[]; latestForecast: StoredWeatherSnapshot | null },
  now = Date.now(),
): WeatherReadModel {
  const base = {
    version: 1 as const,
    scope,
    generatedAt: new Date(now).toISOString(),
    officialAlerts: {
      status: 'unsupported' as const,
      explanation: 'Официалните предупреждения не се поддържат от текущия метеорологичен източник.',
    },
    automationEligible: false as const,
  };
  const source = stored.latestForecast;
  if (!source) {
    return { ...base, status: 'unavailable', quality: { reasons: ['no_snapshot'] }, forecast: null, findings: [] };
  }

  const capturedMs = new Date(source.capturedAt).getTime();
  if (!Number.isFinite(capturedMs) ||
      (source.evidence?.siteId && source.evidence.siteId !== scope.siteId)) {
    return { ...base, status: 'unavailable', quality: { reasons: ['invalid_source'] }, forecast: null, findings: [] };
  }
  const timestamp = new Date(capturedMs).toISOString();
  const ageMs = now - capturedMs;
  const hours = Array.isArray(source.evidence?.hours)
    ? source.evidence.hours.filter((hour) =>
        hour && typeof hour.time === 'string' &&
        Number.isFinite(Date.parse(hour.time)),
      ).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(0, 73)
    : [];
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const hoursByTime = new Map(hours.map((hour) => [Date.parse(hour.time), hour]));
  const relevantHours = hours.filter((hour) => {
    const timestamp = Date.parse(hour.time);
    return timestamp >= currentHour && timestamp < currentHour + REQUIRED_HOURS * HOUR_MS;
  });
  const uniqueHours = new Set(relevantHours.map((hour) => hour.time)).size === relevantHours.length;
  let validHours = 0;
  for (let i = 0; i < REQUIRED_HOURS; i++) {
    const hour = hoursByTime.get(currentHour + i * HOUR_MS);
    if (
      !hour || !Number.isFinite(hour.precipitationMm) || hour.precipitationMm! < 0 ||
      !Number.isFinite(hour.rainProbabilityPercent) || hour.rainProbabilityPercent! < 0 ||
      hour.rainProbabilityPercent! > 100 || !Number.isFinite(hour.gustKmh) ||
      hour.gustKmh! < 0 || !Number.isInteger(hour.weatherCode)
    ) break;
    validHours++;
  }
  const complete = validHours === REQUIRED_HOURS && uniqueHours;
  const status = ageMs < -MAX_FUTURE_SKEW_MS || ageMs > MAX_FORECAST_AGE_MS
    ? 'stale' : complete ? 'available' : 'partial';
  const reasons: WeatherReadModel['quality']['reasons'] = [];
  if (ageMs < -MAX_FUTURE_SKEW_MS) reasons.push('future_capture');
  if (ageMs > MAX_FORECAST_AGE_MS) reasons.push('stale');
  if (!complete) reasons.push('incomplete_24h');
  const findings = status === 'available'
    ? stored.findings.filter((finding) =>
        Number.isFinite(Date.parse(String(finding.endsAt))) &&
        Date.parse(String(finding.endsAt)) > now &&
        finding.evidenceSnapshotId === source.id,
      )
    : [];
  return {
    ...base,
    status,
    quality: { reasons },
    forecast: {
      capturedAt: timestamp,
      provider: source.provider,
      model: source.model,
      location: source.location,
      timeZone: WEATHER_TIMEZONE,
      ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
      coverage: { expectedHours: REQUIRED_HOURS, validHours, complete },
      hours: status === 'available' ? hours : [],
    },
    findings,
  };
}
