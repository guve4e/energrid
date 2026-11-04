import { WeatherSnapshot } from './weather-data-quality';
import { WeatherEventType, WeatherFinding } from './weather-investigator.types';

export interface WeatherEvidenceSnapshot {
  siteId: string;
  capturedAt: string;
  provider: string;
  model: string | null;
  location: string;
  coordinates: WeatherSnapshot['coordinates'];
  alertsAvailable: boolean;
  alerts: unknown[];
  hours: Array<{
    id: string;
    time: string;
    temperatureC: number | null;
    rainProbabilityPercent: number | null;
    precipitationMm: number | null;
    windKmh: number | null;
    gustKmh: number | null;
    weatherCode: number | null;
  }>;
}

export function buildWeatherEvidence(
  snapshot: WeatherSnapshot,
  siteId: string,
  now = Date.now(),
): WeatherEvidenceSnapshot {
  const start = Math.floor(now / 3_600_000) * 3_600_000;
  return {
    siteId,
    capturedAt: snapshot.fetchedAt,
    provider: snapshot.provider,
    model: snapshot.model ?? null,
    location: snapshot.location,
    coordinates: snapshot.coordinates,
    // Open-Meteo forecast does not provide official alert coverage here.
    alertsAvailable: false,
    alerts: [],
    hours: snapshot.hourly
      .filter(
        (hour) =>
          Date.parse(hour.time ?? '') >= start &&
          Date.parse(hour.time ?? '') <= start + 72 * 3_600_000,
      )
      .sort((a, b) => Date.parse(a.time ?? '') - Date.parse(b.time ?? ''))
      .map((hour) => ({
        id: `hour:${hour.time}`,
        time: hour.time!,
        temperatureC: hour.temperature,
        rainProbabilityPercent: hour.rainChance,
        precipitationMm: hour.precipitationMm,
        windKmh: hour.windKmh,
        gustKmh: hour.gustKmh,
        weatherCode: hour.weatherCode,
      })),
  };
}

export interface WeatherInvestigatorProvider {
  readonly id: string;
  investigate(
    evidence: WeatherEvidenceSnapshot,
    previous: WeatherEvidenceSnapshot | null,
  ): Promise<{ findings: WeatherFinding[]; summary: string; model: string; inferenceProvider?: string }>;
}

/** Calls the LAB API's provider-independent LLM gateway with a minimized payload. */
export class ApiWeatherInvestigatorProvider implements WeatherInvestigatorProvider {
  readonly id = 'llm-gateway';
  constructor(private readonly endpoint = process.env.ENERGRID_API_URL || 'http://127.0.0.1:3000') {}

  async investigate(evidence: WeatherEvidenceSnapshot, previous: WeatherEvidenceSnapshot | null) {
    const token = process.env.WEATHER_INVESTIGATOR_API_TOKEN?.trim();
    const opaqueSiteId = process.env.WEATHER_INVESTIGATOR_OPAQUE_SITE_ID?.trim();
    const authorizedSiteId = process.env.WEATHER_INVESTIGATOR_SITE_ID || 'lab-default';
    if (process.env.ENERGRID_LAB_MODE !== 'true' || !token || !opaqueSiteId || evidence.siteId !== authorizedSiteId)
      throw new Error('LAB weather inference bridge is not configured');
    const minimize = (snapshot: WeatherEvidenceSnapshot | null) => snapshot && ({
      siteId: opaqueSiteId,
      capturedAt: snapshot.capturedAt,
      provider: snapshot.provider,
      model: snapshot.model,
      location: 'около инсталацията',
      coordinates: { latitude: Math.round(snapshot.coordinates.latitude * 100) / 100, longitude: Math.round(snapshot.coordinates.longitude * 100) / 100 },
      alertsAvailable: snapshot.alertsAvailable,
      alerts: [],
      hours: snapshot.hours,
    });
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/weather/investigator/infer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: opaqueSiteId, evidence: minimize(evidence), previous: minimize(previous) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Weather inference gateway unavailable');
    const result = await response.json() as { findings: WeatherFinding[]; summary: string; model: string; inferenceProvider: string };
    if (!Array.isArray(result.findings) || typeof result.summary !== 'string' || typeof result.model !== 'string')
      throw new Error('Invalid structured response from weather inference gateway');
    // The local site label never leaves Core and is restored only after inference.
    return { ...result, findings: result.findings.map((finding) => ({ ...finding, location: evidence.location })) };
  }
}

