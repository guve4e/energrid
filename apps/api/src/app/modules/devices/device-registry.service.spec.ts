import { DeviceRegistryService } from './device-registry.service';

describe('DeviceRegistryService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES;
    delete process.env.HOME_KITCHEN_LIGHT_MQTT_TOPIC;
    delete process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC;
    delete process.env.HOME_DISCOVERED_DEVICES_JSON;
    delete process.env.HOME_APPROVED_DEVICES_JSON;
    delete process.env.HOME_DEVICE_REGISTRY_JSON;
    delete process.env.DEVICE_REGISTRY_JSON;
    delete process.env.PORTAL_TENANT_ID;
    delete process.env.PORTAL_SITE_ID;
    delete process.env.PORTAL_SITE_NAME;
    delete process.env.HOME_GATEWAY_ID;
    delete process.env.PORTAL_KITCHEN_TEMP_C;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns a device-first snapshot with logical and physical devices', () => {
    process.env.PORTAL_KITCHEN_TEMP_C = '23.6';
    process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES =
      'kitchen.light.wall.led:shellyplus1-cc7b5c0ea5f8:0,kitchen.light.island.led:shellyplus1-78ee4ccf5cf0:0,kitchen.light.cans:shellyplus1-78ee4ccf4268:0';

    const snapshot = new DeviceRegistryService().getSnapshot();
    const group = snapshot.devices.find(
      (device) => device.id === 'kitchen_light',
    );
    const temperature = snapshot.devices.find(
      (device) => device.id === 'kitchen_temperature',
    );

    expect(group).toEqual(
      expect.objectContaining({
        displayName: 'Kitchen lights',
        kind: 'logical',
        memberDeviceIds: [
          'kitchen.light.wall.led',
          'kitchen.light.island.led',
          'kitchen.light.cans',
        ],
      }),
    );
    expect(group?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'mqtt',
        driver: 'shelly-rpc',
        configured: true,
      }),
    );
    expect(temperature?.state.values.temperature).toBe(23.6);
    expect(snapshot.summary).toEqual({
      total: 5,
      approved: 5,
      discovered: 0,
      controllable: 4,
      sensors: 1,
      systems: 5,
      learningEnabled: 5,
    });
    expect(snapshot.systems.map((system) => system.id)).toEqual(
      expect.arrayContaining([
        'floor_heating',
        'fan_coils',
        'refrigerator_inventory',
        'forecast_optimizer',
      ]),
    );
  });

  it('falls back to simulated devices while hardware adapters are not configured', () => {
    const snapshot = new DeviceRegistryService().getSnapshot();
    const group = snapshot.devices.find(
      (device) => device.id === 'kitchen_light',
    );

    expect(group?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'simulated',
        configured: false,
      }),
    );
    expect(snapshot.summary.total).toBe(2);
    expect(snapshot.summary.systems).toBe(5);
  });

  it('keeps discovered devices out of approved control until onboarding', () => {
    process.env.HOME_DISCOVERED_DEVICES_JSON = JSON.stringify([
      {
        id: 'shellyplus1-new',
        displayName: 'Shelly Plus 1',
        suggestedRoom: 'Kitchen',
        suggestedName: 'Kitchen cabinet light',
        protocol: 'mqtt',
        driver: 'shelly-rpc',
        target: 'shellyplus1-new',
        capabilities: ['light'],
        confidence: 0.84,
        reason: 'Shelly device announced on the local MQTT network.',
      },
    ]);

    const service = new DeviceRegistryService();
    const snapshot = service.getSnapshot();
    const discovered = snapshot.devices.find(
      (device) => device.id === 'shellyplus1-new',
    );

    expect(discovered).toEqual(
      expect.objectContaining({
        trustStatus: 'discovered',
        adapter: expect.objectContaining({
          protocol: 'mqtt',
          configured: false,
        }),
        discovery: expect.objectContaining({
          suggestedRoom: 'Kitchen',
          confidence: 0.84,
        }),
      }),
    );
    expect(service.getAvailableDeviceIds()).not.toContain('shellyplus1-new');
    expect(snapshot.summary.discovered).toBe(1);
  });

  it('imports approved site devices from the legacy Shelly registry shape', () => {
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'kitchen.light.wall.led',
          origin: 'shelly',
          physicalId: 'shellyplus1-cc7b5c0ea5f8',
          channel: 0,
          groups: ['kitchen.lights'],
          aliases: ['kitchen wall', 'лампа на стената в кухнята'],
        },
        {
          deviceId: 'kitchen.light.island.led',
          origin: 'shelly',
          physicalId: 'shellyplus1-78ee4ccf5cf0',
          channel: 0,
          groups: ['kitchen.lights'],
          aliases: ['kitchen island', 'лампи на острова'],
        },
        {
          deviceId: 'bath.light.led',
          origin: 'shelly',
          physicalId: 'shellyplus1-8813bfcdc8bc',
          channel: 0,
          groups: ['bath.lights'],
          aliases: ['bathroom lights', 'лампи в банята'],
        },
        {
          deviceId: 'mainline',
          name: 'mainline',
          type: 'power-sensor',
          origin: 'shelly',
          physicalId: 'shellyproem50-main',
          location: 'PANEL',
          values: { power: 376.2, current: 1.824 },
        },
        {
          deviceId: 'water-pump',
          name: 'Water pump',
          type: 'power-sensor',
          origin: 'shelly',
          physicalId: 'shellyproem50-main',
          hardwareId: 'shellyproem50-main',
          channel: 1,
          channelName: 'water-pump',
          component: 'em:1',
          location: 'shed',
          capabilities: ['power', 'pump'],
          values: { power: 55.9, current: 0.395 },
        },
      ],
    });

    const service = new DeviceRegistryService();
    const snapshot = service.getSnapshot();
    const bathLight = snapshot.devices.find(
      (device) => device.id === 'bath.light.led',
    );
    const bathGroup = snapshot.devices.find(
      (device) => device.id === 'bath_light',
    );
    const kitchenGroup = snapshot.devices.find(
      (device) => device.id === 'kitchen_light',
    );
    const mainline = snapshot.devices.find(
      (device) => device.id === 'mainline',
    );
    const waterPump = snapshot.devices.find(
      (device) => device.id === 'water-pump',
    );

    expect(bathLight).toEqual(
      expect.objectContaining({
        zoneName: 'Bathroom',
        adapter: expect.objectContaining({
          protocol: 'mqtt',
          driver: 'shelly-rpc',
          target: 'shellyplus1-8813bfcdc8bc',
        }),
      }),
    );
    expect(
      bathLight?.capabilities.map((capability) => capability.kind),
    ).toContain('switch');
    expect(bathGroup).toEqual(
      expect.objectContaining({
        kind: 'logical',
        zoneName: 'Bathroom',
        memberDeviceIds: ['bath.light.led'],
        adapter: expect.objectContaining({
          driver: 'shelly-rpc-group',
          configured: true,
        }),
      }),
    );
    expect(kitchenGroup).toEqual(
      expect.objectContaining({
        kind: 'logical',
        memberDeviceIds: ['kitchen.light.wall.led', 'kitchen.light.island.led'],
        adapter: expect.objectContaining({
          driver: 'shelly-rpc-group',
          configured: true,
        }),
      }),
    );
    expect(mainline).toEqual(
      expect.objectContaining({
        zoneName: 'PANEL',
        state: expect.objectContaining({
          values: { power: 376.2, current: 1.824 },
        }),
      }),
    );
    expect(
      mainline?.capabilities.map((capability) => capability.kind),
    ).toContain('power');
    expect(waterPump).toEqual(
      expect.objectContaining({
        zoneName: 'shed',
        metadata: expect.objectContaining({
          hardwareId: 'shellyproem50-main',
          physicalId: 'shellyproem50-main',
          channel: 1,
          channelName: 'water-pump',
          component: 'em:1',
        }),
        state: expect.objectContaining({
          values: { power: 55.9, current: 0.395 },
        }),
      }),
    );
    expect(
      waterPump?.capabilities.map((capability) => capability.kind),
    ).toEqual(expect.arrayContaining(['power', 'pump']));
    expect(service.getAvailableDeviceIds()).toEqual(
      expect.arrayContaining([
        'bath_light',
        'bath.light.led',
        'mainline',
        'water-pump',
      ]),
    );
  });

  it('scopes the active snapshot to the current tenant site while keeping site summaries', () => {
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.PORTAL_SITE_NAME = 'Boyana Home';
    process.env.HOME_GATEWAY_ID = 'boyana-gateway';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'kitchen.light.wall',
          tenantId: 'valentin',
          siteId: 'boyana-home',
          siteName: 'Boyana Home',
          gatewayId: 'boyana-gateway',
          origin: 'shelly',
          physicalId: 'shelly-boyana',
          groups: ['kitchen.lights'],
        },
        {
          deviceId: 'garage.temp',
          tenantId: 'valentin',
          siteId: 'village-house',
          siteName: 'Village House',
          gatewayId: 'village-gateway',
          type: 'sensor',
          origin: 'native',
          location: 'garage',
          values: { temperature: 8.5 },
        },
      ],
    });

    const snapshot = new DeviceRegistryService().getSnapshot();

    expect(snapshot.tenant.id).toBe('valentin');
    expect(snapshot.site).toEqual({ id: 'boyana-home', name: 'Boyana Home' });
    expect(snapshot.devices.map((device) => device.id)).toContain(
      'kitchen.light.wall',
    );
    expect(snapshot.devices.map((device) => device.id)).not.toContain(
      'garage.temp',
    );
    expect(snapshot.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'boyana-home',
          gatewayIds: ['boyana-gateway'],
        }),
        expect.objectContaining({
          id: 'village-house',
          gatewayIds: ['village-gateway'],
        }),
      ]),
    );
    const kitchenDevice = snapshot.devices.find(
      (device) => device.id === 'kitchen.light.wall',
    );
    expect(kitchenDevice?.adapter.commandTopic).toContain(
      'energrid/valentin/boyana-home/devices/',
    );
  });

  it('keeps native protocol separate from the gateway transport', () => {
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.HOME_GATEWAY_ID = 'boyana-gateway';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'kitchen.temperature.http',
          protocol: 'http',
          transport: 'http',
          driver: 'http-json-sensor',
          target: 'http://192.168.1.88/status',
          location: 'Kitchen',
          capabilities: ['temperature', 'humidity'],
          values: { temperature: 22.4, humidity: 48 },
        },
        {
          deviceId: 'hall.motion.zigbee',
          protocol: 'zigbee',
          transport: 'mqtt',
          driver: 'zigbee2mqtt',
          bridge: 'zigbee2mqtt-hall',
          target: 'zigbee2mqtt/hall_motion',
          location: 'Hall',
          capabilities: ['motion'],
          values: { motion: false },
        },
        {
          deviceId: 'utility.heatpump.modbus',
          protocol: 'modbus',
          transport: 'mqtt',
          driver: 'modbus-gateway',
          bridge: 'rs485-site-gateway',
          target: 'modbus/heatpump',
          location: 'Utility',
          capabilities: ['heat_source', 'temperature'],
          values: { flowTemperature: 31.5, mode: 'heat' },
        },
      ],
    });

    const snapshot = new DeviceRegistryService().getSnapshot();
    const httpSensor = snapshot.devices.find(
      (device) => device.id === 'kitchen.temperature.http',
    );
    const zigbeeSensor = snapshot.devices.find(
      (device) => device.id === 'hall.motion.zigbee',
    );
    const modbusHeatPump = snapshot.devices.find(
      (device) => device.id === 'utility.heatpump.modbus',
    );

    expect(httpSensor?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'http',
        transport: 'http',
        driver: 'http-json-sensor',
      }),
    );
    expect(zigbeeSensor?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'zigbee',
        transport: 'mqtt',
        driver: 'zigbee2mqtt',
        bridge: 'zigbee2mqtt-hall',
      }),
    );
    expect(zigbeeSensor?.capabilities).toEqual([
      expect.objectContaining({ kind: 'motion', actions: ['read'] }),
    ]);
    expect(modbusHeatPump?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'modbus',
        transport: 'mqtt',
        driver: 'modbus-gateway',
        bridge: 'rs485-site-gateway',
      }),
    );
    expect(modbusHeatPump?.adapter.commandTopic).toContain(
      'energrid/valentin/boyana-home/devices/utility_heatpump_modbus/command',
    );
  });

  it('discovers zigbee devices without approving them for control', () => {
    process.env.HOME_DISCOVERED_DEVICES_JSON = JSON.stringify([
      {
        id: 'hall.motion.zigbee',
        suggestedName: 'Hall motion sensor',
        suggestedRoom: 'Hall',
        protocol: 'zigbee',
        transport: 'mqtt',
        driver: 'zigbee2mqtt',
        target: 'zigbee2mqtt/hall_motion',
        capabilities: ['motion'],
        confidence: 0.76,
      },
    ]);

    const service = new DeviceRegistryService();
    const snapshot = service.getSnapshot();
    const discovered = snapshot.devices.find(
      (device) => device.id === 'hall.motion.zigbee',
    );

    expect(discovered).toEqual(
      expect.objectContaining({
        trustStatus: 'discovered',
        adapter: expect.objectContaining({
          protocol: 'zigbee',
          transport: 'mqtt',
          configured: false,
        }),
        discovery: expect.objectContaining({
          source: 'zigbee',
          confidence: 0.76,
        }),
      }),
    );
    expect(service.getAvailableDeviceIds()).not.toContain('hall.motion.zigbee');
  });

  it('ingests live MQTT registry and telemetry into the portal snapshot', () => {
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.PORTAL_SITE_NAME = 'Boyana Home';
    process.env.HOME_GATEWAY_ID = 'boyana-gateway';

    const service = new DeviceRegistryService();

    service.ingestRegistryPayload({
      tenantId: 'valentin',
      siteId: 'boyana-home',
      siteName: 'Boyana Home',
      gatewayId: 'boyana-gateway',
      observedAt: '2026-08-02T08:00:00.000Z',
      devices: [
        {
          deviceId: 'kitchen.temperature.http',
          name: 'Kitchen temperature HTTP sensor',
          protocol: 'http',
          transport: 'http',
          driver: 'http-json-sensor',
          target: 'http://192.168.1.88/status',
          location: 'Kitchen',
          capabilities: ['temperature'],
          values: { temperature: 22.4 },
        },
      ],
    });
    service.ingestDeviceTelemetry({
      deviceId: 'kitchen.temperature.http',
      values: { temperature: 23.1 },
      observedAt: '2026-08-02T08:01:00.000Z',
      protocol: 'http',
      transport: 'http',
    });

    const snapshot = service.getSnapshot();
    const device = snapshot.devices.find(
      (item) => item.id === 'kitchen.temperature.http',
    );

    expect(device).toEqual(
      expect.objectContaining({
        trustStatus: 'approved',
        adapter: expect.objectContaining({
          protocol: 'http',
          transport: 'http',
        }),
        state: expect.objectContaining({
          values: { temperature: 23.1 },
          observedAt: '2026-08-02T08:01:00.000Z',
          status: 'online',
        }),
      }),
    );
  });

  it('shows the current site inventory with two temp sensors and all Shelly devices', () => {
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.PORTAL_SITE_NAME = 'Boyana Home';
    process.env.HOME_GATEWAY_ID = 'boyana-gateway';

    const service = new DeviceRegistryService();
    service.ingestRegistryPayload({
      tenantId: 'valentin',
      siteId: 'boyana-home',
      siteName: 'Boyana Home',
      gatewayId: 'boyana-gateway',
      devices: [
        {
          deviceId: 'kitchen.light.wall.led',
          name: 'Kitchen wall lights',
          origin: 'shelly',
          physicalId: 'shellyplus1-cc7b5c0ea5f8',
          channel: 0,
          groups: ['kitchen.lights'],
          values: { on: false },
        },
        {
          deviceId: 'kitchen.light.island.led',
          name: 'Kitchen island lights',
          origin: 'shelly',
          physicalId: 'shellyplus1-78ee4ccf4b54',
          channel: 0,
          groups: ['kitchen.lights'],
          values: { on: false },
        },
        {
          deviceId: 'kitchen.light.cans',
          name: 'Kitchen ceiling cans',
          origin: 'shelly',
          physicalId: 'shellyplus1-78ee4ccf4268',
          channel: 0,
          groups: ['kitchen.lights'],
          values: { on: false },
        },
        {
          deviceId: 'temp-kitchen',
          name: 'Kitchen temperature',
          origin: 'native',
          location: 'kitchen',
          values: { temperature: 22.4, humidity: 48.0 },
        },
        {
          deviceId: 'temp-garage',
          name: 'Garage temperature',
          origin: 'native',
          location: 'garage',
          values: { temperature: 18.7, humidity: 56.1 },
        },
        {
          deviceId: 'panel.mainline.energy',
          name: 'Whole house mainline',
          origin: 'shelly',
          driver: 'shelly-pro-em',
          physicalId: 'shellyproem50-8c4f00dbd258',
          hardwareId: 'shellyproem50-8c4f00dbd258',
          channel: 0,
          channelName: 'mainline',
          component: 'em:0',
          location: 'panel',
          capabilities: ['power'],
          values: { power: 420.0, current: 1.9, energy: 108.2 },
        },
        {
          deviceId: 'shed.water_pump.energy',
          name: 'Water pump energy',
          origin: 'shelly',
          driver: 'shelly-pro-em',
          physicalId: 'shellyproem50-8c4f00dbd258',
          hardwareId: 'shellyproem50-8c4f00dbd258',
          channel: 1,
          channelName: 'water-pump',
          component: 'em:1',
          location: 'shed',
          capabilities: ['power', 'pump'],
          values: { power: 0, current: 0.02, energy: 7.9 },
        },
      ],
    });

    const snapshot = service.getSnapshot();
    const ids = snapshot.devices.map((device) => device.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        'kitchen_light',
        'kitchen.light.wall.led',
        'kitchen.light.island.led',
        'kitchen.light.cans',
        'temp-kitchen',
        'temp-garage',
        'panel.mainline.energy',
        'shed.water_pump.energy',
      ]),
    );
    expect(
      snapshot.devices.filter((device) =>
        device.capabilities.some(
          (capability) => capability.kind === 'temperature',
        ),
      ),
    ).toHaveLength(2);
    expect(
      snapshot.devices.filter((device) => device.metadata?.origin === 'shelly'),
    ).toHaveLength(5);
    expect(
      snapshot.devices.find((device) => device.id === 'kitchen_light'),
    ).toEqual(
      expect.objectContaining({
        kind: 'logical',
        memberDeviceIds: [
          'kitchen.light.wall.led',
          'kitchen.light.island.led',
          'kitchen.light.cans',
        ],
      }),
    );
  });

  it('treats telemetry without a registry entry as discovered only', () => {
    const service = new DeviceRegistryService();

    service.ingestDeviceTelemetry({
      deviceId: 'garage.motion.zigbee',
      name: 'Garage motion',
      protocol: 'zigbee',
      transport: 'mqtt',
      driver: 'zigbee2mqtt',
      location: 'Garage',
      capabilities: ['motion'],
      values: { motion: true },
    });

    const snapshot = service.getSnapshot();
    const device = snapshot.devices.find(
      (item) => item.id === 'garage.motion.zigbee',
    );

    expect(device).toEqual(
      expect.objectContaining({
        trustStatus: 'discovered',
        adapter: expect.objectContaining({
          protocol: 'zigbee',
          transport: 'mqtt',
          configured: false,
        }),
        state: expect.objectContaining({
          values: { motion: true },
          status: 'online',
        }),
      }),
    );
    expect(service.getAvailableDeviceIds()).not.toContain(
      'garage.motion.zigbee',
    );
  });
});
