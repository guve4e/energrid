import { DeviceMqttMessageRouter } from './device-mqtt-message-router';
import { DeviceRegistryService } from '../device-registry.service';
import { DeviceObservationService } from '../device-observation.service';
import { DeviceHealthService } from '../device-health.service';
import { TelemetryIngestService } from '../../telemetry/telemetry-ingest.service';

const enrolled = { find: async () => ({ status: 'enrolled' }) } as any;

it('passes typed telemetry and registry context to the history boundary', async () => {
  const registry = new DeviceRegistryService();
  registry.ingestRegistryPayload({
    devices: [{ deviceId: 'meter', kind: 'physical', capabilities: ['power'] }],
  });
  const capture = jest.fn();
  const router = new DeviceMqttMessageRouter(
    registry,
    new DeviceObservationService(),
    { capture } as unknown as TelemetryIngestService,
    undefined,
    undefined,
    enrolled,
  );
  const payload = {
    deviceId: 'meter',
    readings: [{ schemaVersion: 1, metric: 'power', value: 10, unit: 'W' }],
  };
  const prefix =
    process.env.HOME_MQTT_TOPIC_PREFIX ||
    `energrid/${process.env.PORTAL_TENANT_ID || 'tenant-demo'}/${process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home'}`;
  await router.route({
    topic: `${prefix}/devices/meter/telemetry`,
    payload,
    payloadText: '{}',
  });
  expect(capture).toHaveBeenCalledWith(
    payload,
    expect.objectContaining({ id: 'meter', kind: 'physical' }),
    'energrid-native',
  );
});

it('exposes completion only after durable telemetry admission and propagates buffer failure', async () => {
  const registry = new DeviceRegistryService();
  let commit!: () => void;
  const capture = jest.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      commit = resolve;
    }),
  );
  const router = new DeviceMqttMessageRouter(
    registry,
    new DeviceObservationService(),
    { capture } as unknown as TelemetryIngestService,
    undefined,
    undefined,
    enrolled,
  );
  const message = {
    topic: 'energrid/tenant-demo/site-home/devices/meter/telemetry',
    payload: { deviceId: 'meter', readings: [] },
    payloadText: '{}',
  };
  const routed = (await router.route(message))!;
  const complete = jest.fn();
  void routed.persisted.then(complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  commit();
  await routed.persisted;
  expect(complete).toHaveBeenCalled();
  capture.mockRejectedValueOnce(new Error('buffer full'));
  await expect((await router.route(message))!.persisted).rejects.toThrow('buffer full');
});

