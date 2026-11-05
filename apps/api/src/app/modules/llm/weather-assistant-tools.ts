import { Injectable } from '@nestjs/common';
import type { AnyAgentTool } from '@letta-ai/letta-agent-sdk';
import type { HouseAgentScope } from './house-agent.port';

const HOUR_MS = 3_600_000;
const MAX_FORECAST_AGE_MS = 30 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

type WeatherStatus = 'available' | 'partial' | 'stale' | 'unavailable';
type WeatherHour = {
  id: string;
  time: string;
  temperatureC: number | null;
  rainProbabilityPercent: number;
  precipitationMm: number;
  gustKmh: number;
  weatherCode: number;
};
type WeatherFindingEvidence = {
  eventType: 'rain' | 'snow' | 'freeze' | 'wind' | 'thunderstorm' | 'hail';
  startsAt: string;
  endsAt: string;
  severity: 'low' | 'moderate' | 'high' | 'severe';
  confidence: 'low' | 'medium' | 'high';
  evidenceRefs: string[];
  explanationBg: string;
  uncertainty: string;
};

type WeatherEvidence = {
  status: WeatherStatus;
  reason?: string;
  provider?: string;
  model?: string | null;
  location?: string;
  capturedAt?: string;
  coverage?: { expectedHours: number; validHours: number; complete: boolean };
  hours?: WeatherHour[];
  findings?: WeatherFindingEvidence[];
  officialWarnings: 'unavailable';
  automationEligible: false;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finite(value: unknown, min: number, max = Number.POSITIVE_INFINITY): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validHour(value: unknown): value is WeatherHour {
  const hour = record(value);
  return !!hour && typeof hour.id === 'string' && hour.id.length <= 160 &&
    typeof hour.time === 'string' && Number.isFinite(Date.parse(hour.time)) &&
    (hour.temperatureC === null || finite(hour.temperatureC, -100, 70)) &&
    finite(hour.rainProbabilityPercent, 0, 100) &&
    finite(hour.precipitationMm, 0) && finite(hour.gustKmh, 0) &&
    typeof hour.weatherCode === 'number' && Number.isInteger(hour.weatherCode);
}

function unavailable(reason: string, status: WeatherStatus = 'unavailable'): WeatherEvidence {
  return { status, reason, officialWarnings: 'unavailable', automationEligible: false };
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * LAB-only, read-only assistant adapter to the existing versioned Core read model.
 * The model cannot supply its own site, tenant, provider, or coordinates.
 * An unavailable/partial/stale forecast never yields actionable hours/findings.
 */
@Injectable()
export class WeatherAssistantTools {
  tools(scope: HouseAgentScope): AnyAgentTool[] {
    return [
      {
        name: 'weather_get_forecast',
        label: 'Read the saved site forecast',
        description: 'Read a verified, site-scoped weather forecast for the next 6 or 24 hours. This is saved forecast evidence, not current sensor conditions or an official warning. Use for weather, precipitation, temperature and wind questions. If status is stale, partial or unavailable, report uncertainty and never claim conditions are safe. Do not invent measurements.',
        parameters: {
          type: 'object',
          properties: {
            hours: { type: 'number', enum: [6, 24], description: 'Requested forecast horizon in hours; defaults to 24.' },
          },
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = record(raw);
          if (raw != null && !args) return error('Invalid forecast request.');
          if (args && (Object.keys(args).some(key => key !== 'hours') ||
              (args.hours !== undefined && args.hours !== 6 && args.hours !== 24))) {
            return error('Forecast horizon must be 6 or 24 hours.');
          }
          const horizon = args?.hours === 6 ? 6 : 24;
          const model = await this.load(scope);
          if (model.status !== 'available') return result(model);
          const start = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
          const byTime = new Map<number, WeatherHour>();
          for (const hour of model.hours ?? []) {
            const time = Date.parse(hour.time);
            if (byTime.has(time)) return result(unavailable('Duplicate forecast hour; coverage cannot be verified.', 'partial'));
            byTime.set(time, hour);
          }
          const hours: WeatherHour[] = [];
          for (let index = 0; index < horizon; index++) {
            const hour = byTime.get(start + index * HOUR_MS);
            if (!hour) return result(unavailable('The requested consecutive forecast hours are incomplete.', 'partial'));
            hours.push(hour);
          }
          return result({ ...model, hours, findings: undefined, horizonHours: horizon });
        },
      },
      {
        name: 'weather_get_findings',
        label: 'Read saved site weather findings',
        description: 'Read validated experimental LAB weather findings for this authenticated site, including evidence references and forecast uncertainty. These are NOT official warnings or notification deliveries. If the weather source is stale, partial or unavailable, do not repeat old findings as active alerts.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (_toolCallId, raw) => {
          const args = record(raw);
          if (raw != null && (!args || Object.keys(args).length)) return error('This read-only tool accepts no arguments.');
          const model = await this.load(scope);
          if (model.status !== 'available') return result(model);
          return result({
            status: model.status,
            provider: model.provider,
            model: model.model,
            location: model.location,
            capturedAt: model.capturedAt,
            findings: model.findings ?? [],
            officialWarnings: model.officialWarnings,
            automationEligible: false,
            warning: 'Experimental forecast-only findings; not official weather alerts.',
          });
        },
      },
    ];
  }

  private async load(scope: HouseAgentScope): Promise<WeatherEvidence> {
    if (process.env.ENERGRID_LAB_MODE !== 'true')
      return unavailable('LAB Weather tools are disabled.');
    const token = process.env.WEATHER_INVESTIGATOR_API_TOKEN?.trim();
    if (!token || !scope?.tenantId?.trim() || !scope?.siteId?.trim())
      return unavailable('Weather bridge or authenticated scope is not configured.');

    const base = (process.env.ENERGRID_CORE_URL || 'http://127.0.0.1:3020').replace(/\/$/, '');
    const params = new URLSearchParams({ tenantId: scope.tenantId, siteId: scope.siteId });
    let raw: unknown;
    try {
      const response = await fetch(`${base}/core/weather/investigator/read-model?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return unavailable('Core weather read is unavailable or not authorized.');
      raw = await response.json();
    } catch {
      return unavailable('Core weather read failed.');
    }

    const model = record(raw);
    const sourceScope = record(model?.scope);
    if (model?.version !== 1 || sourceScope?.tenantId !== scope.tenantId ||
        sourceScope?.siteId !== scope.siteId) {
      return unavailable('Weather read contract or site identity could not be verified.');
    }
    if (!['available', 'partial', 'stale', 'unavailable'].includes(String(model.status)))
      return unavailable('Weather read status is invalid.');
    if (model.status !== 'available')
      return unavailable('The stored forecast is not complete and fresh enough for reliable answers.', model.status as WeatherStatus);

    const forecast = record(model.forecast);
    const coverage = record(forecast?.coverage);
    if (!forecast || typeof forecast.capturedAt !== 'string' ||
        !Number.isFinite(Date.parse(forecast.capturedAt)) ||
        typeof forecast.provider !== 'string' || !forecast.provider.trim() ||
        typeof forecast.location !== 'string' || !forecast.location.trim() ||
        !coverage || coverage.complete !== true || coverage.expectedHours !== 24 ||
        coverage.validHours !== 24 || !Array.isArray(forecast.hours)) {
      return unavailable('Weather read model lacks verified forecast coverage.', 'partial');
    }
    const age = Date.now() - Date.parse(forecast.capturedAt);
    if (age > MAX_FORECAST_AGE_MS || age < -MAX_FUTURE_SKEW_MS)
      return unavailable('The weather evidence capture is stale or from the future.', 'stale');

    // Validate the complete current 24h window; future hours outside that window
    // may be missing in an otherwise usable 24h forecast.
    const firstHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const candidateHours = forecast.hours.filter((item) => {
      const hour = record(item);
      if (typeof hour?.time !== 'string') return false;
      const time = Date.parse(hour.time);
      return Number.isFinite(time) && time >= firstHour && time < firstHour + 24 * HOUR_MS;
    });
    if (candidateHours.length !== 24 || !candidateHours.every(validHour) ||
        new Set(candidateHours.map((hour) => Date.parse((hour as WeatherHour).time))).size !== 24) {
      return unavailable('Stored hourly weather evidence lacks 24 verified consecutive hours.', 'partial');
    }
    const hours = candidateHours as WeatherHour[];
    const findings = Array.isArray(model.findings) ? model.findings : [];
    const safeFindings = findings.slice(0, 10).flatMap((item) => {
      const finding = record(item);
      if (!finding || !['rain', 'snow', 'freeze', 'wind', 'thunderstorm', 'hail'].includes(String(finding.eventType)) ||
          !['low', 'moderate', 'high', 'severe'].includes(String(finding.severity)) ||
          !['low', 'medium', 'high'].includes(String(finding.confidence)) ||
          typeof finding.startsAt !== 'string' || typeof finding.endsAt !== 'string' ||
          !Number.isFinite(Date.parse(finding.startsAt)) ||
          !Number.isFinite(Date.parse(finding.endsAt)) ||
          Date.parse(finding.startsAt) >= Date.parse(finding.endsAt) ||
          Date.parse(finding.endsAt) <= Date.now() ||
          Date.parse(finding.startsAt) >= Date.now() + 24 * HOUR_MS ||
          !Array.isArray(finding.evidenceRefs) ||
          !finding.evidenceRefs.length ||
          !finding.evidenceRefs.every(ref => typeof ref === 'string' && ref.length <= 160)) return [];
      return [{
        eventType: finding.eventType as WeatherFindingEvidence['eventType'],
        startsAt: finding.startsAt,
        endsAt: finding.endsAt,
        severity: finding.severity as WeatherFindingEvidence['severity'],
        confidence: finding.confidence as WeatherFindingEvidence['confidence'],
        evidenceRefs: finding.evidenceRefs.slice(0, 24) as string[],
        explanationBg: typeof finding.explanationBg === 'string' ? finding.explanationBg.slice(0, 600) : '',
        uncertainty: typeof finding.uncertainty === 'string' ? finding.uncertainty.slice(0, 400) : '',
      } satisfies WeatherFindingEvidence];
    });

    return {
      status: 'available',
      provider: forecast.provider,
      model: typeof forecast.model === 'string' ? forecast.model : null,
      location: forecast.location,
      capturedAt: forecast.capturedAt,
      coverage: { expectedHours: 24, validHours: 24, complete: true },
      hours,
      findings: safeFindings,
      officialWarnings: 'unavailable',
      automationEligible: false,
    };
  }
}
