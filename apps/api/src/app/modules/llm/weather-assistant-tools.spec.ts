import { WeatherAssistantTools } from './weather-assistant-tools';

const scope = { tenantId: 'tenant-a', siteId: 'site-a' };
const start = Date.parse('2026-11-05T09:00:00.000Z');
const now = start + 15 * 60_000;

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    scope,
    status: 'available',
    forecast: {
      capturedAt: new Date(now - 60_000).toISOString(),
      provider: 'open-meteo',
      model: 'icon_seamless',
      location: 'Vidin', timeZone: 'Europe/Sofia',
      coverage: { expectedHours: 24, validHours: 24, complete: true },
      hours: Array.from({ length: 24 }, (_, i) => ({
        id: `hour:${i}`,
        time: new Date(start + i * 3_600_000).toISOString(),
        temperatureC: 12,
        rainProbabilityPercent: i === 3 ? 60 : 10,
        precipitationMm: i === 3 ? 1.2 : 0,
        gustKmh: 12,
        weatherCode: 3,
      })),
    },
    findings: [{
      eventType: 'rain', startsAt: new Date(start + 2 * 3_600_000).toISOString(),
      endsAt: new Date(start + 4 * 3_600_000).toISOString(),
      severity: 'low', confidence: 'low', explanationBg: 'Очаква се дъжд',
      uncertainty: 'Прогноза', evidenceRefs: ['hour:3'],
    }],
    officialAlerts: { status: 'unsupported' },
    automationEligible: false,
    ...overrides,
  };
}

