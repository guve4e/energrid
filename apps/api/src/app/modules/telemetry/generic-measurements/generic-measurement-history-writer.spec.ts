import { GenericMeasurementHistoryWriter } from './generic-measurement-history-writer';

const observation = {
  tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device:stable',
  sourceId: 'energrid-http-status', selector: '/api/v1/status', evidenceId: 'boot-2-sample-7',
  fields: [{ field: 'temperature', value: 22.5, observedAt: '2026-10-23T12:00:00.000Z', receivedAt: '2026-10-23T12:00:01.000Z' }],
};
const policies = { temperature: { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 } };

describe('GenericMeasurementHistoryWriter', () => {
  it('maps only approved numeric fields to stable scoped history samples', async () => {
    const ensureEnrollmentReference = jest.fn().mockResolvedValue(undefined);
    const appendIfDue = jest.fn().mockResolvedValue({ outcome: 'stored', reason: 'initial' });
    const writer = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, true, policies);
    await expect(writer.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'stored', reason: 'initial' },
    ]);
    expect(ensureEnrollmentReference).toHaveBeenCalledWith({
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device:stable',
    });
    expect(ensureEnrollmentReference.mock.invocationCallOrder[0])
      .toBeLessThan(appendIfDue.mock.invocationCallOrder[0]);
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

  it('skips writes when disabled and reports database errors without throwing', async () => {
    const ensureEnrollmentReference = jest.fn().mockResolvedValue(undefined);
    const appendIfDue = jest.fn().mockRejectedValue(new Error('db unavailable'));
    const disabled = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, false, policies);
    await expect(disabled.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'disabled' },
    ]);
    expect(appendIfDue).not.toHaveBeenCalled();
    expect(ensureEnrollmentReference).not.toHaveBeenCalled();

    const enabled = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, true, policies);
    await expect(enabled.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'failed' },
    ]);
  });

  it('reports missing metric policy without attempting a write', async () => {
    const ensureEnrollmentReference = jest.fn().mockResolvedValue(undefined);
    const appendIfDue = jest.fn();
    const writer = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, true, {});
    await expect(writer.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'policy_missing' },
    ]);
    expect(appendIfDue).not.toHaveBeenCalled();
  });

  it('reports a failed enrollment-reference sync and leaves the accepted sample available for retry', async () => {
    const ensureEnrollmentReference = jest.fn().mockRejectedValue(Object.assign(new Error('database unavailable'), { code: '08006' }));
    const appendIfDue = jest.fn();
    const writer = new GenericMeasurementHistoryWriter({ ensureEnrollmentReference, appendIfDue } as never, true, policies);
    await expect(writer.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'failed' },
    ]);
    expect(appendIfDue).not.toHaveBeenCalled();
  });
});
