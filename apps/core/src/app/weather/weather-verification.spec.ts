import { WeatherVerificationService } from './weather-verification.service';
import { WeatherVerificationController } from './weather-verification.controller';
import { WeatherVerificationScheduler } from './weather-verification.scheduler';
import { WeatherRiskEngine } from './weather-risk.engine';
import { WeatherIntelligenceService } from './weather-intelligence.service';
import { WeatherSnapshot, HOUR_MS } from './weather-data-quality';
import { RiverForecastRecorderService } from './river/forecast-monitoring/river-forecast-recorder.service';
import { RiverSchedulerService } from './river/river-scheduler.service';

export function verificationSnapshot(now = Date.now()): WeatherSnapshot {
  const reading = { time: new Date(now).toISOString(), temperature: 20, feelsLike: 20, humidity: 50,
    pressure: 1000, windKmh: 10, gustKmh: 20, weatherCode: 0, condition: 'Clear' };
  return { location: 'Vidin', coordinates: { latitude: 43.9916, longitude: 22.8728 }, provider: 'open-meteo',
    model: 'icon_seamless', fetchedAt: new Date(now).toISOString(), availability: 'available',
    units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' }, current: reading, daily: [], alerts: [],
    hourly: Array.from({ length: 30 }, (_, i) => ({ ...reading, time: new Date(Math.floor(now/HOUR_MS)*HOUR_MS+i*HOUR_MS).toISOString(),
      rainChance: 80, precipitationMm: 2, rainMm: 2, showersMm: 0 })) };
}
describe('weather verification boundaries', () => {
  const originalEnv = process.env;
  afterEach(() => { jest.restoreAllMocks(); process.env = originalEnv; });
  it('records individual models and selected policy once per run key, without backdated windows', async () => {
    const now = new Date('2026-09-24T10:20:00Z');
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const service = new WeatherVerificationService({ query } as never);
    const a = verificationSnapshot(now.getTime()); const b = { ...a, model: 'ncep_gfs_seamless' };
    expect((await service.record([a,b],a,now)).recorded).toBe(27);
    for (const [sql, args] of query.mock.calls) {
      expect(sql).toContain('DO NOTHING');
      expect(new Date(args[5]).getTime()).toBeGreaterThan(now.getTime());
      if (args[6]) expect(new Date(args[6]).getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
    expect(query.mock.calls.some(([,args]) => args[2] === 'selected-cautious:weather-v1')).toBe(true);
  });
  it('rejects invalid batches before opening a transaction', async () => {
    const connect = jest.fn(); const service = new WeatherVerificationService({ connect } as never);
    await expect(service.ingest('station','site',[{ metric:'temperature_c',value:20,observedAt:new Date().toISOString() },
      { metric:'gust_kmh',value:10,observedAt:new Date().toISOString() }])).rejects.toThrow('one-hour window');
    await expect(service.ingest('station','site',[{ metric:'temperature_c',value:NaN,observedAt:new Date().toISOString() }])).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it('requires the configured observation credential and never trusts a caller source label', async () => {
    process.env = { ...originalEnv, WEATHER_OBSERVATION_TOKEN: 'test-secret', WEATHER_OBSERVATION_SOURCE: 'outdoor-station' };
    const ingest = jest.fn().mockResolvedValue({ recorded: 1 });
    const controller = new WeatherVerificationController({ ingest } as never);
    await expect(controller.observe('Bearer wrong',{ observations: [] })).rejects.toThrow();
    expect(ingest).not.toHaveBeenCalled();
    await controller.observe('Bearer test-secret',{ observations: [] });
    expect(ingest).toHaveBeenCalledWith('outdoor-station','43.99160,22.87280',[]);
  });
  it('marks missing storage explicitly', async () => {
    const controller = new WeatherVerificationController({ performance: jest.fn().mockRejectedValue({ code: '42P01' }) } as never);
    expect(await controller.performance()).toMatchObject({ status: 'migration-required' });
  });
  it('does not overlap weather cycles and evaluates even after collection failure', async () => {
    let reject!: (reason: Error) => void;
    const provider = { getSnapshot: jest.fn(() => new Promise((_resolve, r) => { reject = r; })) };
    const verification = { record: jest.fn(), evaluate: jest.fn().mockResolvedValue({ evaluated: 0 }) };
    const scheduler = new WeatherVerificationScheduler(provider as never,new WeatherRiskEngine(),new WeatherIntelligenceService(),verification as never);
    const running = scheduler.runCycle(); await scheduler.runCycle();
    expect(provider.getSnapshot).toHaveBeenCalledTimes(2);
    reject(new Error('offline')); await running;
    expect(verification.evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('river verification corrections', () => {
  afterEach(() => jest.restoreAllMocks());
  it('uses actual issue time and preserves input reading time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T10:20:00Z'));
    try {
      const query = jest.fn().mockResolvedValue({ rowCount: 1 });
      const recorder = new RiverForecastRecorderService({ query } as never);
      await recorder.recordDashboardForecasts({ mainStation: { station: 'Vidin',levelCm: 100,fetchedAt: '2026-09-24T06:00:00Z',provider: 'appd-bg' },
        forecast: { projection: { next6h: { expectedCm: 110 }, next24h: { expectedCm: 130 } } } });
      const args = query.mock.calls[0][1];
      expect(args[2].toISOString()).toBe('2026-09-24T10:20:00.000Z');
      expect(args[3].toISOString()).toBe('2026-09-24T16:20:00.000Z');
      expect(JSON.parse(args[12]).sourceReading.fetchedAt).toBe('2026-09-24T06:00:00.000Z');
    } finally { jest.useRealTimers(); }
  });
  it('calls the river evaluator when collection fails', async () => {
    const evaluator = { evaluateDueForecasts: jest.fn().mockResolvedValue({ evaluated: 0 }) };
    const scheduler = new RiverSchedulerService({ collectNow: jest.fn().mockRejectedValue(new Error('offline')) } as never,{} as never,{} as never,evaluator as never);
    await (scheduler as unknown as { collectForecastAndEvaluateSafe(): Promise<void> }).collectForecastAndEvaluateSafe();
    expect(evaluator.evaluateDueForecasts).toHaveBeenCalledTimes(1);
  });
});
