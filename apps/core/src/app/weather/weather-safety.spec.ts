import { assessWeather, HOUR_MS, WeatherSnapshot } from './weather-data-quality';
import { WeatherRiskEngine } from './weather-risk.engine';
import { WeatherIntelligenceService } from './weather-intelligence.service';
import { WeatherProviderService } from './weather-provider.service';
import { compareWeather } from './weather-comparison';
import { WeatherService } from './weather.service';
import { WeatherController } from './weather.controller';

const now = Date.parse('2026-09-23T12:20:00Z');
function snapshot(): WeatherSnapshot {
  const current = { time: new Date(now).toISOString(), temperature: 22, feelsLike: 22,
    humidity: 50, pressure: 1010, windKmh: 10, gustKmh: 20, weatherCode: 0, condition: 'Clear sky' };
  return { location: 'Vidin', coordinates: { latitude: 43.9916, longitude: 22.8728 },
    provider: 'open-meteo', availability: 'available', fetchedAt: new Date(now).toISOString(),
    units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' }, current,
    hourly: Array.from({ length: 12 }, (_, i) => ({ ...current,
      time: new Date(Math.floor(now / HOUR_MS) * HOUR_MS + i * HOUR_MS).toISOString(),
      rainChance: 0, precipitationMm: 0, rainMm: 0, showersMm: 0 })), daily: [], alerts: [] };
}
const risk = new WeatherRiskEngine();
const intelligence = new WeatherIntelligenceService();
beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { jest.restoreAllMocks(); });

describe('weather data quality and decisions', () => {
  it('accepts complete fresh data without authorizing device commands', () => {
    expect(assessWeather(snapshot())).toMatchObject({ status: 'available', forecastUsable: true, automationEligible: false });
  });
  it.each(['empty', 'missing', 'gap', 'duplicate', 'old', 'future', 'invalid-code', 'invalid-probability'])('does not call %s data safe', variant => {
    const s = snapshot();
    if (variant === 'empty') s.hourly = [];
    if (variant === 'missing') s.hourly[0].gustKmh = null;
    if (variant === 'gap') s.hourly.splice(2, 1);
    if (variant === 'duplicate') s.hourly[1].time = s.hourly[0].time;
    if (variant === 'old') s.current.time = new Date(now - 3 * HOUR_MS).toISOString();
    if (variant === 'future') s.fetchedAt = new Date(now + HOUR_MS).toISOString();
    if (variant === 'invalid-code') s.hourly[0].weatherCode = 999;
    if (variant === 'invalid-probability') s.hourly[0].rainChance = 101;
    expect(risk.evaluate(s).level).toBe('unknown');
    const result = intelligence.analyze(s, null, risk.evaluate(s));
    expect(result.severity).toBe('unknown');
    expect(result.radarSummary.eta).toBeNull();
    expect(result.today.rainTotalMm).toBeNull();
  });
  it('rejects a stale fetch even when observation timestamps look current', () => {
    const s = snapshot(); s.fetchedAt = new Date(now - HOUR_MS).toISOString();
    expect(assessWeather(s).status).toBe('stale');
  });
  it('uses the same inclusive severe wind threshold', () => {
    const s = snapshot(); s.current.gustKmh = 70; s.hourly[0].gustKmh = 70;
    expect(risk.evaluate(s).risks).toContain('HIGH_WIND');
    expect(intelligence.analyze(s, null, risk.evaluate(s)).severity).toBe('danger');
    s.current.gustKmh = 69.9; s.hourly[0].gustKmh = 69.9;
    expect(risk.evaluate(s).risks).not.toContain('HIGH_WIND');
  });
  it('uses weather codes rather than English labels for thunderstorms', () => {
    const s = snapshot(); s.current.condition = 'Localized label'; s.current.weatherCode = 95;
    expect(risk.evaluate(s).risks).toContain('THUNDERSTORM');
  });
  it('does not fabricate radar evidence from a storm forecast', () => {
    const s = snapshot(); s.hourly[1].weatherCode = 96;
    const result = intelligence.analyze(s, null, risk.evaluate(s));
    expect(result.severity).toBe('danger');
    expect(result.confidence).toBe('single-source');
    expect(result.radarSummary).toMatchObject({ status: 'unavailable', nearestCell: null, eta: null });
  });
});

