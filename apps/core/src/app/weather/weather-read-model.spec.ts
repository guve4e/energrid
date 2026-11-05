import { buildWeatherReadModel, StoredWeatherFinding } from './weather-read-model';
import type { WeatherEvidenceSnapshot } from './weather-investigator';

const now = Date.parse('2026-11-04T12:15:00.000Z');
const start = Date.parse('2026-11-04T12:00:00.000Z');
const scope = { tenantId: 'tenant-a', siteId: 'site-a' };
const finding: StoredWeatherFinding = {
  id: '12', evidenceSnapshotId: '5', eventType: 'rain', startsAt: new Date(start).toISOString(),
  endsAt: new Date(start + 2 * 3_600_000).toISOString(),
  location: 'Vidin', severity: 'low', confidence: 'low',
  uncertainty: 'Possible rain', evidenceRefs: ['hour:1'],
  consequences: [], preparation: [], explanationBg: 'Дъжд',
  provider: 'fixture', model: 'fixture',
  lastUpdatedAt: new Date(now).toISOString(), notificationState: 'prepared',
};

function stored(capturedAt: string = new Date(now - 5 * 60_000).toISOString()) {
  const evidence: WeatherEvidenceSnapshot = {
    siteId: 'site-a', capturedAt, provider: 'open-meteo', model: 'icon_seamless',
    location: 'Vidin', coordinates: { latitude: 43.99, longitude: 22.87 },
    alertsAvailable: false, alerts: [],
    hours: Array.from({ length: 24 }, (_, i) => ({
      id: `hour:${i}`, time: new Date(start + i * 3_600_000).toISOString(),
      temperatureC: 8, rainProbabilityPercent: 20, precipitationMm: 0,
      windKmh: 8, gustKmh: 12, weatherCode: 1,
    })),
  };
  return {
    findings: [finding],
    latestForecast: {
      id: '5', capturedAt, provider: 'open-meteo', model: 'icon_seamless',
      location: 'Vidin', evidence,
    },
  };
}

describe('versioned LAB weather read model', () => {
  it('returns a site-scoped fresh model with explicit coverage and unsupported official alerts', () => {
    const result = buildWeatherReadModel(scope, stored(), now);
    expect(result).toMatchObject({
      version: 1, scope, status: 'available', automationEligible: false,
      forecast: {
        ageMinutes: 5, timeZone: 'Europe/Sofia',
        coverage: { expectedHours: 24, validHours: 24, complete: true },
      },
      officialAlerts: { status: 'unsupported' },
    });
    expect(result.findings).toHaveLength(1);
  });

  it('never turns stale evidence into active findings', () => {
    const result = buildWeatherReadModel(scope, stored(new Date(now - 31 * 60_000).toISOString()), now);
    expect(result.status).toBe('stale');
    expect(result.findings).toEqual([]);
    expect(result.forecast?.capturedAt).toBeTruthy();
    expect(result.forecast?.hours).toEqual([]);
  });

  it('rejects an incomplete window without declaring an available forecast', () => {
    const data = stored();
    data.latestForecast.evidence.hours.splice(12, 1);
    const result = buildWeatherReadModel(scope, data, now);
    expect(result.status).toBe('partial');
    expect(result.forecast?.coverage).toEqual({ expectedHours: 24, validHours: 12, complete: false });
    expect(result.findings).toEqual([]);
    expect(result.forecast?.hours).toEqual([]);
  });

  it('rejects missing rain amounts, out-of-range probabilities and future capture times', () => {
    const data = stored();
    data.latestForecast.evidence.hours[3].precipitationMm = null;
    data.latestForecast.evidence.hours[4].rainProbabilityPercent = 120;
    const result = buildWeatherReadModel(scope, data, now);
    expect(result.status).toBe('partial');
    expect(result.forecast?.coverage.validHours).toBe(3);
    const future = buildWeatherReadModel(scope, stored(new Date(now + 6 * 60_000).toISOString()), now);
    expect(future.status).toBe('stale');
    expect(future.findings).toEqual([]);
  });

  it('fails closed for absent, invalid or cross-site source evidence', () => {
    expect(buildWeatherReadModel(scope, { findings: [finding], latestForecast: null }, now).status).toBe('unavailable');
    const invalid = stored('bad timestamp');
    expect(buildWeatherReadModel(scope, invalid, now).forecast).toBeNull();
    const wrongSite = stored();
    wrongSite.latestForecast.evidence.siteId = 'another-site';
    expect(buildWeatherReadModel(scope, wrongSite, now).status).toBe('unavailable');
  });

  it('treats duplicated hourly timestamps as incomplete evidence', () => {
    const data = stored();
    data.latestForecast.evidence.hours.push({ ...data.latestForecast.evidence.hours[4] });
    expect(buildWeatherReadModel(scope, data, now).status).toBe('partial');
  });

  it('does not present findings from an earlier evidence snapshot as current', () => {
    const data = stored();
    data.findings[0] = { ...finding, evidenceSnapshotId: '4' };
    const result = buildWeatherReadModel(scope, data, now);
    expect(result.status).toBe('available');
    expect(result.findings).toEqual([]);
  });

  it('does not show past findings as active events', () => {
    const data = stored();
    data.findings[0] = { ...finding, endsAt: new Date(now - 1000).toISOString() };
    expect(buildWeatherReadModel(scope, data, now).findings).toEqual([]);
  });
});
