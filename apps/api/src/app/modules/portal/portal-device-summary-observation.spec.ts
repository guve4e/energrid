import { projectDeviceSummaryObservation } from './portal-device-summary-observation';
import type { RegisteredDevice } from '../devices/device-registry.types';

describe('projectDeviceSummaryObservation', () => {
  const device = {
    id: 'device:home:esp8266:garage',
    state: { values: {}, observedAt: null, source: 'device-store', status: 'unknown' },
  } as RegisteredDevice;

  it('projects approved historical values and timestamp without claiming connectivity', () => {
    const projected = projectDeviceSummaryObservation(device, {
      deviceId: device.id,
      freshnessLimitSeconds: 60,
      fields: {
        temperature: {
          value: 18.4, sourceId: 'energrid-http-status', receivedAt: '2026-10-28T19:09:00.000Z',
          ageSeconds: 200_000, freshness: 'stale', authority: 'approved',
        },
        humidity: {
          value: 42.1, sourceId: 'energrid-http-status', receivedAt: '2026-10-28T19:09:00.000Z',
          ageSeconds: 200_000, freshness: 'stale', authority: 'approved',
        },
      },
    });

    expect(projected.state.values).toEqual({ temperature: 18.4, humidity: 42.1 });
    expect(projected.state.observedAt).toBe('2026-10-28T19:09:00.000Z');
    expect(projected.state.status).toBe('unknown');
  });

  it('ignores unapproved, future, empty, and cross-device observations', () => {
    const unapproved = projectDeviceSummaryObservation(device, {
      deviceId: device.id, freshnessLimitSeconds: 60,
      fields: { temperature: {
        value: 20, sourceId: 'unapproved', receivedAt: '2026-10-28T19:09:00.000Z',
        ageSeconds: 200_000, freshness: 'stale', authority: 'unapproved' as 'approved',
      } },
    });
    const future = projectDeviceSummaryObservation(device, {
      deviceId: device.id, freshnessLimitSeconds: 60,
      fields: { temperature: {
        value: 20, sourceId: 'approved', receivedAt: '2999-01-01T00:00:00.000Z',
        ageSeconds: null, freshness: 'invalid', authority: 'approved',
      } },
    });
    const otherDevice = projectDeviceSummaryObservation(device, {
      deviceId: 'device:other:esp8266:garage', freshnessLimitSeconds: 60,
      fields: { temperature: {
        value: 20, sourceId: 'approved', receivedAt: '2026-10-28T19:09:00.000Z',
        ageSeconds: 200_000, freshness: 'stale', authority: 'approved',
      } },
    });

    expect(unapproved).toBe(device);
    expect(future).toBe(device);
    expect(otherDevice).toBe(device);
  });
});
