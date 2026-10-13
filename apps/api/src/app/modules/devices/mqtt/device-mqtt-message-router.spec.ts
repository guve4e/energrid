import { DeviceMqttMessageRouter } from './device-mqtt-message-router';
import { DeviceRegistryService } from '../device-registry.service';
import { DeviceObservationService } from '../device-observation.service';
import { DeviceHealthService } from '../device-health.service';
import { TelemetryIngestService } from '../../telemetry/telemetry-ingest.service';

it('passes typed telemetry and registry context to the history boundary', () => {
  const registry = new DeviceRegistryService();
  registry.ingestRegistryPayload({
    devices: [{ deviceId: 'meter', kind: 'physical', capabilities: ['power'] }],
  });
  const capture = jest.fn();
  const router = new DeviceMqttMessageRouter(
    registry,
    new DeviceObservationService(),
    { capture } as unknown as TelemetryIngestService,
  );
  const payload = {
    deviceId: 'meter',
    readings: [{ schemaVersion: 1, metric: 'power', value: 10, unit: 'W' }],
  };
  const prefix =
    process.env.HOME_MQTT_TOPIC_PREFIX ||
    `energrid/${process.env.PORTAL_TENANT_ID || 'tenant-demo'}/${process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home'}`;
  router.route({
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
  );
  const message = {
    topic: 'energrid/tenant-demo/site-home/devices/meter/telemetry',
    payload: { deviceId: 'meter', readings: [] },
    payloadText: '{}',
  };
  const routed = router.route(message)!;
  const complete = jest.fn();
  void routed.persisted.then(complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  commit();
  await routed.persisted;
  expect(complete).toHaveBeenCalled();
  capture.mockRejectedValueOnce(new Error('buffer full'));
  await expect(router.route(message)!.persisted).rejects.toThrow('buffer full');
});

describe('DeviceMqttMessageRouter', () => {
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
  it('stores telemetry observations when a device reports', () => {
    const registry = new DeviceRegistryService();
    const observation = new DeviceObservationService();

    const router = new DeviceMqttMessageRouter(registry, observation);

    const result = router.route({
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
});

it('creates healthy device health after telemetry ingestion', () => {
  const registry = new DeviceRegistryService();
  const observation = new DeviceObservationService();
  const health = new DeviceHealthService();

  const router = new DeviceMqttMessageRouter(registry, observation);

  router.route({
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
