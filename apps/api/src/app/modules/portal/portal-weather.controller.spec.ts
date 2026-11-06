import { PortalWeatherController } from './portal-weather.controller';
const registry = { getSnapshot: () => ({ tenant: { id: 'tenant-test' }, site: { id: 'site-test' } }) } as never;
describe('portal weather read bridge', () => {
  const original = process.env;
  afterEach(() => { process.env = original; jest.restoreAllMocks(); });
  it('rejects unauthorized requests before contacting core', async () => {
    process.env = { ...original };
    const fetch = jest.spyOn(global,'fetch');
    await expect(new PortalWeatherController(registry).dashboard({ headers: {} } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('proxies only the fixed read route without forwarding credentials', async () => {
    process.env = { ...original, ENERGRID_CORE_URL: 'http://127.0.0.1:3102' };
    const fetch = jest.spyOn(global,'fetch').mockResolvedValue({ ok: true, json: async () => ({ status: 'available' }) } as Response);
    expect(await new PortalWeatherController(registry).performance({ headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 } } as never)).toEqual({ status: 'available' });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3102/core/weather/performance', { signal: expect.anything() });
  });
  it('returns a friendly unavailable response when core is offline', async () => {
    process.env = { ...original };
    jest.spyOn(global,'fetch').mockRejectedValue(new Error('offline'));
    await expect(new PortalWeatherController(registry).dashboard({ headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 } } as never)).rejects.toThrow('Weather service unavailable');
  });

  it('uses an authenticated server-to-server bridge for scoped investigator runs', async () => {
    process.env = { ...original, WEATHER_INVESTIGATOR_API_TOKEN: 'lab-bridge-test' };
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ status: 'completed' }) } as Response);
    const request = { headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 } } as never;
    expect(await new PortalWeatherController(registry).runInvestigation(request)).toEqual({ status: 'completed' });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3020/core/weather/investigator/run', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer lab-bridge-test' }),
      body: JSON.stringify({ tenantId: 'tenant-test', siteId: 'site-test' }),
    }));
  });
  it('exposes only the authenticated site-scoped read model through the Portal', async () => {
    process.env = { ...original, WEATHER_INVESTIGATOR_API_TOKEN: 'lab-bridge-test' };
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ version: 1, status: 'stale' }),
    } as Response);
    const request = { headers: {}, user: {
      userId: 'test-user', email: 'admin@example.test', name: 'Admin',
      role: 'admin', sessionId: 'test-session', sessionVersion: 0,
    } } as never;
    await expect(new PortalWeatherController(registry).readModel(request))
      .resolves.toEqual({ version: 1, status: 'stale' });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3020/core/weather/investigator/read-model?tenantId=tenant-test&siteId=site-test',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer lab-bridge-test' }) }),
    );
  });

  it('exposes LAB readiness only to the authenticated administrator using the fixed site scope', async () => {
    process.env = { ...original, WEATHER_INVESTIGATOR_API_TOKEN: 'lab-bridge-test' };
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ version: 1, status: 'waiting_for_first_snapshot' }),
    } as Response);
    const controller = new PortalWeatherController(registry);
    const unauthorized = { headers: {} } as never;
    expect(() => controller.investigatorHealth(unauthorized)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const request = { headers: {}, user: {
      userId: 'test-user', email: 'admin@example.test', name: 'Admin',
      role: 'admin', sessionId: 'test-session', sessionVersion: 0,
    } } as never;
    expect(await controller.investigatorHealth(request)).toMatchObject({ status: 'waiting_for_first_snapshot' });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3020/core/weather/investigator/health?tenantId=tenant-test&siteId=site-test',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer lab-bridge-test' }) }),
    );
  });

});
