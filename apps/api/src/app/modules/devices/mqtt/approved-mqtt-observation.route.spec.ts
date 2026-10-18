import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceMqttMessageRouter } from './device-mqtt-message-router';
import {
  ApprovedMqttObservationRoute,
  type ApprovedMqttObservationConfig,
} from './approved-mqtt-observation.route';
import { DeviceObservationStateStore } from '../device-observation-state.store';
import { DeviceObservationService } from '../device-observation.service';
import type { DeviceRegistryService } from '../device-registry.service';

describe('Approved ESP8266 MQTT observation integration', () => {
  let directory: string;
  let store: DeviceObservationStateStore;
  let registry: DeviceRegistryService;
  let router: DeviceMqttMessageRouter;

  const scope = {
    tenantId: 'tenant-home',
    siteId: 'site-home',
  };

  const config: ApprovedMqttObservationConfig = {
    scope,
    binding: {
      deviceId: 'temp-kitchen',
      sourceId: 'approved-esp8266-mqtt',
      selector: 'devices/temp-kitchen/data',
      fields: {
        temperature: {
          rawKey: 'temperature',
          type: 'number',
        },
        humidity: {
          rawKey: 'humidity',
          type: 'number',
        },
      },
    },
    policy: {
      deviceId: 'temp-kitchen',
      allowedSourcesByField: {
        temperature: ['approved-esp8266-mqtt'],
        humidity: ['approved-esp8266-mqtt'],
      },
    },
  };

  const message = {
    topic: 'devices/temp-kitchen/data',
    payload: {
      temperature: 25,
      humidity: 41.4,
      timestamp: 78775134,
    },
    payloadText:
      '{"temperature":25,"humidity":41.4,"timestamp":78775134}',
  };

  let approved = true;
  let installed = true;
  let projection: jest.Mock;

  function configureRouter(): void {
    projection = jest.fn();

    registry = {
      getDevices: jest.fn(() =>
        approved
          ? [
              {
                id: 'temp-kitchen',
                tenantId: 'tenant-home',
                siteId: 'site-home',
                trustStatus: 'approved',
                kind: 'physical',
              },
            ]
          : [],
      ),
      projectApprovedObservation: projection,
    } as unknown as DeviceRegistryService;

    const route = new ApprovedMqttObservationRoute(
      registry,
      store,
      [config],
      {
        get: jest.fn(async () =>
          installed
            ? {
                schemaVersion: 1,
                device: {
                  id: 'temp-kitchen',
                  tenantId: 'tenant-home',
                  siteId: 'site-home',
                  trustStatus: 'approved',
                },
              }
            : null,
        ),
      } as any,
    );

    router = new DeviceMqttMessageRouter(
      registry,
      new DeviceObservationService(),
      undefined,
      route,
    );
  }

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'energrid-approved-mqtt-'),
    );

    store = new DeviceObservationStateStore(directory);
    approved = true;
    installed = true;
    configureRouter();
  });

  afterEach(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists 25°C and 41.4% before projecting to the registry', async () => {
    const routed = router.route(message);

    expect(routed).not.toBeNull();
    expect(routed?.reason).toBe('configured approved observation');

    await routed!.persisted;

    const state = await store.getState(scope, 'temp-kitchen');

    expect(state?.fields.temperature.value).toBe(25);
    expect(state?.fields.humidity.value).toBe(41.4);

    expect(projection).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'temp-kitchen',
        values: {
          temperature: 25,
          humidity: 41.4,
        },
      }),
    );

    // Device uptime must not become wall-clock observation time.
    expect(state?.fields.temperature.receivedAt).not.toBe(
      '78775134',
    );
  });

  it('does not admit an unapproved device', async () => {
    approved = false;

    await router.route(message)!.persisted;

    expect(
      await store.getState(scope, 'temp-kitchen'),
    ).toBeNull();

    expect(projection).not.toHaveBeenCalled();
  });

  it('rejects registry approval without a persisted installation', async () => {
    approved = true;
    installed = false;

    await router.route(message)!.persisted;

    expect(
      await store.getState(scope, 'temp-kitchen'),
    ).toBeNull();

    expect(projection).not.toHaveBeenCalled();
  });

  it('restores the accepted state after restarting storage', async () => {
    await router.route(message)!.persisted;

    await store.close();

    store = new DeviceObservationStateStore(directory);

    const state = await store.getState(scope, 'temp-kitchen');

    expect(state?.fields.temperature.value).toBe(25);
    expect(state?.fields.humidity.value).toBe(41.4);
  });

  it('never projects an observation when storage is unavailable', async () => {
    await store.close();

    await expect(
      router.route(message)!.persisted,
    ).rejects.toThrow();

    expect(projection).not.toHaveBeenCalled();
  });

  it('preserves normal routing for topics without configured profiles', () => {
    const result = router.route({
      topic: 'devices/unconfigured-sensor/data',
      payload: { temperature: 20 },
      payloadText: '{"temperature":20}',
    });

    expect(result).toBeNull();
    expect(projection).not.toHaveBeenCalled();
  });

  it('includes the approved topic in router subscriptions', () => {
    expect(
      router.subscriptions('energrid/tenant-home/site-home'),
    ).toContain('devices/temp-kitchen/data');
  });
});
