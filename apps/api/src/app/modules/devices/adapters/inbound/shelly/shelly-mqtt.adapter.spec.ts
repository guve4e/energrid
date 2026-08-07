import { ShellyMqttAdapter } from './shelly-mqtt.adapter';
import { DeviceRegistryService } from '../../../device-registry.service';

describe('ShellyMqttAdapter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.PORTAL_SITE_NAME = 'Boyana Home';

    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify([
      {
        deviceId: 'kitchen.light.island.led',
        name: 'Kitchen island light',
        kind: 'physical',
        origin: 'shelly',
        protocol: 'mqtt',
        transport: 'mqtt',
        driver: 'shelly-rpc',
        physicalId: 'shellyplus2pm-78ee4ccf5cf0',
        channel: 0,
        location: 'kitchen',
        capabilities: ['switch'],
      },
    ]);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('normalizes Shelly NotifyStatus without requiring a specific topic root', () => {
    const registry = new DeviceRegistryService();
    const adapter = new ShellyMqttAdapter(registry);

    const result = adapter.handle({
      topic: 'custom/site/events/rpc',
      payloadText: JSON.stringify({
        src: 'shellyplus2pm-78ee4ccf5cf0',
        params: {
          ts: 1786012000,
          'switch:0': {
            id: 0,
            output: true,
            apower: 11.8,
            current: 0.05,
            voltage: 231.2,
          },
        },
      }),
      payload: {
        src: 'shellyplus2pm-78ee4ccf5cf0',
        params: {
          ts: 1786012000,
          'switch:0': {
            id: 0,
            output: true,
            apower: 11.8,
            current: 0.05,
            voltage: 231.2,
          },
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        reason: 'shelly telemetry',
        effects: [
          expect.objectContaining({
            kind: 'telemetry',
            payload: expect.objectContaining({
              deviceId: 'kitchen.light.island.led',
              origin: 'shelly-mqtt',
              status: 'online',
              values: {
                on: true,
                power: 11.8,
                current: 0.05,
                voltage: 231.2,
              },
            }),
          }),
        ],
      }),
    );
  });

  it('returns null when the physical channel is not approved', () => {
    const registry = new DeviceRegistryService();
    const adapter = new ShellyMqttAdapter(registry);

    const result = adapter.handle({
      topic: 'shelly/events/rpc',
      payloadText: '{}',
      payload: {
        src: 'shellyplus2pm-78ee4ccf5cf0',
        params: {
          'switch:1': {
            output: true,
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it('returns null for unrelated JSON messages', () => {
    const registry = new DeviceRegistryService();
    const adapter = new ShellyMqttAdapter(registry);

    expect(
      adapter.handle({
        topic: 'energrid/valentin/boyana-home/debug/manual',
        payloadText: '{"hello":"world"}',
        payload: {
          hello: 'world',
        },
      }),
    ).toBeNull();
  });
});