describe('LAB Weather assistant tools', () => {
  const initialEnv = process.env;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    process.env = {
      ...initialEnv,
      ENERGRID_LAB_MODE: 'true',
      WEATHER_INVESTIGATOR_API_TOKEN: 'lab-token',
      ENERGRID_CORE_URL: 'http://127.0.0.1:3020',
    };
  });
  afterEach(() => {
    process.env = initialEnv;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function mockRead(body: unknown = evidence()) {
    return jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => body,
    } as Response);
  }

  it('reads 6 hours only from the server-provided site, not tool arguments', async () => {
    const fetch = mockRead();
    const tool = new WeatherAssistantTools().tools(scope).find(tool => tool.name === 'weather_get_forecast')! as any;
    const reply = await tool.execute('request-a', { hours: 6 });
    expect(reply.details).toMatchObject({ status: 'available', horizonHours: 6, officialWarnings: 'unavailable', automationEligible: false });
    expect((reply.details as any).hours).toHaveLength(6);
    expect((reply.details as any).timeZone).toBe('Europe/Sofia');
    expect((reply.details as any).capturedAtLocal).toContain('11:14');
    expect((reply.details as any).hours[0]).toMatchObject({
      time: '2026-11-05T09:00:00.000Z', localTime: expect.stringContaining('11:00'),
    });
    expect(String(fetch.mock.calls[0][0])).toContain('tenantId=tenant-a&siteId=site-a');
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer lab-token' } });
  });

  it('rejects attempts to override site or request unsupported horizons without Core calls', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const tool = new WeatherAssistantTools().tools(scope).find(tool => tool.name === 'weather_get_forecast')! as any;
    expect((await tool.execute('a', { siteId: 'site-b', hours: 6 })).isError).toBe(true);
    expect((await tool.execute('b', { hours: 168 })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['stale', 'partial', 'unavailable'] as const)(
    'never forwards forecast hours or findings when Core reports %s', async (status) => {
      mockRead(evidence({ status }));
      for (const tool of new WeatherAssistantTools().tools(scope) as any[]) {
        const reply = await tool.execute('read', {});
        expect(reply.details).toMatchObject({ status, automationEligible: false });
        expect((reply.details as any).hours).toBeUndefined();
        expect((reply.details as any).findings).toBeUndefined();
      }
    },
  );

  it('rejects a different tenant/site or unsupported contract version', async () => {
    const fetch = mockRead(evidence({ scope: { tenantId: 'tenant-b', siteId: 'site-a' } }));
    const tool = new WeatherAssistantTools().tools(scope)[0] as any;
    expect((await tool.execute('a', {})).details).toMatchObject({ status: 'unavailable', reasonCode: 'scope_mismatch' });
    fetch.mockResolvedValue({ ok: true, json: async () => evidence({ version: 2 }) } as Response);
    expect((await tool.execute('b', {})).details).toMatchObject({ status: 'unavailable', reasonCode: 'contract_mismatch' });
  });

  it('enforces freshness even when a malformed Core response says available', async () => {
    mockRead(evidence({ forecast: { ...evidence().forecast, capturedAt: new Date(now - 31 * 60_000).toISOString() } }));
    const reply = await (new WeatherAssistantTools().tools(scope)[0] as any).execute('a', {});
    expect(reply.details).toMatchObject({ status: 'stale' });
    expect((reply.details as any).hours).toBeUndefined();
  });

  it('rejects incomplete, duplicate, or invalid hourly data', async () => {
    const fetch = mockRead(evidence({ forecast: { ...evidence().forecast, hours: evidence().forecast.hours.slice(0, 5) } }));
    const tool = new WeatherAssistantTools().tools(scope)[0] as any;
    expect((await tool.execute('a', { hours: 6 })).details).toMatchObject({ status: 'partial' });
    const duplicate = evidence().forecast.hours;
    fetch.mockResolvedValue({ ok: true, json: async () => evidence({ forecast: { ...evidence().forecast, hours: [duplicate[0], duplicate[0], ...duplicate.slice(1)] } }) } as Response);
    expect((await tool.execute('b', {})).details).toMatchObject({ status: 'partial' });
    fetch.mockResolvedValue({ ok: true, json: async () => evidence({ forecast: { ...evidence().forecast, hours: [{ ...duplicate[0], precipitationMm: -4 }, ...duplicate.slice(1)] } }) } as Response);
    expect((await tool.execute('c', {})).details).toMatchObject({ status: 'partial' });
  });

  it('exposes current findings as provisional evidence without official warnings or delivery authority', async () => {
    mockRead();
    const tool = new WeatherAssistantTools().tools(scope).find(tool => tool.name === 'weather_get_findings')! as any;
    const reply = await tool.execute('a', {});
    expect(reply.details).toMatchObject({ status: 'available', officialWarnings: 'unavailable', automationEligible: false });
    expect((reply.details as any).findings).toEqual([expect.objectContaining({
      eventType: 'rain', evidenceRefs: ['hour:3'], startsAtLocal: expect.stringContaining('13:00'),
    })]);
  });


  it('uses the Sofia daylight-saving offset in summer, not a hard-coded +2 hours', async () => {
    const summerStart = Date.parse('2026-07-05T09:00:00.000Z');
    const summerNow = summerStart + 15 * 60_000;
    jest.setSystemTime(summerNow);
    const body = evidence();
    body.forecast.capturedAt = new Date(summerNow - 60_000).toISOString();
    body.forecast.hours = body.forecast.hours.map((hour, index) => ({
      ...hour, time: new Date(summerStart + index * 3_600_000).toISOString(),
    }));
    body.findings = [];
    mockRead(body);
    const reply = await (new WeatherAssistantTools().tools(scope)[0] as any).execute('summer', { hours: 6 });
    expect(reply.details).toMatchObject({ status: 'available', timeZone: 'Europe/Sofia' });
    expect(reply.details.hours[0].localTime).toContain('12:00');
  });

  it('reports bounded HTTP failure categories without exposing Core response bodies', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 403, ok: false,
      text: async () => 'sensitive backend response', } as Response);
    const tool = new WeatherAssistantTools().tools(scope)[0] as any;
    const forbidden = await tool.execute('forbidden', { hours: 6 });
    expect(forbidden.details).toMatchObject({ status: 'unavailable', reasonCode: 'core_forbidden' });
    expect(JSON.stringify(forbidden)).not.toContain('sensitive backend response');
    fetch.mockRejectedValue(Object.assign(new Error('deadline exceeded'), { name: 'TimeoutError' }));
    expect((await tool.execute('timeout', {})).details).toMatchObject({ reasonCode: 'core_timeout' });
  });

  it('does not mislabel a missing or invalid source timezone as Bulgarian local time', async () => {
    mockRead(evidence({ forecast: { ...evidence().forecast, timeZone: 'not-an-iana-zone' } }));
    const tool = new WeatherAssistantTools().tools(scope)[0] as any;
    const reply = await tool.execute('timezone-fallback', { hours: 6 });
    expect(reply.details).toMatchObject({ status: 'available', timeZone: 'UTC' });
    expect(reply.details.hours[0].localTime).toContain('09:00');
  });

  it('fails closed when LAB mode, bridge token or upstream is unavailable', async () => {
    delete process.env.WEATHER_INVESTIGATOR_API_TOKEN;
    const fetch = jest.spyOn(global, 'fetch');
    const tool = new WeatherAssistantTools().tools(scope)[0] as any;
    expect((await tool.execute('a', {})).details).toMatchObject({ status: 'unavailable', reasonCode: 'scope_or_token_missing' });
    expect(fetch).not.toHaveBeenCalled();
    process.env.WEATHER_INVESTIGATOR_API_TOKEN = 'lab-token';
    fetch.mockRejectedValue(new Error('network offline'));
    expect((await tool.execute('b', {})).details).toMatchObject({ status: 'unavailable' });
    process.env.ENERGRID_LAB_MODE = 'false';
    expect((await tool.execute('c', {})).details).toMatchObject({ status: 'unavailable' });
  });
});
