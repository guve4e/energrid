import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceObservationStateStore } from '../device-observation-state.store';
import { DeviceRegistryService } from '../device-registry.service';

import {
  ApprovedMqttObservationRoute,
  type ApprovedMqttObservationConfig,
} from './approved-mqtt-observation.route';

describe('Approved observation startup recovery', () => {
  const scope = {
    tenantId: 'test-tenant',
    siteId: 'test-site',
  };

  const binding = {
    deviceId: 'virtual-temperature',
    sourceId: 'virtual-mqtt-source',
    selector: 'test/virtual-temperature/data',
    fields: {
      temperature: {
        rawKey: 'temperature',
        type: 'number' as const,
      },
      humidity: {
        rawKey: 'humidity',
        type: 'number' as const,
      },
    },
  };

  const config: ApprovedMqttObservationConfig = {
    scope,
    binding,
    policy: {
      deviceId: binding.deviceId,
      allowedSourcesByField: {
        temperature: [binding.sourceId],
        humidity: [binding.sourceId],
      },
    },
  };

  const historicalTime = '2026-10-17T12:00:00.000Z';

  function makeRegistry() {
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
        id: binding.deviceId,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        kind: 'physical',
        trustStatus: 'approved',
      },
    ]);

    return { registry, internal };
  }

  function installation(approved = true) {
    return {
      get: jest.fn(async () =>
        approved
          ? {
              schemaVersion: 1,
              device: {
                id: binding.deviceId,
                tenantId: scope.tenantId,
                siteId: scope.siteId,
                trustStatus: 'approved',
              },
            }
          : null,
      ),
    } as any;
  }

  function displayed(internal: any) {
    return internal.withLiveState({
      id: binding.deviceId,
      state: {
        values: {
          temperature: 26,
          battery: 80,
        },
        observedAt: '2026-10-16T10:00:00.000Z',
        source: 'legacy',
        status: 'unknown',
      },
    }).state;
  }

  it('restores historical data and protects it from legacy telemetry', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'energrid-recovery-'),
    );

    let store = new DeviceObservationStateStore(directory);

    try {
      const result = await store.process(
        scope,
        binding.deviceId,
        {
          binding,
          policy: config.policy,
          context: {
            selector: binding.selector,
            receivedAt: historicalTime,
          },
          payload: {
            temperature: 21.8,
            humidity: 43,
          },
        },
      );

      expect(result.accepted).toBe(true);

      // Simulate application shutdown.
      await store.close();

      // Reopen durable storage with a fresh registry.
      store = new DeviceObservationStateStore(directory);

      const { registry, internal } = makeRegistry();

      const route = new ApprovedMqttObservationRoute(
        registry,
        store,
        [config],
        installation(),
      );

      await route.recover();

      let state = displayed(internal);

      expect(state.values.temperature).toBe(21.8);
      expect(state.values.humidity).toBe(43);
      expect(state.values.battery).toBe(80);

      // Restart must preserve the original timestamp.
      expect(state.observedAt).toBe(historicalTime);

      // Recovery must not claim that a device is online.
      expect(state.status).toBe('unknown');

      // Simulated old MQTT fixture arrives after recovery.
      registry.ingestDeviceTelemetry({
        deviceId: binding.deviceId,
        origin: 'legacy',
        values: {
          temperature: 26,
          humidity: 40.2,
          battery: 91,
        },
      });

      state = displayed(internal);

      expect(state.values).toEqual({
        temperature: 21.8,
        humidity: 43,
        battery: 91,
      });

      expect(state.observedAt).toBe(historicalTime);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('claims fields before any observation exists', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'energrid-empty-recovery-'),
    );

    const store = new DeviceObservationStateStore(directory);

    try {
      const { registry, internal } = makeRegistry();

      const route = new ApprovedMqttObservationRoute(
        registry,
        store,
        [config],
        installation(),
      );

      await route.recover();

      registry.ingestDeviceTelemetry({
        deviceId: binding.deviceId,
        origin: 'legacy',
        values: {
          temperature: 26,
          battery: 91,
        },
      });

      const state = displayed(internal);

      // No approved temperature has ever been measured.
      expect(state.values.temperature).toBeUndefined();

      // Unowned legacy telemetry still works.
      expect(state.values.battery).toBe(91);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not claim ownership without persisted approval', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'energrid-unapproved-recovery-'),
    );

    const store = new DeviceObservationStateStore(directory);

    try {
      const { registry, internal } = makeRegistry();

      const route = new ApprovedMqttObservationRoute(
        registry,
        store,
        [config],
        installation(false),
      );

      await route.recover();

      registry.ingestDeviceTelemetry({
        deviceId: binding.deviceId,
        origin: 'legacy',
        values: { temperature: 26 },
      });

      expect(displayed(internal).values.temperature).toBe(26);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
