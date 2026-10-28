import { DeviceMqttMessageRouter } from './device-mqtt-message-router';
import { DeviceRegistryService } from '../device-registry.service';
import { DeviceObservationService } from '../device-observation.service';
import { DeviceHealthService } from '../device-health.service';
import { TelemetryIngestService } from '../../telemetry/telemetry-ingest.service';
import { shellyPro2PmNotifyStatusFixture } from '../adapters/inbound/shelly/__fixtures__/shelly-pro2pm-notifystatus.fixture';
import { ApprovedMqttObservationRuntime } from './approved-mqtt-observation.runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('keeps an unknown Shelly MQTT identity claim as evidence only', async () => {
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

    expect(result?.observationAdmission).toEqual({ outcome: 'rejected', reasonCode: 'shelly_observation_runtime_unavailable' });
    expect(result?.physicalDiscovery).toBeUndefined();
    expect(result?.physicalDiscoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        identity: { namespace: 'mqtt:shelly-protocol-id', value: shellyId },
        components: [{ key: 'switch:0', capabilities: ['power', 'switch'] }],
      }),
    ]));
    expect(registry.getDevices().find(device => device.id === `${shellyId}:switch:0`)).toBeUndefined();
    expect(observation.getDevice(`${shellyId}:switch:0`)).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it('does not use enrollment alone to authorize Shelly MQTT telemetry', async () => {
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
    expect(result?.observationAdmission).toMatchObject({ outcome: 'rejected' });
    expect(enrollment.find).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(observation.getDevice('shelly-logical-0')).toBeNull();
    expect(discover).not.toHaveBeenCalled();
  });

  it('uses the exact LAN-verified installation ingress before projecting approved power to electrical history', async () => {
    const deviceId = `${shellyId}:switch:0`;
    const device = {
      id: deviceId, tenantId: 'tenant-a', siteId: 'site-a', kind: 'physical', trustStatus: 'approved',
      adapter: { protocol: 'http', driver: 'shelly-lan' },
      metadata: { physicalId: shellyId, component: 'switch:0' },
    };
    const registry = { getDevices: jest.fn().mockReturnValue([device]) };
    const observation = new DeviceObservationService();
    const capture = jest.fn().mockResolvedValue(undefined);
    const approvedObservationRuntime = {
      ingestShellyMqttObservation: jest.fn().mockResolvedValue({
        outcome: 'processed', accepted: true, deviceId,
        updatedKeys: ['power'],
        scope: { tenantId: 'tenant-a', siteId: 'site-a' },
      }),
    };
    const router = new DeviceMqttMessageRouter(
      registry as any, observation,
      { capture } as unknown as TelemetryIngestService,
      undefined, undefined, undefined, approvedObservationRuntime as any,
    );
    const payload = { src: shellyId, params: { ts: 1791676800, 'switch:0': { output: false, apower: 42 } } };
    const result = await router.route(shellyMessage(payload));
    await result?.persisted;
    expect(approvedObservationRuntime.ingestShellyMqttObservation).toHaveBeenCalledWith(expect.objectContaining({
      topic: `${shellyId}/events/rpc`, physicalId: shellyId, componentKey: 'switch:0', values: { power: 42 },
      evidenceId: expect.any(String),
    }));
    expect(result?.observationAdmission).toEqual({ outcome: 'admitted' });
    expect(result?.effects).toEqual([]);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      deviceId,
      tenantId: 'tenant-a',
      siteId: 'site-a',
      readings: [expect.objectContaining({ metric: 'power', value: 42 })],
    }), device, 'shelly-mqtt');
    expect(observation.getDevice(deviceId)).toBeNull();
  });

  it('projects only canonical measurements from real-shaped NotifyStatus and processes each switch separately', async () => {
    const topic = 'shelly/washer@other/events/rpc';
    const runtimeCalls: Array<{ componentKey: string; values: Record<string, unknown> }> = [];
    const registry = { getDevices: jest.fn().mockReturnValue([]) };
    const approvedObservationRuntime = {
      ingestShellyMqttObservation: jest.fn().mockImplementation(async (input) => {
        runtimeCalls.push({ componentKey: input.componentKey, values: input.values });
        return { outcome: 'processed', accepted: true, deviceId: `${shellyId}:${input.componentKey}`,
          updatedKeys: Object.keys(input.values), scope: { tenantId: 'tenant-a', siteId: 'site-a' } };
      }),
    };
    const router = new DeviceMqttMessageRouter(
      registry as any, new DeviceObservationService(), undefined, undefined, undefined, undefined,
      approvedObservationRuntime as any,
    );
    const payload = {
      ...shellyPro2PmNotifyStatusFixture,
      params: {
        ...shellyPro2PmNotifyStatusFixture.params,
        // These status/control and alternate-schema values are retained in
        // the incoming Bus message, but only canonical readings cross the
        // approved observation boundary.
        'switch:0': { ...shellyPro2PmNotifyStatusFixture.params['switch:0'], current: 0, voltage: 230, total_act_energy: 0, total_act_ret_energy: 0 },
        'switch:1': { ...shellyPro2PmNotifyStatusFixture.params['switch:1'], current: 0, voltage: 230, total_act_energy: 0, total_act_ret_energy: 0 },
      },
    };
    const result = await router.route({ topic, payload, payloadText: JSON.stringify(payload) });

    expect(runtimeCalls).toEqual([
      { componentKey: 'switch:0', values: { power: 0, energy_import_total: 0, energy_export_total: 0 } },
      { componentKey: 'switch:1', values: { power: 0, energy_import_total: 0, energy_export_total: 0 } },
    ]);
    expect(result?.observationAdmissions).toHaveLength(2);
    expect(result?.observationAdmissions?.every(item => item.outcome === 'admitted')).toBe(true);
  });

  it('preserves malformed supported Shelly values as explicit invalid readings for rejection', async () => {
    const approvedObservationRuntime = {
      ingestShellyMqttObservation: jest.fn().mockResolvedValue({
        outcome: 'rejected', reasonCode: 'shelly_observation_measurement_invalid',
      }),
    };
    const router = new DeviceMqttMessageRouter(
      { getDevices: jest.fn().mockReturnValue([]) } as any, new DeviceObservationService(),
      undefined, undefined, undefined, undefined, approvedObservationRuntime as any,
    );
    const payload = { src: shellyId, method: 'NotifyStatus', params: { ts: 1791676800,
      'switch:0': { apower: null, current: 1, voltage: 230 } } };
    const result = await router.route(shellyMessage(payload));
    expect(approvedObservationRuntime.ingestShellyMqttObservation).toHaveBeenCalledWith(expect.objectContaining({
      values: { power: null },
    }));
    expect(result?.observationAdmissions).toEqual([expect.objectContaining({
      outcome: 'rejected', reasonCode: 'shelly_observation_measurement_invalid',
    })]);
  });

  it('passes a valid canonical measurement to the authority gate despite extra status fields', async () => {
    const previousEnv = { ...process.env };
    const directory = await mkdtemp(join(tmpdir(), 'energrid-shelly-router-'));
    let runtime: ApprovedMqttObservationRuntime | undefined;
    try {
      process.env.HOME_OBSERVATION_STORE_DIRECTORY = directory;
      process.env.HOME_HTTP_POLL_ENABLED = 'true';
      delete process.env.HOME_OBSERVATION_BINDINGS_JSON;
      delete process.env.LAB_MQTT_OBSERVATION_BINDINGS_JSON;
      const physicalId = 'shellypro2pm-ec6260888084';
      const deviceId = `${physicalId}:switch:0`;
      const device = {
        id: deviceId, tenantId: 'tenant-a', siteId: 'site-a', kind: 'physical', trustStatus: 'approved',
        metadata: { physicalId, component: 'switch:0',
          identityEvidenceSource: 'verified_shelly_http_rpc',
          componentEvidenceSource: 'verified_shelly_component_status_rpc',
          shellyMqttObservationApprovalRequired: true,
          verifiedMeasurementFields: 'power,energy_import_total,energy_export_total' },
      };
      const registry = { ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
        getDevices: jest.fn().mockReturnValue([device]), projectApprovedObservation: jest.fn() };
      const installations = { get: jest.fn().mockResolvedValue({ schemaVersion: 1, device }) };
      const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
      runtime = new ApprovedMqttObservationRuntime(registry as any, installations as any, enrollment as any);
      const router = new DeviceMqttMessageRouter(
        registry as any, new DeviceObservationService(), undefined, undefined, undefined, undefined, runtime,
      );
      const payload = { src: physicalId, method: 'NotifyStatus', params: { ts: 1791676800,
        'switch:0': { output: false, apower: 0, current: 0.1, voltage: 230, total_act_energy: 0, total_act_ret_energy: 0 } } };
      const result = await router.route({ topic: 'shelly/washer@other/events/rpc', payload, payloadText: JSON.stringify(payload) });
      expect(result?.observationAdmissions).toEqual([expect.objectContaining({
        outcome: 'rejected', reasonCode: 'observation_authority_missing',
      })]);
      expect(installations.get).toHaveBeenCalledWith('site-a', deviceId);
      expect(registry.projectApprovedObservation).not.toHaveBeenCalled();
    } finally {
      await runtime?.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
      process.env = previousEnv;
    }
  });

  it('does not invent zero-valued measurements when a status has no supported measurement fields', async () => {
    const approvedObservationRuntime = {
      ingestShellyMqttObservation: jest.fn().mockResolvedValue({
        outcome: 'rejected', reasonCode: 'shelly_observation_contract_invalid',
      }),
    };
    const router = new DeviceMqttMessageRouter(
      { getDevices: jest.fn().mockReturnValue([]) } as any, new DeviceObservationService(),
      undefined, undefined, undefined, undefined, approvedObservationRuntime as any,
    );
    const payload = { src: shellyId, method: 'NotifyStatus', params: { ts: 1791676800,
      'switch:0': { output: false, current: 1, voltage: 230 } } };
    await router.route(shellyMessage(payload));
    expect(approvedObservationRuntime.ingestShellyMqttObservation).toHaveBeenCalledWith(expect.objectContaining({
      values: {},
    }));
  });

  it('does not route MQTT-reported Shelly components without explicit installed bindings', async () => {
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

    expect(enrollment.find).not.toHaveBeenCalled();
    expect(result?.observationAdmissions).toHaveLength(2);
    expect(result?.observationAdmissions?.every(item => item.outcome === 'rejected')).toBe(true);
    expect(result?.physicalDiscovery).toBeUndefined();
  });

  it('does not infer an authorized Shelly source from suspended or retired enrollment state', async () => {
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
        { find: async () => ({ status: 'enrolled' }) } as any,
      );
      const before = registry.getDevices().find(device => device.id === 'shelly-logical-0')?.state.values;

      const result = await router.route(shellyMessage({
        src: shellyId,
        params: { ts: 1791676800, 'switch:0': { output: true, apower: 42 } },
      }));

      expect(result?.observationAdmission).toEqual({ outcome: 'rejected', reasonCode: 'shelly_observation_runtime_unavailable' });
      expect(ingest).not.toHaveBeenCalled();
      expect(observation.getDevice('shelly-logical-0')).toBeNull();
      expect(capture).not.toHaveBeenCalled();
      expect(registry.getDevices().find(device => device.id === 'shelly-logical-0')?.state.values).toEqual(before);
  });

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
  const health = new DeviceHealthService(observation);

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
