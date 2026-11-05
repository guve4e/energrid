import { buildWeatherInvestigatorReadiness, type WeatherInvestigatorScheduleState } from './weather-investigator-readiness';
import type { WeatherReadModel } from './weather-read-model';

const scope = { tenantId: 'tenant-lab', siteId: 'site-lab' };
const schedule: WeatherInvestigatorScheduleState = {
  enabled: true, running: false, intervalMinutes: 15, consecutiveFailures: 0,
  lastAttemptAt: null, lastCompletedAt: null, lastOutcome: null, nextAttemptAt: null,
};
const model = (status: WeatherReadModel['status']): WeatherReadModel => ({
  version: 1, scope, generatedAt: '2026-11-05T10:00:00.000Z', status,
  quality: { reasons: status === 'stale' ? ['stale'] : status === 'partial' ? ['incomplete_24h'] : [] },
  forecast: status === 'unavailable' ? null : {
    capturedAt: '2026-11-05T09:50:00.000Z', location: 'LAB', provider: 'open-meteo',
    model: 'icon_seamless', ageMinutes: 10, coverage: { expectedHours: 24, validHours: 24, complete: true }, hours: [],
  },
  findings: [], officialAlerts: { status: 'unsupported', explanation: 'not supported' },
  automationEligible: false,
});

describe('weather investigator operational readiness', () => {
  it('does not mark startup without evidence ready', () => {
    const output = buildWeatherInvestigatorReadiness(scope, schedule, null, model('unavailable'), false);
    expect(output.status).toBe('waiting_for_first_snapshot');
    expect(output.evidence).toBeNull();
  });
  it('reports startup collection distinctly', () => {
    const output = buildWeatherInvestigatorReadiness(scope, { ...schedule, running: true }, null, null, false);
    expect(output.status).toBe('collecting');
  });
  it('marks complete fresh evidence ready, without claiming alerts', () => {
    const output = buildWeatherInvestigatorReadiness(scope, { ...schedule, lastOutcome: 'completed' }, null, model('available'), false);
    expect(output.status).toBe('ready');
    expect(output.evidence?.coverage.validHours).toBe(24);
    expect(output.evidence?.provider).toBe('open-meteo');
  });
  it('surfaces stale and incomplete evidence separately', () => {
    expect(buildWeatherInvestigatorReadiness(scope, schedule, null, model('stale'), false).status).toBe('stale_forecast');
    expect(buildWeatherInvestigatorReadiness(scope, schedule, null, model('partial'), false).status).toBe('incomplete_forecast');
  });
  it('does not label invalid persisted evidence as if collection had never started', () => {
    const invalid = { ...model('unavailable'), quality: { reasons: ['invalid_source' as const] } };
    const output = buildWeatherInvestigatorReadiness(scope, schedule, null, invalid, false);
    expect(output.status).toBe('incomplete_forecast');
    expect(output.reason).toBe('invalid_source');
  });
  it('does not hide an upstream failure behind previously fresh evidence', () => {
    const output = buildWeatherInvestigatorReadiness(scope, {
      ...schedule, lastOutcome: 'weather-unavailable', consecutiveFailures: 1,
    }, null, model('available'), false);
    expect(output.status).toBe('provider_unavailable');
  });
  it('separates storage failures, configuration faults, and disabled collection', () => {
    expect(buildWeatherInvestigatorReadiness(scope, schedule, null, null, true).status).toBe('storage_unavailable');
    expect(buildWeatherInvestigatorReadiness(scope, schedule, 'site_configuration_missing', null, false).status).toBe('misconfigured');
    expect(buildWeatherInvestigatorReadiness(scope, { ...schedule, enabled: false }, 'scheduler_disabled', null, false).status).toBe('disabled');
  });
  it('returns operational timestamps but never source credentials', () => {
    const output = buildWeatherInvestigatorReadiness(scope, { ...schedule, lastAttemptAt: '2026-11-05T09:49:00Z' }, null, model('available'), false);
    expect(output.schedule.lastAttemptAt).toContain('09:49');
    expect(JSON.stringify(output)).not.toContain('token');
  });
});
