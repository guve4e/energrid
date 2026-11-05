import { WeatherInvestigatorScheduler } from './weather-investigator.scheduler';

describe('weather investigator automatic collection', () => {
  const oldEnv = process.env;
  afterEach(() => {
    process.env = oldEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function enabled() {
    process.env = { ...oldEnv, ENERGRID_LAB_MODE: 'true', WEATHER_INVESTIGATOR_ENABLED: 'true' };
  }

  it('starts one collection on boot and schedules a 15-minute refresh by default', async () => {
    enabled();
    delete process.env.WEATHER_INVESTIGATOR_INTERVAL_MINUTES;
    jest.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z') });
    const service = { run: jest.fn().mockResolvedValue({ status: 'completed' }) };
    const scheduler = new WeatherInvestigatorScheduler(service as never);
    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(service.run).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot()).toMatchObject({
      enabled: true, running: false, intervalMinutes: 15, lastOutcome: 'completed',
      lastCompletedAt: '2026-11-05T10:00:00.000Z',
      nextAttemptAt: '2026-11-05T10:15:00.000Z',
    });
    await jest.advanceTimersByTimeAsync(15 * 60_000);
    expect(service.run).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
    expect(scheduler.snapshot().nextAttemptAt).toBeNull();
  });

  it('backs off when provider is unavailable and returns to normal cadence after recovery', async () => {
    enabled();
    jest.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z') });
    const service = { run: jest.fn()
      .mockResolvedValueOnce({ status: 'weather-unavailable' })
      .mockResolvedValueOnce({ status: 'completed' }) };
    const scheduler = new WeatherInvestigatorScheduler(service as never);
    await scheduler.runCycle();
    expect(scheduler.snapshot()).toMatchObject({ lastOutcome: 'weather-unavailable', consecutiveFailures: 1,
      nextAttemptAt: '2026-11-05T10:01:00.000Z' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(service.run).toHaveBeenCalledTimes(2);
    expect(scheduler.snapshot()).toMatchObject({ lastOutcome: 'completed', consecutiveFailures: 0,
      nextAttemptAt: '2026-11-05T10:16:00.000Z' });
    scheduler.onModuleDestroy();
  });

  it('ignores overlapping triggers while a collection is in flight', async () => {
    enabled();
    let finish: ((result: { status: string }) => void) | undefined;
    const service = { run: jest.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })) };
    const scheduler = new WeatherInvestigatorScheduler(service as never);
    const firstRun = scheduler.runCycle();
    await scheduler.runCycle();
    expect(service.run).toHaveBeenCalledTimes(1);
    finish?.({ status: 'completed' });
    await firstRun;
    scheduler.onModuleDestroy();
  });

  it('does not arm another retry after shutdown during an in-flight collection', async () => {
    enabled();
    jest.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z') });
    let finish: ((result: { status: string }) => void) | undefined;
    const service = { run: jest.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })) };
    const scheduler = new WeatherInvestigatorScheduler(service as never);
    scheduler.onModuleInit();
    expect(scheduler.snapshot().running).toBe(true);
    scheduler.onModuleDestroy();
    finish?.({ status: 'completed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.snapshot().nextAttemptAt).toBeNull();
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(service.run).toHaveBeenCalledTimes(1);
  });

  it('does not collect automatically when LAB is disabled', () => {
    process.env = { ...oldEnv, ENERGRID_LAB_MODE: 'false', WEATHER_INVESTIGATOR_ENABLED: 'true' };
    const service = { run: jest.fn() };
    const scheduler = new WeatherInvestigatorScheduler(service as never);
    scheduler.onModuleInit();
    expect(service.run).not.toHaveBeenCalled();
    expect(scheduler.snapshot().enabled).toBe(false);
  });
});
