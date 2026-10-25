import { WeatherInferenceService } from './weather-inference.service';

describe('WeatherInferenceService', () => {
  const original = process.env;
  afterEach(() => { process.env = original; });
  const evidence = {
    siteId: 'opaque-lab-001', capturedAt: new Date().toISOString(), provider: 'open-meteo', model: null,
    location: 'около инсталацията', coordinates: { latitude: 43.99, longitude: 22.87 }, alertsAvailable: false, alerts: [],
    hours: [{ id: 'hour:2026-10-25T12:00:00.000Z', time: '2026-10-25T12:00:00.000Z', temperatureC: 7, rainProbabilityPercent: 80, precipitationMm: 4, windKmh: 10, gustKmh: 15, weatherCode: 63 }],
  };
  it('requires explicit exact-site consent and uses cloud consent through the gateway', async () => {
    process.env = { ...original, WEATHER_LLM_SITE_CONSENT_JSON: JSON.stringify({ 'opaque-lab-001': true }) };
    const generate = jest.fn().mockResolvedValue({ text: JSON.stringify({ summary: 'Rain', findings: [] }), provider: 'openai', model: 'configured-model' });
    const service = new WeatherInferenceService({ generate } as never);
    expect(await service.investigate({ siteId: 'opaque-lab-001', evidence, previous: null })).toMatchObject({ model: 'configured-model' });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ outputSchema: expect.any(Object) }), { cloudDataConsent: true });
    await expect(service.investigate({ siteId: 'other-site-001', evidence: { ...evidence, siteId: 'other-site-001' }, previous: null })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('rejects additional identity or unrelated evidence fields before inference', async () => {
    process.env = { ...original, WEATHER_LLM_SITE_CONSENT_JSON: JSON.stringify({ 'opaque-lab-001': true }) };
    const generate = jest.fn();
    const service = new WeatherInferenceService({ generate } as never);
    await expect(service.investigate({ siteId: 'opaque-lab-001', tenantId: 'tenant', evidence, previous: null })).rejects.toThrow();
    await expect(service.investigate({ siteId: 'opaque-lab-001', evidence: { ...evidence, deviceObservations: [] }, previous: null })).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
});