describe('DeviceMqttMessageRouter', () => {
  const shellyId = 'shellyplus2pm-001122334455';
  const shellyMessage = (payload: unknown) => ({
    topic: `${shellyId}/events/rpc`,
    payload,
    payloadText: JSON.stringify(payload),
  });
  const approvedShellyRegistry = (components: string[]) => {
    const registry = new DeviceRegistryService();
    registry.ingestRegistryPayload({ devices: components.map((component, index) => ({
      deviceId: `shelly-logical-${index}`,
      name: `Shelly ${component}`,
      kind: 'physical',
      origin: 'shelly',
      protocol: 'mqtt',
      transport: 'mqtt',
      driver: 'shelly-rpc',
      target: shellyId,
      physicalId: shellyId,
      component,
      channel: Number(component.split(':')[1]),
      capabilities: [component.startsWith('switch:') ? 'switch' : 'power'],
    })) });
    return registry;
  };

  it('discovers an unknown Shelly without approving it, and preserves physical evidence', async () => {
    const registry = new DeviceRegistryService();
    const observation = new DeviceObservationService();
    const capture = jest.fn();
    const discover = jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-1' });
    const router = new DeviceMqttMessageRouter(
      registry,
      observation,
      { capture } as unknown as TelemetryIngestService,
      undefined,
      { discover } as any,
    );
    const result = await router.route(shellyMessage({
      src: shellyId,
      params: { ts: 1791676800, 'switch:0': { output: true, apower: 42 } },
    }));

    await result?.physicalDiscovery;
    expect(registry.getDevices().find(device => device.id === `${shellyId}:switch:0`))
      .toEqual(expect.objectContaining({ trustStatus: 'discovered' }));
    expect(observation.getDevice(`${shellyId}:switch:0`)).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ tenantId: expect.any(String), siteId: expect.any(String) }),
      identity: { namespace: 'mqtt:shelly-protocol-id', value: shellyId },
      components: [{ key: 'switch:0', capabilities: ['power', 'switch'] }],
    }));
  });

  it('resolves an enrolled Shelly component by its exact protocol identity before applying telemetry', async () => {
    const registry = approvedShellyRegistry(['switch:0']);
    const observation = new DeviceObservationService();
    const capture = jest.fn().mockResolvedValue(undefined);
    const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
    const discover = jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-1' });
    const router = new DeviceMqttMessageRouter(
      registry, observation, { capture } as unknown as TelemetryIngestService,
      undefined, { discover } as any, enrollment as any,
    );
    const ingest = jest.spyOn(registry, 'ingestDeviceTelemetry');
    const result = await router.route(shellyMessage({
      src: shellyId,
      params: { ts: 1791676800, 'switch:0': { output: true, apower: 42 } },
    }));
    await result?.persisted;
    await result?.physicalDiscovery;

    expect(enrollment.find).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'shelly-logical-0' }));
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'shelly-logical-0', values: { on: true, power: 42 },
    }));
    expect(ingest.mock.calls[0][0]).not.toHaveProperty('target');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(observation.getDevice('shelly-logical-0')).not.toBeNull();
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({
      identity: { namespace: 'mqtt:shelly-protocol-id', value: shellyId },
      components: [{ key: 'switch:0', capabilities: ['power', 'switch'] }],
    }));
  });

  it('keeps multiple Shelly components under one protocol identity and routes each enrolled component', async () => {
    const registry = approvedShellyRegistry(['switch:0', 'switch:1']);
    const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
    const router = new DeviceMqttMessageRouter(
      registry, new DeviceObservationService(), undefined, undefined, undefined, enrollment as any,
    );
    const result = await router.route(shellyMessage({
      src: shellyId,
      params: {
        ts: 1791676800,
        'switch:0': { output: true, apower: 42 },
        'switch:1': { output: false, apower: 0 },
      },
    }));

    expect(enrollment.find).toHaveBeenCalledTimes(2);
    expect(result?.physicalDiscoveries?.map(item => item.identity)).toEqual([
      { namespace: 'mqtt:shelly-protocol-id', value: shellyId },
      { namespace: 'mqtt:shelly-protocol-id', value: shellyId },
    ]);
  });

  it.each(['suspended', 'retired'] as const)(
    'blocks Shelly telemetry for a %s enrollment without mutating Registry or telemetry state',
    async status => {
      const registry = approvedShellyRegistry(['switch:0']);
      const ingest = jest.spyOn(registry, 'ingestDeviceTelemetry');
      const observation = new DeviceObservationService();
      const capture = jest.fn();
      const router = new DeviceMqttMessageRouter(
        registry,
        observation,
        { capture } as unknown as TelemetryIngestService,
        undefined,
        undefined,
        { find: async () => ({ status }) } as any,
      );
      const before = registry.getDevices().find(device => device.id === 'shelly-logical-0')?.state.values;

      const result = await router.route(shellyMessage({
        src: shellyId,
        params: { ts: 1791676800, 'switch:0': { output: true, apower: 42 } },
      }));

      expect(result?.observationAdmission).toEqual({ outcome: 'rejected', reasonCode: 'device_not_enrolled' });
      expect(ingest).not.toHaveBeenCalled();
      expect(observation.getDevice('shelly-logical-0')).toBeNull();
      expect(capture).not.toHaveBeenCalled();
      expect(registry.getDevices().find(device => device.id === 'shelly-logical-0')?.state.values).toEqual(before);
    },
  );

  it('blocks telemetry admission for a retired enrollment despite stale registry state', async () => {
    const registry = new DeviceRegistryService();
    const observation = new DeviceObservationService();
    const router = new DeviceMqttMessageRouter(
      registry,
      observation,
      undefined,
      undefined,
      undefined,
      { find: async () => ({ status: 'retired' }) } as any,
    );
    const result = await router.route({
      topic: 'energrid/tenant-demo/site-home/devices/meter/telemetry',
      payload: { deviceId: 'meter', values: { power: 12 } },
      payloadText: '{"deviceId":"meter","values":{"power":12}}',
    });

    expect(result?.observationAdmission).toEqual({
      outcome: 'rejected', reasonCode: 'device_not_enrolled',
    });
    expect(observation.getDevice('meter')).toBeNull();
    expect(registry.getDevices().find(device => device.id === 'meter')?.state.values.power)
      .toBeUndefined();
  });

  it('rejects the legacy registry effect for a retired enrollment before Registry mutation', async () => {
    const previous = process.env.HOME_MQTT_LEGACY_TEMPERATURE_TOPICS;
    process.env.HOME_MQTT_LEGACY_TEMPERATURE_TOPICS = 'test/temp|meter|Kitchen|Meter';
    try {
      const registry = new DeviceRegistryService();
      const ingest = jest.spyOn(registry, 'ingestRegistryPayload');
      const router = new DeviceMqttMessageRouter(
        registry,
        new DeviceObservationService(),
        undefined,
        undefined,
        undefined,
        { find: async () => ({ status: 'retired' }) } as any,
      );

      const result = await router.route({
        topic: 'test/temp',
        payload: { temperature: 19.1 },
        payloadText: '{"temperature":19.1}',
      });

      expect(ingest).not.toHaveBeenCalled();
      expect(result?.observationAdmissions).toEqual([
        { deviceId: 'meter', outcome: 'rejected', reasonCode: 'enrollment_retired' },
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOME_MQTT_LEGACY_TEMPERATURE_TOPICS;
      else process.env.HOME_MQTT_LEGACY_TEMPERATURE_TOPICS = previous;
    }
  });

  it('fails closed when enrollment status is unavailable and leaves state unchanged', async () => {
    const registry = new DeviceRegistryService();
    const observation = new DeviceObservationService();
    const router = new DeviceMqttMessageRouter(registry, observation);

    const result = await router.route({
      topic: 'energrid/tenant-demo/site-home/devices/meter/telemetry',
      payload: { deviceId: 'meter', values: { power: 12 } },
      payloadText: '{"deviceId":"meter","values":{"power":12}}',
    });

    expect(result?.observationAdmission).toEqual({
      outcome: 'rejected', reasonCode: 'device_not_enrolled',
    });
    expect(result?.observationAdmissions).toEqual([
      { deviceId: 'meter', outcome: 'rejected', reasonCode: 'enrollment_unavailable' },
    ]);
    expect(observation.getDevice('meter')).toBeNull();
  });

  it('does not admit retired-device online status into Registry state', async () => {
    const registry = new DeviceRegistryService();
    const ingestStatus = jest.spyOn(registry, 'ingestDeviceStatus');
    const router = new DeviceMqttMessageRouter(
      registry,
      new DeviceObservationService(),
      undefined,
      undefined,
      undefined,
      { find: async () => ({ status: 'retired' }) } as any,
    );

    await router.route({
      topic: 'devices/meter/online',
      payload: 'online',
      payloadText: '"online"',
    });

    expect(ingestStatus).not.toHaveBeenCalled();
  });

  it('includes standard Shelly device-root subscriptions in the actual router subscription list', () => {
    const router = new DeviceMqttMessageRouter(
      new DeviceRegistryService(),
      new DeviceObservationService(),
    );
    expect(router.subscriptions('energrid/tenant-demo/site-home')).toEqual(
      expect.arrayContaining(['+/events/rpc', '+/status/+']),
    );
    expect(
      router.subscriptions('energrid/tenant-demo/site-home'),
    ).not.toContain('#');
  });
  it('stores telemetry observations when a device reports', async () => {
    const registry = new DeviceRegistryService();
    const observation = new DeviceObservationService();

    const router = new DeviceMqttMessageRouter(registry, observation, undefined, undefined, undefined, enrolled);

    const result = await router.route({
      topic: 'energrid/tenant-demo/site-home/devices/pump/telemetry',

      payload: {
        deviceId: 'pump',
        values: {
          power: 350,
        },
        observedAt: '2026-08-07T12:00:00.000Z',
        origin: 'mqtt',
        protocol: 'mqtt',
      },

      payloadText: '{}',
    });

    expect(result).toBeTruthy();

    expect(observation.getDevice('pump')).toEqual(
      expect.objectContaining({
        deviceId: 'pump',
        observations: 1,
        lastValues: {
          power: 350,
        },
      }),
    );
  });

  it('uses server receive time for health memory instead of an MQTT device timestamp', async () => {
    const receivedAt = new Date('2026-10-20T10:00:00.000Z');
    const deviceTimestamp = '2099-01-01T00:00:00.000Z';
    jest.useFakeTimers().setSystemTime(receivedAt);

    try {
      const registry = new DeviceRegistryService();
      const observation = new DeviceObservationService();
      const router = new DeviceMqttMessageRouter(
        registry,
        observation,
        undefined,
        undefined,
        undefined,
        enrolled,
      );

      await router.route({
        topic: 'energrid/tenant-demo/site-home/devices/meter/telemetry',
        payload: {
          deviceId: 'meter',
          values: { power: 12 },
          observedAt: deviceTimestamp,
        },
        payloadText: '{}',
      });

      expect(observation.getDevice('meter')?.lastSeen).toBe(receivedAt.toISOString());
    } finally {
      jest.useRealTimers();
    }
  });
});

it('creates healthy device health after telemetry ingestion', async () => {
  const registry = new DeviceRegistryService();
  const observation = new DeviceObservationService();
  const health = new DeviceHealthService();

  const router = new DeviceMqttMessageRouter(registry, observation, undefined, undefined, undefined, enrolled);

  await router.route({
    topic: 'energrid/tenant-demo/site-home/devices/pump/telemetry',

    payload: {
      deviceId: 'pump',
      values: {
        power: 350,
      },
      observedAt: new Date().toISOString(),
      origin: 'mqtt',
      protocol: 'mqtt',
    },

    payloadText: '{}',
  });

  const memory = observation.getDevice('pump');

  expect(memory).toBeDefined();

  const result = health.evaluate(memory!);

  expect(result).toEqual(
    expect.objectContaining({
      deviceId: 'pump',
      status: 'healthy',
    }),
  );

  expect(result.confidence).toBeGreaterThan(0.9);
});
