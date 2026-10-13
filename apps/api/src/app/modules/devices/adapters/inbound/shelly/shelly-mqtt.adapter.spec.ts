import { ShellyMqttAdapter } from './shelly-mqtt.adapter';
import { DeviceRegistryService } from '../../../device-registry.service';

describe('Shelly electrical reading normalization', () => {
  const registry = () => ({
    findApprovedDeviceIdByPhysicalChannel: jest.fn().mockReturnValue('meter'),
    registerDiscoveredShellyDevice: jest.fn(),
  });
  const parse = (
    component: Record<string, unknown>,
    name = 'switch:0',
    ts: number | null = 1791676800,
  ) => {
    const adapter = new ShellyMqttAdapter(
      registry() as unknown as DeviceRegistryService,
    );
    return adapter.handle({
      topic: 'shelly/meter/events/rpc',
      payloadText: '{}',
      payload: { src: 'shelly-meter', params: { ts, [name]: component } },
    })!;
  };
  const readings = (result: ReturnType<typeof parse>) =>
    (
      result.effects[0] as {
        payload: { readings: Array<Record<string, unknown>> };
      }
    ).payload.readings;
  it('normalizes watts and switch energy counters from Wh to kWh', () => {
    expect(
      readings(
        parse({
          apower: 3000,
          aenergy: { total: 12500 },
          ret_aenergy: { total: 500 },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        metric: 'power',
        value: 3000,
        unit: 'W',
        channel: 'switch:0',
      }),
      expect.objectContaining({
        metric: 'energy_import_total',
        value: 12.5,
        unit: 'kWh',
      }),
      expect.objectContaining({
        metric: 'energy_export_total',
        value: 0.5,
        unit: 'kWh',
      }),
    ]);
  });
  it('normalizes EM1Data to the same measurement channel as EM1', () => {
    expect(
      readings(
        parse(
          { total_act_energy: 5000, total_act_ret_energy: 1000 },
          'em1data:0',
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        metric: 'energy_import_total',
        value: 5,
        channel: 'em1:0',
      }),
      expect.objectContaining({
        metric: 'energy_export_total',
        value: 1,
        channel: 'em1:0',
      }),
    ]);
  });
  it('preserves signed power and distinguishes device time from collector time', () => {
    expect(readings(parse({ act_power: -100 }, 'em1:0'))[0]).toEqual(
      expect.objectContaining({
        value: -100,
        timestampBasis: 'device-observed',
      }),
    );
    expect(
      readings(parse({ apower: 100 }, 'switch:0', null))[0].timestampBasis,
    ).toBe('collector-received');
  });
  it('keeps explicitly broken samples as invalid continuity breaks, not zero', () => {
    expect(readings(parse({ apower: null }))[0]).toEqual(
      expect.objectContaining({ value: null, quality: 'invalid' }),
    );
    expect(
      readings(parse({ total_act_energy: -1 }, 'em1data:0'))[0].value,
    ).toBeNull();
  });
  it('does not label fallback collector time as device time when a timestamp is malformed', () => {
    const adapter = new ShellyMqttAdapter(
      registry() as unknown as DeviceRegistryService,
    );
    const result = adapter.handle({
      topic: 'shelly/meter/events/rpc',
      payloadText: '{}',
      payload: {
        src: 'shelly-meter',
        params: { ts: 'broken', 'em1:0': { act_power: 100 } },
      },
    })!;
    expect(readings(result)[0].timestampBasis).toBe('collector-received');
  });
  it('handles all supported channels in one notification', () => {
    const adapter = new ShellyMqttAdapter(
      registry() as unknown as DeviceRegistryService,
    );
    const result = adapter.handle({
      topic: 'shelly/meter/events/rpc',
      payloadText: '{}',
      payload: {
        src: 'shelly-meter',
        params: {
          ts: 1791676800,
          'switch:0': { apower: 100 },
          'switch:1': { apower: 200 },
        },
      },
    })!;
    expect(result.effects).toHaveLength(2);
    expect(
      result.effects.map(
        (e) =>
          (e as { payload: { readings: Array<{ channel: string }> } }).payload
            .readings[0].channel,
      ),
    ).toEqual(['switch:0', 'switch:1']);
  });
  it('resolves EM1Data against an approved EM1 component assignment', () => {
    const r = registry();
    r.findApprovedDeviceIdByPhysicalChannel.mockReturnValueOnce(null);
    const adapter = new ShellyMqttAdapter(
      r as unknown as DeviceRegistryService,
    );
    expect(
      adapter.handle({
        topic: 'shelly/meter/status/em1data:0',
        payloadText: '{}',
        payload: { total_act_energy: 100 },
      })?.effects,
    ).toHaveLength(1);
    expect(r.findApprovedDeviceIdByPhysicalChannel).toHaveBeenLastCalledWith(
      'meter',
      'em1:0',
      0,
    );
  });
});

