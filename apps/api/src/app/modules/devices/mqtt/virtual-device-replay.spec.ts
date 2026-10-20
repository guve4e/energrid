import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceRegistryService } from '../device-registry.service';
import { DeviceObservationService } from '../device-observation.service';
import { DeviceObservationStateStore } from '../device-observation-state.store';

import { DeviceMqttMessageRouter } from './device-mqtt-message-router';
import {
  ApprovedMqttObservationRoute,
  type ApprovedMqttObservationConfig,
} from './approved-mqtt-observation.route';

describe('Virtual device replay', () => {
  const scope = {
    tenantId: 'replay-tenant',
    siteId: 'replay-site',
  };

  const deviceId = 'virtual-esp8266-kitchen';
  const topic = 'replay/devices/temp-kitchen/data';

  const config: ApprovedMqttObservationConfig = {
    scope,
    binding: {
      deviceId,
      sourceId: 'replay-esp8266-mqtt',
      selector: topic,
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
      deviceId,
      allowedSourcesByField: {
        temperature: ['replay-esp8266-mqtt'],
        humidity: ['replay-esp8266-mqtt'],
      },
    },
  };

  function environment(store: DeviceObservationStateStore) {
    // The real registry methods, but without NestJS,
    // hardware discovery, or network connections.
    const registry = Object.create(
      DeviceRegistryService.prototype,
    ) as DeviceRegistryService;

    const internal = registry as any;

    internal.liveStateByDeviceId = new Map();
    internal.liveApprovedDeviceConfigs = new Map();
    internal.liveDiscoveredDeviceConfigs = new Map();
    internal.commandByDeviceId = new Map();
    internal.authoritativeObservationByDeviceId = new Map();
    internal.authoritativeFieldOwnershipByDeviceId = new Map();

    internal.refreshDeviceCommand = jest.fn();
    internal.observeCommandTelemetry = jest.fn();

    internal.getDevices = jest.fn(() => [
      {
        id: deviceId,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        kind: 'physical',
        trustStatus: 'approved',
      },
    ]);

    const installations = {
      get: jest.fn(async () => ({
        schemaVersion: 1,
        device: {
          id: deviceId,
          tenantId: scope.tenantId,
          siteId: scope.siteId,
          trustStatus: 'approved',
        },
      })),
    };

    const route = new ApprovedMqttObservationRoute(
      registry,
      store,
      [config],
      installations as any,
    );

    const router = new DeviceMqttMessageRouter(
      registry,
      new DeviceObservationService(),
      undefined,
      route,
    );

    function state() {
      return internal.withLiveState({
        id: deviceId,
        state: {
          values: {},
          observedAt: null,
          source: 'registry',
          status: 'unknown',
        },
      }).state;
    }

    async function replay(payload: Record<string, unknown>) {
      const result = await router.route({
        topic,
        payload,
        payloadText: JSON.stringify(payload),
      });

      expect(result).toBeDefined();

      await result!.persisted;
    }

    return {
      registry,
      route,
      router,
      state,
      replay,
    };
  }

  it('replays ESP8266 readings, legacy conflict, and restart', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'energrid-virtual-replay-'),
    );

    let store = new DeviceObservationStateStore(directory);

    try {
      const first = environment(store);

      await first.route.recover();

      // Captured ESP8266 message structure.
      await first.replay({
        temperature: 25.2,
        humidity: 40.3,
        timestamp: 92669135,
      });

      expect(first.state().values).toEqual({
        temperature: 25.2,
        humidity: 40.3,
      });

      // Partial update: humidity is intentionally absent.
      await new Promise((resolve) => setTimeout(resolve, 10));

      await first.replay({
        temperature: 25.3,
        timestamp: 92671135,
      });

      expect(first.state().values).toEqual({
        temperature: 25.3,
        humidity: 40.3,
      });

      // Simulate the conflicting legacy fixture.
      first.registry.ingestDeviceTelemetry({
        deviceId,
        origin: 'legacy',
        values: {
          temperature: 26,
          humidity: 40.2,
          battery: 91,
        },
      });

      expect(first.state().values).toEqual({
        temperature: 25.3,
        humidity: 40.3,
        battery: 91,
      });

      const stored = await store.getState(scope, deviceId);

      expect(stored?.fields.temperature.value).toBe(25.3);
      expect(stored?.fields.humidity.value).toBe(40.3);

      const originalTimestamp =
        stored!.fields.temperature.receivedAt;

      // Simulate an application restart.
      await store.close();

      store = new DeviceObservationStateStore(directory);

      const restarted = environment(store);

      await restarted.route.recover();

      const recovered = restarted.state();

      expect(recovered.values.temperature).toBe(25.3);
      expect(recovered.values.humidity).toBe(40.3);

      // The measurement did not become fresh on restart.
      expect(recovered.observedAt).toBe(originalTimestamp);

      // Recovered observations do not imply connectivity.
      expect(recovered.status).toBe('unknown');

      // A legacy message still cannot overwrite the reading.
      restarted.registry.ingestDeviceTelemetry({
        deviceId,
        origin: 'legacy',
        values: {
          temperature: 26,
          battery: 95,
        },
      });

      expect(restarted.state().values).toEqual({
        temperature: 25.3,
        humidity: 40.3,
        battery: 95,
      });
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not treat a heartbeat as a temperature observation', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'energrid-replay-heartbeat-'),
    );

    const store = new DeviceObservationStateStore(directory);

    try {
      const env = environment(store);

      await env.route.recover();

      expect(
        env.route.matches('replay/devices/temp-kitchen/status'),
      ).toBe(false);

      expect(
        await store.getState(scope, deviceId),
      ).toBeNull();

      expect(env.state().values.temperature).toBeUndefined();
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
