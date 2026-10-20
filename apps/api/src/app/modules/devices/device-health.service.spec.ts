import { DeviceHealthService } from './device-health.service';
import type { DeviceMemory } from './device-observation.service';

describe('DeviceHealthService', () => {
  let service: DeviceHealthService;

  beforeEach(() => {
    service = new DeviceHealthService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function memory(secondsAgo: number): DeviceMemory {
    return {
      deviceId: 'test.device',
      firstSeen: new Date().toISOString(),
      lastSeen: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      observations: 10,
      lastValues: {},
      source: 'test',
    };
  }

  it('returns healthy for recent telemetry', () => {
    const result = service.evaluate(memory(5));

    expect(result.status).toBe('healthy');
    expect(result.confidence).toBe(0.99);
    expect(result.ageSeconds).toBeLessThanOrEqual(5);
  });

  it('returns degraded when telemetry is delayed', () => {
    const result = service.evaluate(memory(120));

    expect(result.status).toBe('degraded');
    expect(result.confidence).toBe(0.7);
  });

  it('reports stale telemetry without claiming the device is unreachable', () => {
    const result = service.evaluate(memory(600));

    expect(result.status).toBe('stale');
    expect(result.confidence).toBe(0.95);
    expect(result.reason).toContain('reachability has not been checked');
  });

  it('does not treat a future-dated observation as fresh', () => {
    const now = Date.parse('2026-10-20T10:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const future = {
      ...memory(0),
      lastSeen: new Date(now + 60_000).toISOString(),
    };

    const result = service.evaluate(future);

    expect(result.status).toBe('stale');
    expect(result.ageSeconds).toBeNull();
    expect(result.reason).toContain('future');
  });

  it('does not establish health from an invalid observation timestamp', () => {
    const now = Date.parse('2026-10-20T10:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const result = service.evaluate({ ...memory(0), lastSeen: 'not-a-timestamp' });

    expect(result.status).toBe('stale');
    expect(result.ageSeconds).toBeNull();
    expect(result.reason.toLowerCase()).toContain('invalid');
  });

  it('never returns invalid confidence values', () => {
    const results = [
      service.evaluate(memory(1)),
      service.evaluate(memory(120)),
      service.evaluate(memory(600)),
    ];

    for (const result of results) {
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});