describe('weather provider boundary', () => {
  it.each(['network', 'http', 'malformed'])('returns unavailable on %s failure without invented readings', async variant => {
    const mock = jest.spyOn(global, 'fetch');
    if (variant === 'network') mock.mockRejectedValue(new Error('offline'));
    else mock.mockResolvedValue({ ok: variant !== 'http', status: 503, json: async () => null } as Response);
    const s = await new WeatherProviderService().getSnapshot();
    expect(s.availability).toBe('unavailable');
    expect(s.current.temperature).toBeNull();
    expect(s.current.gustKmh).toBeNull();
    expect(risk.evaluate(s).level).toBe('unknown');
  });
  it('normalizes UTC instants and rejects nonnumeric measurements', async () => {
    const mock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({
      current: { time: now / 1000, temperature_2m: '22', wind_gusts_10m: 20, weather_code: 0 },
      hourly: { time: [now / 1000], precipitation: [0] },
      daily: { time: [Date.parse('2026-09-22T21:00:00Z') / 1000] },
    }) } as Response);
    const s = await new WeatherProviderService().getSnapshot();
    expect(s.current.time).toBe('2026-09-23T12:20:00.000Z');
    expect(s.current.temperature).toBeNull();
    expect(s.hourly[0].precipitationMm).toBe(0);
    expect(s.daily[0].date).toBe('2026-09-23');
    expect(mock.mock.calls[0][0]).toContain('timeformat=unixtime');
    expect(mock.mock.calls[0][1]?.signal).toBeDefined();
  });
});

it('renders unknown weather and labels radar history honestly', () => {
  const html = new WeatherController({} as never).getMonitorPage();
  expect(html).toContain('WEATHER UNAVAILABLE');
  expect(html).toContain('RainViewer past radar');
  expect(html).not.toContain('data.radar?.nowcast');
});


describe('forecast comparison', () => {
  it('preserves a warning from the less optimistic model', () => {
    const a = snapshot(); a.model = 'icon_seamless';
    const b = snapshot(); b.model = 'ncep_gfs_seamless'; b.hourly[2].gustKmh = 80;
    const result = compareWeather([a, b], null, risk, intelligence);
    expect(result.comparison.status).toBe('disagreement');
    expect(result.comparison.gustSpreadKmh).toBe(60);
    expect(result.comparison.selectedModel).toBe('ncep_gfs_seamless');
    expect(result.selected.intelligence.severity).toBe('danger');
    expect(result.comparison.automationEligible).toBe(false);
  });
  it('keeps an unavailable model visible without using it as corroboration', () => {
    const a = snapshot(); a.model = 'icon_seamless'; a.availability = 'unavailable';
    const b = snapshot(); b.model = 'ncep_gfs_seamless';
    const result = compareWeather([a, b], null, risk, intelligence);
    expect(result.comparison.status).toBe('insufficient-data');
    expect(result.comparison.usableModels).toBe(1);
    expect(result.selected.snapshot).toBe(b);
    expect(result.comparison.sources[0].dataQuality.status).toBe('unavailable');
  });
  it('reports agreement with shared transport provenance, not independent provider confidence', () => {
    const a = snapshot(); a.model = 'icon_seamless';
    const b = snapshot(); b.model = 'ncep_gfs_seamless';
    const result = compareWeather([a, b], null, risk, intelligence);
    expect(result.comparison.status).toBe('agreement');
    expect(result.comparison.transportProviders).toEqual(['open-meteo']);
  });
  it('keeps all-source failure unknown', () => {
    const a = snapshot(); a.availability = 'unavailable';
    const result = compareWeather([a, a], null, risk, intelligence);
    expect(result.selected.intelligence.severity).toBe('unknown');
    expect(result.comparison.usableModels).toBe(0);
  });
});

it('deduplicates concurrent model requests and retries after cache expiry', async () => {
  const mock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ current: {}, hourly: {}, daily: {} }) } as Response);
  const provider = new WeatherProviderService();
  await Promise.all([provider.getSnapshot('icon_seamless'), provider.getSnapshot('icon_seamless')]);
  await provider.getSnapshot('icon_seamless');
  expect(mock).toHaveBeenCalledTimes(1);
  await provider.getSnapshot('ncep_gfs_seamless');
  expect(mock).toHaveBeenCalledTimes(2);
  jest.spyOn(Date, 'now').mockReturnValue(now + 11 * 60000);
  await provider.getSnapshot('icon_seamless');
  expect(mock).toHaveBeenCalledTimes(3);
});

it('surfaces future danger and river failure through the dashboard', async () => {
  const a = snapshot(); a.model = 'icon_seamless';
  const b = snapshot(); b.model = 'ncep_gfs_seamless'; b.hourly[3].gustKmh = 80;
  const provider = { getSnapshot: jest.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b) };
  const river = { getVidinRiverData: jest.fn().mockRejectedValue(new Error('offline')) };
  const dashboard = await new WeatherService(provider as never, risk, river as never, intelligence).getDashboard();
  expect(dashboard.riskReport.level).toBe('high');
  expect(dashboard.comparison.status).toBe('disagreement');
  expect(dashboard.river).toBeNull();
  expect(dashboard.intelligence.risks.floodConcern).toBe('unknown');
});

it('does not count duplicate model snapshots as independent corroboration', () => {
  const a = snapshot(); a.model = 'icon_seamless';
  expect(compareWeather([a, a], null, risk, intelligence).comparison.usableModels).toBe(1);
});
