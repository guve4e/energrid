import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { LlmGatewayService } from '../llm/llm-gateway.service';

const evidenceKeys = ['siteId', 'capturedAt', 'provider', 'model', 'location', 'coordinates', 'alertsAvailable', 'alerts', 'hours'];
const hourKeys = ['id', 'time', 'temperatureC', 'rainProbabilityPercent', 'precipitationMm', 'windKmh', 'gustKmh', 'weatherCode'];
const schema = {
  name: 'energrid_weather_investigation',
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        eventType: { type: 'string', enum: ['rain', 'snow', 'freeze', 'wind', 'thunderstorm', 'hail', 'official_warning'] },
        startsAt: { type: 'string' }, endsAt: { type: 'string' }, location: { type: 'string' },
        severity: { type: 'string', enum: ['low', 'moderate', 'high', 'severe'] }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        uncertainty: { type: 'string' }, evidenceRefs: { type: 'array', items: { type: 'string' } },
        consequences: { type: 'array', items: { type: 'string' } }, preparation: { type: 'array', items: { type: 'string' } }, bulgarianExplanation: { type: 'string' },
      }, required: ['eventType','startsAt','endsAt','location','severity','confidence','uncertainty','evidenceRefs','consequences','preparation','bulgarianExplanation'] } },
    }, required: ['summary', 'findings'],
  },
};

@Injectable()
export class WeatherInferenceService {
  private readonly logger = new Logger(WeatherInferenceService.name);
  constructor(private readonly llm: LlmGatewayService) {}

  async investigate(input: unknown) {
    const request = this.validateRequest(input);
    if (!this.consentFor(request.siteId)) throw new ForbiddenException('Weather inference consent is not enabled for this site');
    const response = await this.llm.generate({
      systemPrompt: 'You investigate only the supplied normalized weather forecast. Propose findings only when supported by cited hourly evidence IDs. Never invent measurements, alerts, warnings, property details, or calibration. Official warnings may only be reported when an authoritative alert is present in evidence; forecast conditions are not official warnings. Use Bulgarian for explanations and concise practical preparation. Return no finding when evidence is ordinary or inconclusive.',
      userPrompt: JSON.stringify({ evidence: request.evidence, previous: request.previous }),
      maxOutputTokens: 1600,
      outputSchema: schema,
    }, { cloudDataConsent: true });
    let parsed: { summary?: unknown; findings?: unknown };
    try { parsed = JSON.parse(response.text) as typeof parsed; }
    catch { throw new ServiceUnavailableException('Weather model returned invalid structured output'); }
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.findings)) throw new ServiceUnavailableException('Weather model returned invalid structured output');
    this.logger.log(`Weather inference completed via ${response.provider}/${response.model}; findings=${parsed.findings.length}`);
    return { ...parsed, model: response.model, inferenceProvider: response.provider };
  }

  private consentFor(siteId: string) {
    try {
      const config = JSON.parse(process.env.WEATHER_LLM_SITE_CONSENT_JSON || '{}') as Record<string, unknown>;
      return config[siteId] === true;
    } catch { return false; }
  }

  private validateRequest(value: unknown): { siteId: string; evidence: Record<string, any>; previous: Record<string, any> | null } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForbiddenException('Invalid weather inference request');
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).some((key) => !['siteId', 'evidence', 'previous'].includes(key)) || typeof obj.siteId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(obj.siteId)) throw new ForbiddenException('Invalid weather inference request');
    const normalize = (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ForbiddenException('Invalid weather evidence');
      const ev = raw as Record<string, any>;
      if (Object.keys(ev).some((key) => !evidenceKeys.includes(key)) || ev.siteId !== obj.siteId || ev.location !== 'около инсталацията' || !Array.isArray(ev.hours) || ev.hours.length > 73 || !ev.coordinates || Object.keys(ev.coordinates).some((key) => !['latitude','longitude'].includes(key)) || typeof ev.coordinates.latitude !== 'number' || typeof ev.coordinates.longitude !== 'number' || Math.abs(ev.coordinates.latitude) > 90 || Math.abs(ev.coordinates.longitude) > 180 || Math.abs(ev.coordinates.latitude * 100 - Math.round(ev.coordinates.latitude * 100)) > 0.001 || Math.abs(ev.coordinates.longitude * 100 - Math.round(ev.coordinates.longitude * 100)) > 0.001) throw new ForbiddenException('Invalid weather evidence');
      if (ev.hours.some((hour: any) => !hour || Object.keys(hour).some((key: string) => !hourKeys.includes(key)) || typeof hour.id !== 'string' || typeof hour.time !== 'string' || !Number.isFinite(Date.parse(hour.time)) || ['temperatureC','rainProbabilityPercent','precipitationMm','windKmh','gustKmh','weatherCode'].some((key) => hour[key] !== null && hour[key] !== undefined && typeof hour[key] !== 'number'))) throw new ForbiddenException('Invalid weather evidence');
      if (ev.alertsAvailable !== false || !Array.isArray(ev.alerts) || ev.alerts.length !== 0) throw new ForbiddenException('Only forecast evidence is accepted');
      return ev;
    };
    const evidence = normalize(obj.evidence);
    const previous = obj.previous === null ? null : normalize(obj.previous);
    return { siteId: obj.siteId, evidence, previous };
  }
}
