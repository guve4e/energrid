import { DeviceRegistryService } from './device-registry.service';

describe('Authoritative observation registry projection', () => {
  function setup() {
    // Isolate the registry projection behavior without initializing
    // hardware, network discovery, or persistent dependencies.
    const registry = Object.create(
      DeviceRegistryService.prototype,
    ) as DeviceRegistryService;

    const internal = registry as any;

    internal.liveStateByDeviceId = new Map();
    internal.commandByDeviceId = new Map();
    internal.liveApprovedDeviceConfigs = new Map();
    internal.liveDiscoveredDeviceConfigs = new Map();
    internal.authoritativeObservationByDeviceId = new Map();
    internal.authoritativeFieldOwnershipByDeviceId = new Map();

    // Prevent unrelated command-reconciliation dependencies
    // from running in this focused test.
    jest
      .spyOn(internal, 'refreshDeviceCommand')
      .mockImplementation(() => {});

    jest
      .spyOn(internal, 'observeCommandTelemetry')
      .mockImplementation(() => {});

    return { registry, internal };
  }

  function displayedValues(internal: any, deviceId: string) {
    const device = {
      id: deviceId,
      state: {
        values: {},
        observedAt: null,
        source: 'registry',
        status: 'unknown',
      },
    };

    return internal.withLiveState(device).state;
  }

  it('protects approved temperature while preserving legacy battery telemetry', () => {
    const { registry, internal } = setup();

    internal.liveApprovedDeviceConfigs.set('virtual-temp', {});

    registry.projectApprovedObservation({
      deviceId: 'virtual-temp',
      values: {
        temperature: 21.8,
        humidity: 43,
      },
      observedAt: '2026-10-18T12:00:00.000Z',
    });

    registry.ingestDeviceTelemetry({
      deviceId: 'virtual-temp',
      values: {
        temperature: 26,
        humidity: 40.2,
        battery: 91,
      },
      origin: 'legacy',
      observedAt: '2026-10-18T12:01:00.000Z',
    });

    const state = displayedValues(internal, 'virtual-temp');

    expect(state.values).toEqual({
      temperature: 21.8,
      humidity: 43,
      battery: 91,
    });

    expect(state.source).toBe('approved-observation');
    expect(state.observedAt).toBe(
      '2026-10-18T12:00:00.000Z',
    );
  });

  it('preserves existing behavior for legacy-only devices', () => {
    const { registry, internal } = setup();

    internal.liveApprovedDeviceConfigs.set('legacy-temp', {});

    registry.ingestDeviceTelemetry({
      deviceId: 'legacy-temp',
      values: {
        temperature: 26,
        humidity: 40.2,
      },
      origin: 'legacy',
    });

    const state = displayedValues(internal, 'legacy-temp');

    expect(state.values.temperature).toBe(26);
    expect(state.values.humidity).toBe(40.2);
    expect(state.source).toBe('legacy');
  });

  it('keeps approved values above legacy registry configuration state', () => {
    const { registry, internal } = setup();

    registry.projectApprovedObservation({
      deviceId: 'virtual-temp',
      values: { temperature: 21.8 },
      observedAt: '2026-10-18T12:00:00.000Z',
    });

    const device = {
      id: 'virtual-temp',
      state: {
        values: { temperature: 26, battery: 80 },
        observedAt: '2026-10-18T11:00:00.000Z',
        source: 'mqtt-registry',
        status: 'online',
      },
    };

    const state = internal.withLiveState(device).state;

    expect(state.values).toEqual({
      temperature: 21.8,
      battery: 80,
    });

    expect(state.source).toBe('approved-observation');
  });
});
