import { WeatherSnapshot } from './weather-data-quality';
import {
  buildWeatherEvidence,
  ApiWeatherInvestigatorProvider,
  FixtureWeatherInvestigatorProvider,
  materiallyChangedForecast,
  validateWeatherFindings,
} from './weather-investigator';

const baseTime = Date.parse('2026-10-24T09:00:00.000Z');
function snapshot(
  overrides: Record<number, Partial<WeatherSnapshot['hourly'][number]>> = {},
): WeatherSnapshot {
  return {
    location: 'Vidin',
    coordinates: { latitude: 43.9916, longitude: 22.8728 },
    provider: 'open-meteo',
    model: 'icon_seamless',
    availability: 'available',
    fetchedAt: new Date(baseTime).toISOString(),
    units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' },
    current: {
      time: new Date(baseTime).toISOString(),
      temperature: 12,
      feelsLike: 12,
      humidity: 50,
      pressure: 1010,
      windKmh: 10,
      gustKmh: 15,
      weatherCode: 1,
      condition: 'Clear',
    },
    hourly: Array.from({ length: 96 }, (_, index) => ({
      time: new Date(baseTime + index * 3_600_000).toISOString(),
      temperature: 12,
      feelsLike: 12,
      humidity: 50,
      pressure: 1010,
      rainChance: 10,
      precipitationMm: 0,
      rainMm: 0,
      showersMm: 0,
      weatherCode: 1,
      condition: 'Clear',
      windKmh: 12,
      gustKmh: 18,
      ...overrides[index],
    })),
    daily: [],
    alerts: [],
  };
}
const provider = new FixtureWeatherInvestigatorProvider();
const evidence = (data: WeatherSnapshot) =>
  buildWeatherEvidence(data, 'site-a', baseTime);

describe('weather investigator evidence and fixture provider', () => {
  it('normalizes hourly provider data and bounds the evidence horizon to 72 hours', () => {
    const normalized = evidence(snapshot());
    expect(normalized.hours).toHaveLength(73);
    expect(normalized.hours[0].id).toContain('hour:');
    expect(normalized.provider).toBe('open-meteo');
    expect(normalized.alertsAvailable).toBe(false);
  });

  it('keeps ordinary weather quiet', async () => {
    expect(
      (await provider.investigate(evidence(snapshot()), null)).findings,
    ).toEqual([]);
  });

  it('finds supported rain forecast about 48 hours ahead', async () => {
    const result = await provider.investigate(
      evidence(
        snapshot({
          48: { rainChance: 80, precipitationMm: 4, weatherCode: 63 },
        }),
      ),
      null,
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'rain', confidence: 'low' }),
      ]),
    );
    expect(result.findings[0].evidenceRefs).toEqual(
      expect.arrayContaining([expect.stringContaining('hour:')]),
    );
  });

  it('finds snow and freezing temperatures from the same forecast window', async () => {
    const result = await provider.investigate(
      evidence(snapshot({ 30: { temperature: -4, weatherCode: 71 } })),
      null,
    );
    expect(result.findings.map((finding) => finding.eventType)).toEqual(
      expect.arrayContaining(['snow', 'freeze']),
    );
  });

  it('reports strong wind while leaving official alert coverage unavailable', async () => {
    const result = await provider.investigate(
      evidence(snapshot({ 10: { gustKmh: 82 } })),
      null,
    );
    expect(result.findings.map((finding) => finding.eventType)).toContain(
      'wind',
    );
    expect(result.findings.map((finding) => finding.eventType)).not.toContain(
      'official_warning',
    );
  });

  it('keeps hail as uncertain forecast evidence', async () => {
    const result = await provider.investigate(
      evidence(snapshot({ 12: { weatherCode: 96 } })),
      null,
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'hail', confidence: 'low' }),
      ]),
    );
    expect(
      result.findings.find((finding) => finding.eventType === 'hail')
        ?.uncertainty,
    ).toMatch(/несигурна индикация|потенциал|възмож/iu);
  });

  it('recognizes material forecast changes for comparison with prior snapshots', () => {
    const before = evidence(snapshot());
    const after = evidence(
      snapshot({ 20: { rainChance: 75, precipitationMm: 8, weatherCode: 63 } }),
    );
    expect(materiallyChangedForecast(after, before)).toBe(true);
    expect(materiallyChangedForecast(before, before)).toBe(false);
  });

  it('rejects malformed findings and references outside the evidence snapshot', () => {
    const normalized = evidence(snapshot());
    expect(() =>
      validateWeatherFindings(
        [
          {
            eventType: 'rain',
            startsAt: 'bad',
            evidenceRefs: ['hour:invented'],
          },
        ],
        normalized,
      ),
    ).toThrow();
    expect(() =>
      validateWeatherFindings(
        [
          {
            eventType: 'official_warning',
            startsAt: normalized.hours[0].time,
            endsAt: new Date(
              Date.parse(normalized.hours[0].time) + 3_600_000,
            ).toISOString(),
            location: normalized.location,
            severity: 'severe',
            confidence: 'high',
            uncertainty: '',
            evidenceRefs: [normalized.hours[0].id],
            consequences: [],
            preparation: [],
            bulgarianExplanation: 'Предупреждение',
          },
        ],
        normalized,
      ),
    ).toThrow('official warning');
  });

  it('keeps findings separate for sites at different locations', async () => {
    const a = buildWeatherEvidence(
      snapshot({ 4: { rainChance: 70, precipitationMm: 3 } }),
      'site-a',
      baseTime,
    );
    const sourceB = snapshot({ 4: { weatherCode: 71, temperature: -2 } });
    sourceB.location = 'Sofia';
    sourceB.coordinates = { latitude: 42.6977, longitude: 23.3219 };
    const b = buildWeatherEvidence(sourceB, 'site-b', baseTime);
    const [resultA, resultB] = await Promise.all([
      provider.investigate(a, null),
      provider.investigate(b, null),
    ]);
    expect(
      resultA.findings.every((finding) => finding.location === 'Vidin'),
    ).toBe(true);
    expect(resultB.findings.map((finding) => finding.eventType)).toEqual(
      expect.arrayContaining(['snow', 'freeze']),
    );
    expect(
      resultB.findings.every((finding) => finding.location === 'Sofia'),
    ).toBe(true);
  });
});

describe('API LLM weather provider data minimization', () => {
  const original = process.env;
  afterEach(() => { process.env = original; jest.restoreAllMocks(); });
  it('sends only normalized weather evidence, approximate coordinates and an opaque site ID', async () => {
    process.env = { ...original, ENERGRID_LAB_MODE: 'true', WEATHER_INVESTIGATOR_API_TOKEN: 'bridge-secret', WEATHER_INVESTIGATOR_SITE_ID: 'site-a', WEATHER_INVESTIGATOR_OPAQUE_SITE_ID: 'opaque-lab-001' };
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ findings: [], summary: 'clear', model: 'configured-model' }) } as Response);
    const current = evidence(snapshot());
    await new ApiWeatherInvestigatorProvider().investigate(current, null);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain('/weather/investigator/infer');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      siteId: 'opaque-lab-001',
      evidence: { siteId: 'opaque-lab-001', location: 'около инсталацията', coordinates: { latitude: 43.99, longitude: 22.87 } },
      previous: null,
    });
    expect(String(init?.body)).not.toContain('tenant');
    expect(String(init?.body)).not.toContain('Vidin');
    expect(String(init?.body)).not.toContain('device');
    expect(String(init?.body)).not.toContain('site-a');
  });
});
