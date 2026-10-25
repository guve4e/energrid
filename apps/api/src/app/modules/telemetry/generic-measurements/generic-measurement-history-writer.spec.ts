import { GenericMeasurementHistoryWriter, HistoryOutboxUnavailableError } from './generic-measurement-history-writer';

const observation = {
  tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device:stable',
  sourceId: 'energrid-http-status', selector: '/api/v1/status', evidenceId: 'boot-2-sample-7',
  fields: [{ field: 'temperature', value: 22.5, observedAt: '2026-10-23T12:00:00.000Z', receivedAt: '2026-10-23T12:00:01.000Z' }],
};
const policies = { temperature: { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 } };

function memoryOutbox() {
  const entries: any[] = [];
  let next = 0;
  return {
    open: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn(async (items: any[]) => {
      for (const item of items) {
        if (!entries.some(entry => entry.sampleId === item.measurement.sampleId)) {
          entries.push({ ...item, sampleId: item.measurement.sampleId, key: `p:${String(next++).padStart(16, '0')}` });
        }
      }
    }),
    peek: jest.fn(async () => entries[0]),
    complete: jest.fn(async (entry: any) => { entries.shift(); }),
  };
}

describe('GenericMeasurementHistoryWriter', () => {
  it('durably queues approved numeric fields before writing stable scoped history samples', async () => {
    const ensureEnrollmentReference = jest.fn().mockResolvedValue(undefined);
    const appendIfDue = jest.fn().mockResolvedValue({ outcome: 'stored', reason: 'initial' });
    const outbox = memoryOutbox();
    const writer = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, true, policies, outbox);
    await expect(writer.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'stored', reason: 'initial' },
    ]);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(ensureEnrollmentReference).toHaveBeenCalledWith({
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device:stable',
    });
    const first = appendIfDue.mock.calls[0][0];
    expect(first).toMatchObject({
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device:stable',
      componentId: 'device', channel: 'temperature', metric: 'temperature', unit: 'Cel',
      value: 22.5, source: 'energrid-http-status', provenance: 'approved:energrid-http-status',
    });
    expect(first.sampleId).toMatch(/^[a-f0-9]{64}$/);
    await writer.persistAccepted(observation);
    expect(appendIfDue.mock.calls[1][0].sampleId).toBe(first.sampleId);
  });

  it('reports disabled writes, and keeps database failures pending for background retry', async () => {
    const ensureEnrollmentReference = jest.fn();
    const appendIfDue = jest.fn().mockRejectedValue(new Error('db unavailable'));
    const outbox = memoryOutbox();
    const disabled = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, false, policies, outbox);
    await expect(disabled.persistAccepted(observation)).resolves.toEqual([{ field: 'temperature', outcome: 'disabled' }]);
    expect(appendIfDue).not.toHaveBeenCalled();
    expect(ensureEnrollmentReference).not.toHaveBeenCalled();

    const enabled = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference: jest.fn().mockResolvedValue(undefined), appendIfDue } as never, true, policies, memoryOutbox());
    await expect(enabled.persistAccepted(observation)).resolves.toEqual([{ field: 'temperature', outcome: 'pending' }]);
  });

  it('reports missing metric policy without queuing or attempting a write', async () => {
    const ensureEnrollmentReference = jest.fn();
    const appendIfDue = jest.fn();
    const outbox = memoryOutbox();
    const writer = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, true, {}, outbox);
    await expect(writer.persistAccepted(observation)).resolves.toEqual([{ field: 'temperature', outcome: 'policy_missing' }]);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(appendIfDue).not.toHaveBeenCalled();
  });

  it('leaves an enrollment-reference failure in the durable queue for a later replay', async () => {
    const ensureEnrollmentReference = jest.fn().mockRejectedValue(Object.assign(new Error('database unavailable'), { code: '08006' }));
    const appendIfDue = jest.fn();
    const outbox = memoryOutbox();
    const writer = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, true, policies, outbox);
    await expect(writer.persistAccepted(observation)).resolves.toEqual([{ field: 'temperature', outcome: 'pending' }]);
    expect(outbox.peek).toHaveBeenCalled();
    expect(appendIfDue).not.toHaveBeenCalled();
  });

  it('rejects ingress when the local queue cannot durably accept an accepted sample', async () => {
    const outbox = memoryOutbox();
    outbox.enqueue.mockRejectedValue(new Error('disk unavailable'));
    const writer = new GenericMeasurementHistoryWriter({
      ensureEnrollmentReference: jest.fn(), appendIfDue: jest.fn(),
    } as never, true, policies, outbox);
    await expect(writer.persistAccepted(observation)).rejects.toBeInstanceOf(HistoryOutboxUnavailableError);
  });
});