export function materiallyChangedForecast(
  current: WeatherEvidenceSnapshot,
  previous: WeatherEvidenceSnapshot | null,
): boolean {
  if (!previous) return false;
  const old = new Map(previous.hours.map((hour) => [hour.time, hour]));
  return current.hours.some((hour) => {
    const prior = old.get(hour.time);
    if (!prior) return false;
    return (
      (hour.temperatureC !== null &&
        prior.temperatureC !== null &&
        Math.abs(hour.temperatureC - prior.temperatureC) >= 5) ||
      (hour.rainProbabilityPercent !== null &&
        prior.rainProbabilityPercent !== null &&
        Math.abs(hour.rainProbabilityPercent - prior.rainProbabilityPercent) >=
          25) ||
      (hour.precipitationMm !== null &&
        prior.precipitationMm !== null &&
        Math.abs(hour.precipitationMm - prior.precipitationMm) >= 5) ||
      (hour.gustKmh !== null &&
        prior.gustKmh !== null &&
        Math.abs(hour.gustKmh - prior.gustKmh) >= 20) ||
      (hour.weatherCode !== null &&
        prior.weatherCode !== null &&
        hour.weatherCode !== prior.weatherCode)
    );
  });
}

const validEvents: WeatherEventType[] = [
  'rain',
  'snow',
  'freeze',
  'wind',
  'thunderstorm',
  'hail',
  'official_warning',
];
const validSeverity = ['low', 'moderate', 'high', 'severe'] as const;
const severityRank: Record<WeatherFinding['severity'], number> = {
  low: 1,
  moderate: 2,
  high: 3,
  severe: 4,
};
const hourMs = 3_600_000;
type EvidenceHour = WeatherEvidenceSnapshot['hours'][number];

/** Conservative forecast-only limits, not calibrated warning thresholds. */
function supportedForecastSeverity(
  eventType: WeatherEventType,
  hour: EvidenceHour,
  uncertainty: string,
): WeatherFinding['severity'] | null {
  switch (eventType) {
    case 'rain':
      return (hour.rainProbabilityPercent ?? 0) >= 30 &&
        (hour.precipitationMm ?? 0) > 0 ? 'low' : null;
    case 'snow':
      return [71, 73, 75, 77, 85, 86].includes(hour.weatherCode ?? -1)
        ? 'moderate' : null;
    case 'freeze':
      return hour.temperatureC !== null && hour.temperatureC <= 0
        ? 'moderate' : null;
    case 'wind': {
      const wind = hour.gustKmh ?? hour.windKmh;
      return wind !== null && wind >= 70 ? 'high'
        : wind !== null && wind >= 50 ? 'moderate' : null;
    }
    case 'thunderstorm':
      return [95, 96, 99].includes(hour.weatherCode ?? -1) ? 'high' : null;
    case 'hail':
      return [96, 99].includes(hour.weatherCode ?? -1) &&
        /възмож|потенциал|несигур/iu.test(uncertainty) ? 'moderate' : null;
    // There is no normalized, authoritative alert evidence contract yet.
    case 'official_warning':
      return null;
  }
}

export function validateWeatherFindings(
  raw: unknown,
  evidence: WeatherEvidenceSnapshot,
): WeatherFinding[] {
  if (!Array.isArray(raw))
    throw new Error('Investigator findings must be an array');
  const ids = new Set(evidence.hours.map((hour) => hour.id));
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid finding');
    const finding = item as Record<string, unknown>;
    const start = Date.parse(String(finding.startsAt ?? ''));
    const end = Date.parse(String(finding.endsAt ?? ''));
    const refs = finding.evidenceRefs;
    if (
      !validEvents.includes(finding.eventType as WeatherEventType) ||
      !validSeverity.includes(
        finding.severity as (typeof validSeverity)[number],
      ) ||
      !['low', 'medium', 'high'].includes(String(finding.confidence)) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      start < Date.parse(evidence.hours[0]?.time ?? '') ||
      end >
        Date.parse(evidence.hours[evidence.hours.length - 1]?.time ?? '') +
          3_600_000 ||
      finding.location !== evidence.location ||
      !Array.isArray(refs) ||
      refs.length === 0 ||
      refs.some((ref) => typeof ref !== 'string' || !ids.has(ref)) ||
      typeof finding.uncertainty !== 'string' ||
      typeof finding.bulgarianExplanation !== 'string' ||
      !Array.isArray(finding.consequences) ||
      !Array.isArray(finding.preparation)
    ) {
      throw new Error(
        'Finding failed schema, location, forecast-window, or evidence validation',
      );
    }
    if (finding.eventType === 'official_warning') {
      throw new Error('An official warning requires verified authoritative alert evidence');
    }
    // These uncalibrated forecasts do not justify medium/high confidence labels.
    if (finding.confidence !== 'low') {
      throw new Error('Forecast confidence is not calibrated for elevated claims');
    }
    const citedIds = new Set(refs as string[]);
    if (citedIds.size !== refs.length) {
      throw new Error('Finding contains duplicate evidence references');
    }
    const overlappingHours = evidence.hours
      .filter((hour) => {
        const time = Date.parse(hour.time);
        return Number.isFinite(time) && time < end && time + hourMs > start;
      })
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    // Every hour in the claimed interval must be both cited and supportive.
    // An absent hour is unknown, not evidence that the event persists.
    let coveredUntil = start;
    for (const hour of overlappingHours) {
      const time = Date.parse(hour.time);
      if (time > coveredUntil || !citedIds.has(hour.id)) {
        throw new Error('Finding event window has missing or uncited forecast evidence');
      }
      const supportedSeverity = supportedForecastSeverity(
        finding.eventType as WeatherEventType,
        hour,
        finding.uncertainty as string,
      );
      if (!supportedSeverity ||
        severityRank[finding.severity as WeatherFinding['severity']] > severityRank[supportedSeverity]) {
        throw new Error('Finding severity is not supported by cited weather measurements');
      }
      coveredUntil = Math.max(coveredUntil, time + hourMs);
    }
    if (coveredUntil < end ||
      (refs as string[]).some((id) => !overlappingHours.some((hour) => hour.id === id))) {
      throw new Error('Finding evidence lies outside or does not cover its event window');
    }
    const narrative = [finding.uncertainty, finding.bulgarianExplanation, ...(Array.isArray(finding.consequences) ? finding.consequences : []), ...(Array.isArray(finding.preparation) ? finding.preparation : [])].join(' ')
      .replace(/(?:не е|няма) официално предупреждение/giu, '');
    if (finding.eventType !== 'official_warning' && /официалн\w*\s+предупрежден/iu.test(narrative))
      throw new Error('A forecast finding cannot be described as an official weather warning');
    return finding as unknown as WeatherFinding;
  });
}

