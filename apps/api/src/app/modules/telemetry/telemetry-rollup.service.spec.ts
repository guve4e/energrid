import { Logger } from '@nestjs/common';
import { TelemetryRollupService } from './telemetry-rollup.service';
import { TelemetryStore } from './telemetry.store';
import { telemetryConfig } from './telemetry.config';

const setup = (enabled = true) => {
  const store = { refreshOneHour: jest.fn().mockResolvedValue(false) };
  const config = { ...telemetryConfig({}), enabled, rollupIntervalMs: 1000 };
  return {
    store,
    service: new TelemetryRollupService(
      config,
      store as unknown as TelemetryStore,
    ),
  };
};
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('incremental summary scheduling', () => {
  it('does not schedule or query anything when disabled', async () => {
    jest.useFakeTimers();
    const { service, store } = setup(false);
    service.onModuleInit();
    jest.advanceTimersByTime(5000);
    expect(await service.runCycle()).toBe(0);
    expect(store.refreshOneHour).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });
  it('runs immediately, repeats, and clears its timer on shutdown', async () => {
    jest.useFakeTimers();
    const { service, store } = setup();
    service.onModuleInit();
    await service.runCycle();
    expect(store.refreshOneHour).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(store.refreshOneHour).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5000);
    expect(store.refreshOneHour).toHaveBeenCalledTimes(2);
  });
  it('prevents overlapping cycles and drains work', async () => {
    const { service, store } = setup();
    let finish!: (work: boolean) => void;
    store.refreshOneHour.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = service.runCycle(),
      second = service.runCycle();
    expect(second).toBe(first);
    finish(true);
    expect(await first).toBe(1);
    expect(store.refreshOneHour).toHaveBeenCalledTimes(2);
  });
  it('limits each cycle so backfills do not monopolize the database', async () => {
    const { service, store } = setup();
    store.refreshOneHour.mockResolvedValue(true);
    expect(await service.runCycle()).toBe(500);
    expect(store.refreshOneHour).toHaveBeenCalledTimes(500);
  });
  it('drains a failed in-flight cycle during shutdown without preventing pool cleanup', async () => {
    const { service, store } = setup();
    let fail!: (error: Error) => void;
    store.refreshOneHour.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const cycle = service.runCycle();
    const closing = service.onModuleDestroy();
    fail(new Error('unavailable'));
    await expect(cycle).rejects.toThrow('unavailable');
    await expect(closing).resolves.toBeUndefined();
  });
  it('recovers after errors without logging connection secrets', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, store } = setup();
    store.refreshOneHour.mockRejectedValueOnce(new Error('postgres://secret'));
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(store.refreshOneHour).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls),
    ).not.toContain('secret');
    await service.onModuleDestroy();
  });
});
