import { projectAuthorizedObservations } from './device-intelligence-observation';

describe('Intelligence observation projection', () => {
  const now = Date.parse('2026-10-22T16:00:00Z');

  it('preserves individual field provenance and freshness', () => {
    const result = projectAuthorizedObservations({
      deviceId: 'device-1',
      fields: {
        on: {
          value: true,
          sourceId: 'shelly-http',
          evidenceId: 'rpc-readback-1',
          receivedAt: '2026-10-22T15:59:50Z',
          orderAt: '2026-10-22T15:59:50Z',
        },
        temperature: {
          value: 23.5,
          sourceId: 'mqtt-sensor',
          receivedAt: '2026-10-22T15:50:00Z',
          orderAt: '2026-10-22T15:50:00Z',
        },
      },
    }, 60, now);

    expect(result.fields.on.freshness).toBe('fresh');
    expect(result.fields.on.sourceId).toBe('shelly-http');
    expect(result.fields.on.evidenceId).toBe('rpc-readback-1');

    expect(result.fields.temperature.freshness).toBe('stale');
    expect(result.fields.temperature.sourceId).toBe('mqtt-sensor');
  });

  it('never labels a future timestamp as fresh', () => {
    const result = projectAuthorizedObservations({
      deviceId: 'device-1',
      fields: {
        on: {
          value: true,
          sourceId: 'test',
          receivedAt: '2026-10-23T16:00:00Z',
          orderAt: '2026-10-23T16:00:00Z',
        },
      },
    }, 60, now);

    expect(result.fields.on.freshness).toBe('invalid');
    expect(result.fields.on.ageSeconds).toBeNull();
  });
});
