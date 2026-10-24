import { telemetryConfig } from './telemetry.config';

describe('telemetryConfig measurement history', () => {
  it('provides generic temperature and humidity change and heartbeat defaults', () => {
    const config = telemetryConfig({});
    expect(config.historyEnabled).toBe(false);
    expect(config.historyPolicies).toMatchObject({
      temperature: { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 },
      humidity: { meaningfulChange: 2, maxHeartbeatMs: 900_000 },
    });
  });

  it('requires an explicit database target when history is enabled', () => {
    expect(() => telemetryConfig({ TELEMETRY_HISTORY_ENABLED: 'true' }))
      .toThrow('TELEMETRY_DATABASE_URL');
  });

  it('accepts bounded metric policy overrides and rejects invalid ones', () => {
    const config = telemetryConfig({
      TELEMETRY_HISTORY_POLICIES_JSON: JSON.stringify({ temperature: { meaningfulChange: 0.5, maxHeartbeatMs: 60_000 } }),
    });
    expect(config.historyPolicies.temperature).toEqual({ meaningfulChange: 0.5, maxHeartbeatMs: 60_000 });
    expect(() => telemetryConfig({
      TELEMETRY_HISTORY_POLICIES_JSON: JSON.stringify({ humidity: { meaningfulChange: -1, maxHeartbeatMs: 60_000 } }),
    })).toThrow('Invalid history policy');
    expect(() => telemetryConfig({
      TELEMETRY_HISTORY_POLICIES_JSON: JSON.stringify({ temperature: { meaningfulChange: 0, maxHeartbeatMs: 60_000 } }),
    })).toThrow('Invalid history policy');
  });
});
