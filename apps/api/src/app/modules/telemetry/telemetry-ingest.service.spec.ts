import { Logger } from '@nestjs/common';
import { TelemetryIngestService } from './telemetry-ingest.service';
import {
  ConflictingElectricalReadingError,
  TelemetryStore,
} from './telemetry.store';
import { telemetryConfig } from './telemetry.config';
import { testDevice, testReading, testSpool } from './telemetry-test.fixture';

const now = new Date('2026-10-11T01:00:01Z');
const payload = () => ({ deviceId: 'meter', readings: [testReading()] });
const setup = (
  enabled = true,
  maxPendingWrites = 100_000,
  data?: Map<string, unknown>,
) => {
  const buffer = testSpool(maxPendingWrites, enabled, data);
  const store = { append: jest.fn().mockResolvedValue('stored') };
  const service = new TelemetryIngestService(
    buffer.config,
    store as unknown as TelemetryStore,
    buffer.spool,
  );
  return {
    ...buffer,
    store,
    service,
    capture: () => service.capture(payload(), testDevice(), 'shelly', now),
  };
};
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('approved durable electrical ingestion', () => {
  it('resolves admission after buffering, before any database write, with trusted identity and original time', async () => {
    const { service, spool, store } = setup();
    await service.capture(payload(), testDevice(), 'energrid-native', now);
    expect(store.append).not.toHaveBeenCalled();
    expect((await spool.peek())!.value).toEqual({
      ...testReading(),
      source: 'energrid-native',
    });
    await service.flush();
    expect(store.append).toHaveBeenCalledWith({
      ...testReading(),
      source: 'energrid-native',
    });
    expect(service.status()).toEqual(
      expect.objectContaining({
        stored: 1,
        pending: 0,
        failed: 0,
        rejected: 0,
        replayBlocked: false,
      }),
    );
  });
  it.each([
    undefined,
    null,
    {},
    { deviceId: 'meter', values: { power: 500, temperature: 20 } },
  ])('ignores untyped input %j', async (input) => {
    const { service, factory } = setup();
    await service.capture(input, testDevice(), 'legacy', now);
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['discovered', 'blocked'] as const)(
    'rejects %s sources',
    async (trustStatus) => {
      const { service, factory } = setup();
      await service.capture(
        payload(),
        { ...testDevice(), trustStatus },
        'shelly',
        now,
      );
      expect(factory).not.toHaveBeenCalled();
      expect(service.status().rejected).toBe(1);
    },
  );
  it.each([
    undefined,
    { ...testDevice(), kind: 'logical' },
    { ...testDevice(), capabilities: [] },
    { ...testDevice(), capabilities: [{ kind: 'power', actions: [] }] },
  ])('rejects missing/logical/non-reading sources', async (device) => {
    const { service, factory } = setup();
    await service.capture(
      payload(),
      device as ReturnType<typeof testDevice>,
      'shelly',
      now,
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    { deviceId: 'other' },
    { tenantId: 'other' },
    { siteId: 'other' },
    { readings: [] },
    { readings: 'not-array' },
    { readings: [null] },
    { readings: Array(33).fill(testReading()) },
    { readings: [testReading(), testReading({ unit: 'kWh' })] },
  ])('rejects invalid envelopes atomically %j', async (patch) => {
    const { service, factory } = setup();
    await service.capture(
      { ...payload(), ...patch },
      testDevice(),
      'shelly',
      now,
    );
    expect(factory).not.toHaveBeenCalled();
    expect(service.status().rejected).toBe(1);
  });
  it('retains failed database writes and retries without changing provenance', async () => {
    const { service, store, capture } = setup();
    store.append.mockRejectedValueOnce(
      new Error('postgres://private:secret@host'),
    );
    await capture();
    await service.runCycle();
    expect(service.status()).toEqual(
      expect.objectContaining({
        failed: 1,
        pending: 1,
        stored: 0,
        replayBlocked: true,
      }),
    );
    await service.runCycle();
    expect(store.append.mock.calls[1][0]).toEqual(
      store.append.mock.calls[0][0],
    );
    expect(service.status()).toEqual(
      expect.objectContaining({ pending: 0, stored: 1, replayBlocked: false }),
    );
    expect(
      JSON.stringify((Logger.prototype.error as jest.Mock).mock.calls),
    ).not.toContain('secret');
  });
  it('resumes an existing disk backlog after a restart without fresh registry admission', async () => {
    const first = setup();
    await first.capture();
    await first.service.onModuleDestroy();
    await first.spool.close();
    const next = setup(true, 100_000, first.data);
    await next.service.runCycle();
    expect(next.store.append).toHaveBeenCalledWith(testReading());
    expect(next.service.status().pending).toBe(0);
  });
  it('safely replays after database commit but failed local removal', async () => {
    const first = setup();
    await first.capture();
    first.db.batch.mockRejectedValueOnce(new Error('disk failure'));
    await first.service.runCycle();
    expect(first.service.status().pending).toBe(1);
    await first.spool.close();
    const second = setup(true, 100_000, first.data);
    second.store.append.mockResolvedValue('duplicate');
    await second.service.runCycle();
    expect(second.service.status()).toEqual(
      expect.objectContaining({ duplicates: 1, pending: 0 }),
    );
  });
  it('quarantines permanent conflicts without blocking subsequent readings', async () => {
    const { service, store, capture, data } = setup();
    await capture();
    await capture();
    store.append.mockRejectedValueOnce(new ConflictingElectricalReadingError());
    await service.runCycle();
    expect(service.status()).toEqual(
      expect.objectContaining({
        stored: 1,
        pending: 0,
        buffer: expect.objectContaining({ quarantined: 1 }),
      }),
    );
    expect([...data.values()]).toContainEqual({
      reason: 'conflicting-reading',
      reading: testReading(),
    });
  });
  it('preserves invalid restored entries rather than sending them to PostgreSQL', async () => {
    const { service, store, capture, data } = setup();
    await capture();
    data.set([...data.keys()].find((k) => k.startsWith('p:'))!, {
      schemaVersion: 900,
    });
    await service.runCycle();
    expect(store.append).not.toHaveBeenCalled();
    expect([...data.values()]).toContainEqual({
      reason: 'invalid-reading',
      reading: { schemaVersion: 900 },
    });
  });
  it('rejects admission on disk errors/full capacity without evicting old readings', async () => {
    const { service, capture, db } = setup(true, 1);
    await capture();
    await expect(capture()).rejects.toThrow('buffering unavailable');
    expect(service.status().pending).toBe(1);
    await service.runCycle();
    db.batch.mockRejectedValueOnce(new Error('private disk path'));
    await expect(capture()).rejects.toThrow('buffering unavailable');
    expect(service.status().failed).toBe(2);
  });
  it('prevents overlapping replay cycles and caps each pass', async () => {
    const { service, spool, store } = setup();
    jest
      .spyOn(spool, 'peek')
      .mockResolvedValue({ key: 'p:0000000000000000', value: testReading() });
    jest.spyOn(spool, 'finish').mockResolvedValue(undefined);
    const cycle = service.runCycle();
    expect(service.runCycle()).toBe(cycle);
    await cycle;
    expect(store.append).toHaveBeenCalledTimes(500);
  });
  it('replays at startup and periodically, and leaves remaining disk data on shutdown', async () => {
    jest.useFakeTimers();
    const { service, store, capture } = setup();
    await capture();
    await service.onModuleInit();
    await service.runCycle();
    expect(store.append).toHaveBeenCalledTimes(1);
    await capture();
    await jest.advanceTimersByTimeAsync(5000);
    expect(store.append).toHaveBeenCalledTimes(2);
    await capture();
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(service.status().pending).toBe(1);
    await expect(capture()).rejects.toThrow('closing');
  });
  it('does not touch local disk or PostgreSQL when disabled', async () => {
    const { service, factory, store, capture } = setup(false);
    await service.onModuleInit();
    await capture();
    await service.flush();
    await service.onModuleDestroy();
    expect(factory).not.toHaveBeenCalled();
    expect(store.append).not.toHaveBeenCalled();
  });

  it('waits for admissions and the current database write, leaving later readings durably queued on shutdown', async () => {
    const { service, store, capture, spool } = setup();
    let admit!: () => void;
    jest.spyOn(spool, 'enqueue').mockReturnValueOnce(
      new Promise((resolve) => {
        admit = resolve;
      }),
    );
    const admission = capture();
    const finished = jest.fn();
    const closingAdmission = service.onModuleDestroy().then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    admit();
    await admission;
    await closingAdmission;

    const next = setup();
    await next.capture();
    await next.capture();
    let commit!: () => void;
    next.store.append.mockReturnValueOnce(
      new Promise((resolve) => {
        commit = () => resolve('stored');
      }),
    );
    const running = next.service.runCycle();
    for (let i = 0; i < 20 && !next.store.append.mock.calls.length; i++)
      await Promise.resolve();
    const stopped = jest.fn();
    const shutdown = next.service.onModuleDestroy().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    commit();
    await running;
    await shutdown;
    expect(next.service.status()).toEqual(
      expect.objectContaining({ stored: 1, pending: 1 }),
    );
    expect(store.append).not.toHaveBeenCalled();
  });
});

describe('telemetry configuration', () => {
  it('is disabled by default with no implicit disk location or retention deletion', () => {
    expect(telemetryConfig({})).toEqual({
      enabled: false,
      databaseUrl: null,
      rollupIntervalMs: 300000,
      maxPendingWrites: 100_000,
      spoolDirectory: null,
      replayIntervalMs: 5000,
    });
  });
  it('requires an explicit database and persistent absolute spool path', () => {
    expect(() => telemetryConfig({ TELEMETRY_ENABLED: 'true' })).toThrow(
      'DATABASE_URL',
    );
    for (const path of [undefined, '', './temporary'])
      expect(() =>
        telemetryConfig({
          TELEMETRY_ENABLED: 'true',
          TELEMETRY_DATABASE_URL: 'private',
          TELEMETRY_SPOOL_DIRECTORY: path,
        }),
      ).toThrow('SPOOL_DIRECTORY');
    expect(
      telemetryConfig({
        TELEMETRY_ENABLED: 'true',
        TELEMETRY_DATABASE_URL: ' private ',
        TELEMETRY_SPOOL_DIRECTORY: '/var/lib/energrid/telemetry',
      }).spoolDirectory,
    ).toBe('/var/lib/energrid/telemetry');
  });
  it.each(['0', '-1', '1.5', 'abc', '100000000'])(
    'rejects unsafe limits %s',
    (value) => {
      for (const key of [
        'TELEMETRY_ROLLUP_INTERVAL_MS',
        'TELEMETRY_MAX_PENDING_WRITES',
        'TELEMETRY_REPLAY_INTERVAL_MS',
      ])
        expect(() => telemetryConfig({ [key]: value })).toThrow();
    },
  );
});
