import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicLevel } from 'classic-level';
import { Logger } from '@nestjs/common';
import { GenericMeasurementHistoryOutbox } from './generic-measurement-history-outbox';

describe('GenericMeasurementHistoryOutbox', () => {
  let directory: string;
  const createOutbox = () => new GenericMeasurementHistoryOutbox(
    { historyOutboxDirectory: directory, maxPendingWrites: 2 } as never,
    path => new ClassicLevel<string, unknown>(path, { valueEncoding: 'json' }),
  );

  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'energrid-history-outbox-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('recovers pending history after restart and deduplicates repeated enqueue', async () => {
    const item = {
      field: 'temperature',
      measurement: { sampleId: 'a'.repeat(64), value: 22.5 },
      policy: { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 },
    };
    const first = createOutbox();
    await first.enqueue([item]);
    await first.enqueue([item]);
    expect(first.status().pending).toBe(1);
    await first.close();

    const restarted = createOutbox();
    const pending = await restarted.peek();
    expect(pending).toMatchObject({ field: 'temperature', sampleId: 'a'.repeat(64), measurement: item.measurement });
    await restarted.complete(pending!);
    expect(restarted.status().pending).toBe(0);
    await restarted.close();
  });

  it('does not evict pending history when capacity is exhausted', async () => {
    const outbox = createOutbox();
    await outbox.enqueue(['b', 'c'].map(sample => ({
      field: 'temperature', measurement: { sampleId: sample.repeat(64) }, policy: {},
    })));
    await expect(outbox.enqueue([{
      field: 'temperature', measurement: { sampleId: 'd'.repeat(64) }, policy: {},
    }])).rejects.toThrow('capacity exceeded');
    expect(outbox.status().pending).toBe(2);
    await outbox.close();
  });

  it('logs the initialization stage and safe underlying storage error details', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const storageError = Object.assign(new Error('EACCES opening /Users/private-user/.energrid/measurement-history-outbox authorization: Bearer super-secret-token'), { code: 'EACCES' });
    const outbox = new GenericMeasurementHistoryOutbox(
      { historyOutboxDirectory: directory, maxPendingWrites: 2 } as never,
      () => ({ open: async () => { throw storageError; } } as never),
    );

    await expect(outbox.open()).rejects.toMatchObject({
      message: 'Measurement history outbox could not open; check storage and exclusive ownership',
      cause: storageError,
    });
    const diagnostic = String(logger.mock.calls[0]?.[0]);
    expect(diagnostic).toContain('"stage":"open"');
    expect(diagnostic).toContain('"code":"EACCES"');
    expect(diagnostic).toContain('[path]');
    expect(diagnostic).not.toContain('/Users/private-user');
    expect(diagnostic).not.toContain('super-secret-token');
    logger.mockRestore();
  });
});
