import { WeatherAssistantQueryService } from './weather-assistant-query.service';

describe('weather assistant evidence lookup', () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('answers Bulgarian forecast questions from the current site snapshot with evidence timestamps', async () => {
    process.env = {
      ...originalEnv,
      WEATHER_INVESTIGATOR_API_TOKEN: 'lab-bridge-test',
    };
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        status: 'available',
        findings: [],
        forecast: {
          capturedAt: '2026-10-24T09:00:00.000Z',
          provider: 'open-meteo',
          model: 'icon_seamless',
          location: 'Vidin',
          hours: [
            {
              id: 'hour:1',
              time: '2026-10-26T09:00:00.000Z',
              temperatureC: -2,
              rainProbabilityPercent: 10,
              precipitationMm: 0,
              gustKmh: 12,
              weatherCode: 71,
            },
          ],
        },
        officialAlerts: {
          status: 'unsupported',
          explanation: 'Официалните предупреждения не се поддържат.',
        },
      }),
    } as Response);
    const reply = await new WeatherAssistantQueryService().answer(
      { tenantId: 'tenant-test', siteId: 'site-test' },
      'Ще има ли сняг?',
    );
    expect(reply).toContain('Vidin');
    expect(reply).toContain('2026');
    expect(reply).toContain('hour:1');
    expect(reply).toContain('Официалните предупреждения');
    expect(String(fetch.mock.calls[0][0])).toContain(
      'tenantId=tenant-test&siteId=site-test',
    );
    expect(String(fetch.mock.calls[0][0])).toContain('/read-model?');
  });

  it('does not call Core for unrelated questions', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    expect(
      await new WeatherAssistantQueryService().answer(
        { tenantId: 't', siteId: 's' },
        'Turn on the kitchen lights',
      ),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not describe stale or incomplete saved evidence as a current forecast', async () => {
    process.env = { ...originalEnv, WEATHER_INVESTIGATOR_API_TOKEN: 'lab-bridge-test' };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1, status: 'stale', findings: [{ explanationBg: 'Силна буря!' }],
        forecast: { location: 'Vidin', hours: [{ weatherCode: 95 }] },
        officialAlerts: { status: 'unsupported', explanation: 'Официалните предупреждения не са проверени.' },
      }),
    } as Response);
    const reply = await new WeatherAssistantQueryService().answer(
      { tenantId: 'tenant-test', siteId: 'site-test' }, 'Има ли буря?');
    expect(reply).toContain('остаряла');
    expect(reply).not.toContain('Силна буря!');
  });
});