/** Offline LAB provider used for repeatable development and deterministic tests. */
export class FixtureWeatherInvestigatorProvider
  implements WeatherInvestigatorProvider
{
  readonly id = 'fixture';
  async investigate(
    evidence: WeatherEvidenceSnapshot,
    previous: WeatherEvidenceSnapshot | null,
  ) {
    const changed = materiallyChangedForecast(evidence, previous);
    const findings: WeatherFinding[] = [];
    const groups: Array<{
      eventType: WeatherEventType;
      match: (hour: WeatherEvidenceSnapshot['hours'][number]) => boolean;
      severity: WeatherFinding['severity'];
      text: string;
    }> = [
      {
        eventType: 'snow',
        match: (h) => [71, 73, 75, 77, 85, 86].includes(h.weatherCode ?? -1),
        severity: 'moderate',
        text: 'се очаква снеговалеж',
      },
      {
        eventType: 'thunderstorm',
        match: (h) => [95, 96, 99].includes(h.weatherCode ?? -1),
        severity: 'high',
        text: 'се очаква гръмотевична буря',
      },
      {
        eventType: 'hail',
        match: (h) => [96, 99].includes(h.weatherCode ?? -1),
        severity: 'moderate',
        text: 'има индикация за градушка',
      },
      {
        eventType: 'freeze',
        match: (h) => h.temperatureC !== null && h.temperatureC <= 0,
        severity: 'moderate',
        text: 'температурата може да падне под нулата',
      },
      {
        eventType: 'wind',
        match: (h) => h.gustKmh !== null && h.gustKmh >= 70,
        severity: 'high',
        text: 'очакват се силни пориви на вятъра',
      },
      {
        eventType: 'rain',
        match: (h) =>
          h.rainProbabilityPercent !== null &&
          h.rainProbabilityPercent >= 60 &&
          h.precipitationMm !== null &&
          h.precipitationMm >= 1,
        severity: 'low',
        text: 'се очаква дъжд',
      },
    ];
    for (const group of groups) {
      // Separate non-contiguous occurrences instead of claiming an unobserved span.
      let eventHours: EvidenceHour[] = [];
      const appendEvent = () => {
        if (!eventHours.length) return;
        findings.push({
          eventType: group.eventType,
          startsAt: eventHours[0].time,
          endsAt: new Date(
            Date.parse(eventHours[eventHours.length - 1].time) + hourMs,
          ).toISOString(),
          location: evidence.location,
          severity: group.severity,
          confidence: 'low',
          uncertainty:
            group.eventType === 'hail'
              ? 'Възможна градушка е само несигурна индикация от кода на прогнозата; размерът и реалното настъпване не са потвърдени.'
              : 'Офлайн тестова оценка по наличната прогноза; не е калибрирана и не е официално предупреждение.',
          evidenceRefs: eventHours.map((hour) => hour.id),
          consequences: [
            'Възможно е временно въздействие върху дома и външното оборудване.',
          ],
          preparation: ['Провери прогнозата и подходящата защита на дома.'],
          bulgarianExplanation: `Прогнозата за ${evidence.location}: ${group.text}. Провери прогнозата отново преди събитието.`,
        });
        eventHours = [];
      };
      for (const hour of evidence.hours) {
        const last = eventHours[eventHours.length - 1];
        if (last && Date.parse(hour.time) !== Date.parse(last.time) + hourMs) {
          appendEvent();
        }
        if (group.match(hour)) eventHours.push(hour);
        else appendEvent();
      }
      appendEvent();
    }
    return {
      findings: validateWeatherFindings(findings, evidence),
      summary: changed
        ? 'Прогнозата се промени съществено спрямо предишната запазена прогноза. Детерминистична LAB тестова оценка; не е използван LLM.'
        : 'Детерминистична LAB тестова оценка; не е използван LLM.',
      model: 'weather-fixture-v1',
    };
  }
}
