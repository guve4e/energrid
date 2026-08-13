import { DeviceMqttMessageRouter } from './device-mqtt-message-router';
import { DeviceRegistryService } from '../device-registry.service';
import { DeviceObservationService } from '../device-observation.service';
import { DeviceHealthService } from '../device-health.service';

describe('DeviceMqttMessageRouter', () => {

  it('stores telemetry observations when a device reports', () => {

    const registry = new DeviceRegistryService();
    const observation = new DeviceObservationService();

    const router = new DeviceMqttMessageRouter(
      registry,
      observation,
    );


    const result = router.route({
      topic:
        'energrid/tenant-demo/site-home/devices/pump/telemetry',

      payload: {
        deviceId: 'pump',
        values: {
          power: 350,
        },
        observedAt:
          '2026-08-07T12:00:00.000Z',
        origin:'mqtt',
        protocol:'mqtt',
      },

      payloadText:'{}',
    });


    expect(result).toBeTruthy();

    expect(
      observation.getDevice('pump'),
    ).toEqual(
      expect.objectContaining({
        deviceId:'pump',
        observations:1,
        lastValues:{
          power:350,
        },
      }),
    );

  });

});

  it('creates healthy device health after telemetry ingestion', () => {
    const registry = new DeviceRegistryService();
    const observation = new DeviceObservationService();
    const health = new DeviceHealthService();

    const router = new DeviceMqttMessageRouter(
      registry,
      observation,
    );

    router.route({
      topic:
        'energrid/tenant-demo/site-home/devices/pump/telemetry',

      payload: {
        deviceId: 'pump',
        values: {
          power: 350,
        },
        observedAt:
          new Date().toISOString(),
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

