import { PortalWeatherController } from './portal-weather.controller';
describe('portal weather read bridge', () => {
  const original = process.env;
  afterEach(() => { process.env = original; jest.restoreAllMocks(); });
  it('rejects unauthorized requests before contacting core', async () => {
    process.env = { ...original, PORTAL_CONTROL_TOKEN: 'test-token' };
    const fetch = jest.spyOn(global,'fetch');
    await expect(new PortalWeatherController().dashboard({ headers: {} } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('proxies only the fixed read route without forwarding credentials', async () => {
    process.env = { ...original, PORTAL_CONTROL_TOKEN: 'test-token', ENERGRID_CORE_URL: 'http://127.0.0.1:3102' };
    const fetch = jest.spyOn(global,'fetch').mockResolvedValue({ ok: true, json: async () => ({ status: 'available' }) } as Response);
    expect(await new PortalWeatherController().performance({ headers: { authorization: 'Bearer test-token' } } as never)).toEqual({ status: 'available' });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3102/core/weather/performance', { signal: expect.anything() });
  });
  it('returns a friendly unavailable response when core is offline', async () => {
    process.env = { ...original, PORTAL_CONTROL_TOKEN: 'test-token' };
    jest.spyOn(global,'fetch').mockRejectedValue(new Error('offline'));
    await expect(new PortalWeatherController().dashboard({ headers: { authorization: 'Bearer test-token' } } as never)).rejects.toThrow('Weather service unavailable');
  });
});
