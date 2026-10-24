import type { GenericMeasurement } from '@energrid/domain-telemetry';
import { decideMeasurementHistoryWrite } from './measurement-history-policy';

const current: GenericMeasurement = {
  schemaVersion: 1, tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device-a',
  physicalDeviceId: null, componentId: 'device', channel: 'temperature',
  metric: 'temperature', unit: 'Cel', value: 21, quality: 'measured',
  source: 'approved-http', provenance: 'approved:approved-http', sampleId: 'sample-2',
  observedAt: '2026-01-01T00:00:02.000Z', receivedAt: '2026-01-01T00:00:02.000Z',
};
const previous: GenericMeasurement = { ...current, value: 20, sampleId: 'sample-1',
  observedAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:00.000Z' };
const policy = { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 };

describe('measurement history write policy', () => {
  it('stores the initial accepted measurement', () => {
    expect(decideMeasurementHistoryWrite(current, null, policy)).toEqual({ persist: true, reason: 'initial' });
  });

  it('stores meaningful changes and skips unchanged or sub-threshold samples', () => {
    expect(decideMeasurementHistoryWrite({ ...current, value: 20.3 }, previous, policy))
      .toEqual({ persist: true, reason: 'meaningful_change' });
    expect(decideMeasurementHistoryWrite({ ...current, value: 20.29 }, previous, policy))
      .toEqual({ persist: false, reason: 'below_threshold' });
    expect(decideMeasurementHistoryWrite({ ...current, value: 20 }, previous, policy))
      .toEqual({ persist: false, reason: 'below_threshold' });
  });

  it('persists on heartbeat and fails closed on a backwards receive clock', () => {
    expect(decideMeasurementHistoryWrite({ ...current, value: 20, receivedAt: '2026-01-01T00:15:00.000Z' }, previous, policy))
      .toEqual({ persist: true, reason: 'heartbeat' });
    expect(decideMeasurementHistoryWrite({ ...current, value: 20, receivedAt: '2025-12-31T23:59:59.000Z' }, previous, policy))
      .toEqual({ persist: false, reason: 'clock_not_advanced' });
  });
});
