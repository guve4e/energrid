import { GenericMeasurementHistoryWriter } from './generic-measurement-history-writer';

const observation = {
  tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device:stable',
  sourceId: 'energrid-http-status', selector: '/api/v1/status', evidenceId: 'boot-2-sample-7',
  fields: [{ field: 'temperature', value: 22.5, observedAt: '2026-10-23T12:00:00.000Z', receivedAt: '2026-10-23T12:00:01.000Z' }],
};
const policies = { temperature: { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 } };

describe('GenericMeasurementHistoryWriter', () => {
  it('maps only approved numeric fields to stable scoped history samples', async () => {
    const appendIfDue = jest.fn().mockResolvedValue({ outcome: 'stored', reason: 'initial' });
    const writer = new GenericMeasurementHistoryWriter({ appendIfDue } as never, true, policies);
    await expect(writer.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'stored', reason: 'initial' },
    ]);
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
    const appendIfDue = jest.fn().mockRejectedValue(new Error('db unavailable'));
    const disabled = new GenericMeasurementHistoryWriter({ appendIfDue } as never, false, policies);
    await expect(disabled.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'disabled' },
    ]);
    expect(appendIfDue).not.toHaveBeenCalled();

    const enabled = new GenericMeasurementHistoryWriter({ appendIfDue } as never, true, policies);
    await expect(enabled.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'failed' },
    ]);
  });

  it('reports missing metric policy without attempting a write', async () => {
    const appendIfDue = jest.fn();
    const writer = new GenericMeasurementHistoryWriter({ appendIfDue } as never, true, {});
    await expect(writer.persistAccepted(observation)).resolves.toEqual([
      { field: 'temperature', outcome: 'policy_missing' },
    ]);
    expect(appendIfDue).not.toHaveBeenCalled();
  });
});
