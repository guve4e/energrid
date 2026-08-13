import { DeviceHealthService } from './device-health.service';
import type { DeviceMemory } from './device-observation.service';

describe('DeviceHealthService', () => {
  let service: DeviceHealthService;

  beforeEach(() => {
    service = new DeviceHealthService();
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

  it('returns unreachable when telemetry is old', () => {
    const result = service.evaluate(memory(600));

    expect(result.status).toBe('unreachable');
    expect(result.confidence).toBe(0.95);
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