describe('ShellyMqttAdapter', () => {
  it('subscribes to standard device-root notifications/status as well as the existing shared prefix', () => {
    const adapter = new ShellyMqttAdapter(new DeviceRegistryService());
    expect(adapter.subscriptions()).toEqual([
      'shelly/#',
      '+/events/rpc',
      '+/status/+',
    ]);
    expect(adapter.subscriptions()).not.toContain('#');
  });

  it.each([
    [
      'shellyplus2pm-001122334455/events/rpc',
      {
        src: 'shellyplus2pm-001122334455',
        method: 'NotifyStatus',
        params: { 'switch:0': { output: true, apower: 100 } },
      },
    ],
    [
      'shellyplus2pm-001122334455/status/switch:0',
      { id: 0, output: true, apower: 100 },
    ],
  ])(
    'discovers an unknown standard-topic device without approving or controlling it: %s',
    (topic, payload) => {
      const registry = new DeviceRegistryService();
      const adapter = new ShellyMqttAdapter(registry);
      const result = adapter.handle({
        topic,
        payload,
        payloadText: JSON.stringify(payload),
      });
      expect(result).toEqual({
        reason: 'shelly device discovered',
        effects: [],
      });
      const device = registry
        .getDevices()
        .find(
          (device) =>
            device.discovery &&
            device.adapter.target?.includes('shellyplus2pm-001122334455'),
        );
      expect(device).toEqual(
        expect.objectContaining({ trustStatus: 'discovered' }),
      );
    },
  );
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.PORTAL_SITE_NAME = 'Boyana Home';
    delete process.env.HOME_DISCOVERED_DEVICES_JSON;
    delete process.env.HOME_DEVICE_REGISTRY_JSON;
    delete process.env.DEVICE_REGISTRY_JSON;

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

  it('discovers channels from the existing full-status publisher without approval or control', () => {
    const registry = new DeviceRegistryService();
    const adapter = new ShellyMqttAdapter(registry);
    const physicalId = 'shellyplus2pm-001122334455';
    expect(
      adapter.handle({
        topic: `shelly/status/${physicalId}`,
        payloadText: '{}',
        payload: {
          id: physicalId,
          'switch:0': { output: false, apower: 0 },
          'switch:1': { output: true, apower: 100 },
          'input:0': { state: false },
        },
      })?.effects,
    ).toEqual([]);
    expect(
      registry.getDevices().filter((d) => d.adapter.target === physicalId),
    ).toEqual([
      expect.objectContaining({
        id: `${physicalId}:switch:0`,
        trustStatus: 'discovered',
      }),
      expect.objectContaining({
        id: `${physicalId}:switch:1`,
        trustStatus: 'discovered',
      }),
    ]);
  });

  it('normalizes full-status readings only for an already approved channel', () => {
    const adapter = new ShellyMqttAdapter(new DeviceRegistryService());
    const physicalId = 'shellyplus2pm-78ee4ccf5cf0';
    expect(
      adapter.handle({
        topic: `shelly/status/${physicalId}`,
        payloadText: '{}',
        payload: {
          id: physicalId,
          'switch:0': { output: true, apower: 100 },
        },
      })?.effects,
    ).toEqual([
      expect.objectContaining({
        kind: 'telemetry',
        payload: expect.objectContaining({
          deviceId: 'kitchen.light.island.led',
          readings: [
            expect.objectContaining({
              channel: 'switch:0',
              metric: 'power',
              value: 100,
              timestampBasis: 'collector-received',
            }),
          ],
        }),
      }),
    ]);
  });

  it.each([{ id: 'different-device' }, { src: 'different-device' }])(
    'rejects a full-status snapshot with conflicting identity: %j',
    (identity) => {
      const registry = new DeviceRegistryService();
      const adapter = new ShellyMqttAdapter(registry);
      expect(
        adapter.handle({
          topic: 'shelly/status/shellyplus2pm-001122334455',
          payloadText: '{}',
          payload: { ...identity, 'switch:0': { output: true } },
        }),
      ).toBeNull();
      expect(registry.getDevices().filter((d) => d.discovery)).toEqual([]);
    },
  );

  it('does not interpret arbitrary top-level component objects as Shelly snapshots', () => {
    const adapter = new ShellyMqttAdapter(new DeviceRegistryService());
    expect(
      adapter.handle({
        topic: 'unrelated/status/device',
        payloadText: '{}',
        payload: { id: 'device', 'switch:0': { output: true } },
      }),
    ).toBeNull();
  });

  it.each([false, true])(
    'discovers one meter channel for EM1 and its energy counters, counters first: %s',
    (countersFirst) => {
      const registry = new DeviceRegistryService();
      const adapter = new ShellyMqttAdapter(registry);
      const physicalId = 'shellyproem50-001122334455';
      const components = [
        ['em1:0', { act_power: 100 }],
        ['em1data:0', { total_act_energy: 200 }],
      ] as const;
      for (const [name, component] of countersFirst
        ? [...components].reverse()
        : components) {
        expect(
          adapter.handle({
            topic: `${physicalId}/status/${name}`,
            payloadText: '{}',
            payload: component,
          })?.effects,
        ).toEqual([]);
      }
      expect(
        registry.getDevices().filter((d) => d.adapter.target === physicalId),
      ).toEqual([
        expect.objectContaining({
          id: `${physicalId}:em1:0`,
          trustStatus: 'discovered',
        }),
      ]);
    },
  );

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
        src: 'shellyplus2pm-UNAPPROVED',
        params: {
          'switch:1': {
            id: 1,
            output: true,
          },
        },
      },
    });

    expect(result).toEqual({ reason: 'shelly device discovered', effects: [] });
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
