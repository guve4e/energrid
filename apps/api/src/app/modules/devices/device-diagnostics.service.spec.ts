import { DeviceDiagnosticsService } from './device-diagnostics.service';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceLanDiscoveryService } from './device-lan-discovery.service';
import { DeviceMqttIngestService } from './device-mqtt-ingest.service';
import { ShellyHttpControl } from './adapters/outbound/shelly-http-control';
import type { RegisteredDevice } from './device-registry.types';

const originalEnv = process.env;
const physicalId = 'shelly1g4-e4b063747cac';
let device: RegisteredDevice;
let devices: RegisteredDevice[];
let probe: jest.SpyInstance;
let service: DeviceDiagnosticsService;
let registry: { getDevices: jest.Mock; getLatestExecutionTrace: jest.Mock };
let lastScan: jest.Mock;

beforeEach(() => {
  process.env = { HOME_MQTT_HOST: 'devicebroker.ddns.net' };
  device = {
    id: `${physicalId}:switch:0`,
    tenantId: 'tenant-demo',
    siteId: 'site-home',
    kind: 'physical',
    trustStatus: 'approved',
    adapter: { driver: 'shelly-lan', protocol: 'http' },
    metadata: {
      physicalId,
      channel: 0,
      component: 'switch:0',
      httpBaseUrl: 'http://192.168.7.30',
    },
    state: { observedAt: null, values: {}, status: 'unknown' },
    control: {
      status: 'ready',
      binding: {
        kind: 'shelly-mqtt',
        enabled: true,
        physicalId,
        channel: 0,
        topic: 'shelly/rpc',
      },
    },
  } as RegisteredDevice;
  devices = [device];
  registry = {
    getDevices: jest.fn(() => devices),
    getLatestExecutionTrace: jest.fn(() => null),
  };
  lastScan = jest.fn(() => []);
  service = new DeviceDiagnosticsService(
    registry as unknown as DeviceRegistryService,
    { getLastScan: lastScan } as unknown as DeviceLanDiscoveryService,
    {
      getDebugState: () => ({
        status: 'running',
        recentMessages: [{ payload: 'private-secret' }],
      }),
    } as unknown as DeviceMqttIngestService,
  );
  probe = jest
    .spyOn(ShellyHttpControl.prototype, 'readOnly')
    .mockImplementation(async (_route, method) => {
      if (method === 'Shelly.GetDeviceInfo') return { id: physicalId };
      if (method === 'Switch.GetStatus') return { id: 0, output: false };
      if (method === 'MQTT.GetConfig')
        return {
          enable: false,
          enable_rpc: true,
          rpc_ntf: true,
          status_ntf: false,
          server: 'mqtt://user:private-secret@devicebroker.ddns.net',
          topic_prefix: 'shelly',
          password: 'private-secret',
        };
      return { connected: false };
    });
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = originalEnv;
});

describe('device connection diagnostic application service', () => {
  it('uses only read-only methods, preserves configuration/history, and redacts credentials and raw payloads', async () => {
    const before = JSON.stringify(device);
    const r = await service.check(device.id);
    expect(r.code).toBe('mqtt-disabled');
    expect(r.currentRelay?.on).toBe(false);
    expect(probe.mock.calls.map((c) => c[1])).toEqual([
      'Shelly.GetDeviceInfo',
      'Switch.GetStatus',
      'MQTT.GetConfig',
      'MQTT.GetStatus',
    ]);
    expect(probe.mock.calls.every((c) => c[0].enabled === false)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/private-secret|password|user:/);
    expect(JSON.stringify(device)).toBe(before);
  });
  it.each(['discovered', 'blocked'])(
    'does no I/O for %s devices',
    async (trustStatus) => {
      device.trustStatus = trustStatus as RegisteredDevice['trustStatus'];
      expect(() => service.check(device.id)).toThrow('approved devices');
      expect(probe).not.toHaveBeenCalled();
    },
  );
  it.each(['tenantId', 'siteId'] as const)('rejects a different %s', (key) => {
    device[key] = 'other';
    expect(() => service.check(device.id)).toThrow('approved devices');
    expect(probe).not.toHaveBeenCalled();
  });
  it('rejects unknown devices without network activity', () => {
    expect(() => service.check('missing')).toThrow('not found');
    expect(probe).not.toHaveBeenCalled();
  });
  it.each([
    { httpBaseUrl: 'http://169.254.169.254' },
    { httpBaseUrl: 'http://example.com' },
    { httpBaseUrl: 'http://192.168.7.30/path' },
    { physicalId: 'kitchen-shelly' },
    { channel: -1 },
    { channel: 32 },
    { channel: '0' },
    { component: 'switch:1' },
  ])(
    'does not probe unverified identities, channels or unsafe addresses: %j',
    async (metadata) => {
      Object.assign(device.metadata!, metadata);
      expect((await service.check(device.id)).code).toBe('incomplete');
      expect(probe).not.toHaveBeenCalled();
    },
  );
  it('does not guess a channel when metadata is missing', async () => {
    delete device.metadata!.channel;
    await service.check(device.id);
    expect(probe).not.toHaveBeenCalled();
  });
  it('stops after a different hardware identity', async () => {
    probe.mockResolvedValue({ id: 'different-hardware' });
    expect((await service.check(device.id)).code).toBe('identity-mismatch');
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it('does not call a timeout evidence that the device is offline', async () => {
    probe.mockRejectedValue(new Error('private-network-details'));
    const r = await service.check(device.id);
    expect(r.code).toBe('incomplete');
    expect(JSON.stringify(r)).not.toContain('private-network-details');
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it('classifies authentication without leaking an upstream error', async () => {
    probe.mockRejectedValue(
      new Error('Shelly HTTP authentication failed; private-secret'),
    );
    const r = await service.check(device.id);
    expect(r.code).toBe('authentication-required');
    expect(JSON.stringify(r)).not.toContain('private-secret');
  });
  it('continues independent read checks when the relay response is invalid', async () => {
    probe.mockImplementation(async (_r, method) =>
      method === 'Shelly.GetDeviceInfo'
        ? { id: physicalId }
        : { id: 1, output: true },
    );
    const r = await service.check(device.id);
    expect(r.currentRelay).toBeNull();
    expect(r.code).toBe('incomplete');
    expect(probe).toHaveBeenCalledTimes(4);
  });
  it('uses only an exact physical match from the last LAN scan as an address fallback', async () => {
    delete device.metadata!.httpBaseUrl;
    lastScan.mockReturnValue([
      { id: 'other', ipAddress: '192.168.7.1' },
      { id: physicalId, ipAddress: '192.168.7.30' },
    ]);
    await service.check(device.id);
    expect(probe.mock.calls[0][0].baseUrl).toBe('http://192.168.7.30');
  });
  it('respects the explicit HTTP address and credential reference without requiring switching permission', async () => {
    device.control = {
      status: 'disabled',
      reason: '',
      binding: {
        kind: 'shelly-http',
        enabled: false,
        physicalId,
        channel: 0,
        baseUrl: 'http://192.168.7.31',
        credentialRef: 'private-reference',
      },
    };
    const r = await service.check(device.id);
    expect(r.code).toBe('control-disabled');
    expect(probe.mock.calls[0][0]).toMatchObject({
      enabled: false,
      baseUrl: 'http://192.168.7.31',
      credentialRef: 'private-reference',
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it('warns when another physical device uses the same MQTT command topic', async () => {
    devices.push({
      ...device,
      id: 'other:switch:0',
      control: {
        status: 'ready',
        reason: '',
        binding: {
          kind: 'shelly-mqtt',
          enabled: true,
          physicalId: 'shellyplus1-aabbccddeeff',
          channel: 0,
          topic: 'shelly/rpc',
        },
      },
    });
    const r = await service.check(device.id);
    expect(r.checks.find((c) => c.id === 'shared-topic')?.status).toBe(
      'warning',
    );
  });
  it('retains prior command evidence without treating current relay state as its confirmation', async () => {
    registry.getLatestExecutionTrace.mockReturnValue({
      action: 'turn_on',
      outcome: 'timed_out',
      requestedAt: 'before',
      completedAt: 'after',
      stages: [
        {
          stage: 'published',
          status: 'complete',
          observedAt: 'sent',
          evidence: { password: 'private-secret' },
        },
      ],
    });
    const r = await service.check(device.id);
    expect(r.lastCommand).toEqual({
      action: 'turn_on',
      outcome: 'timed_out',
      requestedAt: 'before',
      completedAt: 'after',
      publishedAt: 'sent',
    });
    expect(r.currentRelay?.on).toBe(false);
    expect(JSON.stringify(r)).not.toContain('private-secret');
  });
  it('coalesces simultaneous checks and bounds concurrent devices', async () => {
    const releases: Array<(value: Record<string, unknown>) => void> = [];
    probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const first = service.check(device.id);
    expect(service.check(device.id)).toBe(first);
    const others = ['one', 'two', 'three'].map((id) => {
      devices.push({ ...device, id });
      return service.check(id);
    });
    devices.push({ ...device, id: 'five' });
    expect(() => service.check('five')).toThrow('busy');
    // Resolve all pending identity probes without triggering subsequent requests.
    expect(releases).toHaveLength(4);
    releases.forEach((resolve) => resolve({ id: 'different' }));
    await Promise.all([first, ...others]);
    probe.mockResolvedValue({ id: 'different' });
    await expect(service.check('five')).resolves.toHaveProperty(
      'code',
      'identity-mismatch',
    );
  });
  it('keeps a command without an execution trace explicitly unconfirmed', async () => {
    device.state.command = {
      id: 'old',
      action: 'turn_on',
      status: 'no_ack',
      requestedAt: '2026-10-13T07:00:00Z',
      expectedValues: { on: true },
    };
    const r = await service.check(device.id);
    expect(r.lastCommand).toMatchObject({
      action: 'turn_on',
      outcome: 'no_ack',
      publishedAt: null,
    });
  });
  it.each([
    'http://broker',
    'mqtt://broker/path',
    'mqtt://broker?secret=value',
    'bad port:x',
    '',
    null,
  ])(
    'rejects unsafe or malformed reported broker endpoints without reflecting them: %j',
    async (server) => {
      probe.mockImplementation(async (_route, method) =>
        method === 'Shelly.GetDeviceInfo'
          ? { id: physicalId }
          : method === 'MQTT.GetConfig'
            ? { server }
            : {},
      );
      const r = await service.check(device.id);
      expect(r.checks.find((c) => c.id === 'broker')?.status).toBe('unknown');
      expect(JSON.stringify(r)).not.toContain('secret=value');
    },
  );
  it.each(['logical', 'non-shelly', 'simulated', 'missing-address'])(
    'does not invent an HTTP probe for %s',
    async (mode) => {
      if (mode === 'logical') device.kind = 'logical';
      if (mode === 'non-shelly') device.adapter.driver = 'generic-mqtt';
      if (mode === 'simulated') device.adapter.protocol = 'simulated';
      if (mode === 'missing-address') delete device.metadata!.httpBaseUrl;
      await service.check(device.id);
      expect(probe).not.toHaveBeenCalled();
    },
  );
  it('uses documented default prefix only when the device reports a null prefix', async () => {
    probe.mockImplementation(async (_route, method) =>
      method === 'Shelly.GetDeviceInfo'
        ? { id: physicalId }
        : method === 'MQTT.GetConfig'
          ? {
              enable: true,
              enable_rpc: true,
              topic_prefix: null,
              rpc_ntf: false,
              status_ntf: false,
              server: 'mqtts://broker',
            }
          : {},
    );
    const r = await service.check(device.id);
    expect(r.checks.find((c) => c.id === 'topic')?.detail).toContain(
      `${physicalId}/rpc`,
    );
    expect(r.checks.find((c) => c.id === 'notifications')?.status).toBe(
      'warning',
    );
    expect(r.checks.find((c) => c.id === 'broker')?.detail).toContain('8883');
  });
  it('returns a limited report when no control route exists', async () => {
    device.control = { status: 'needs-setup', reason: '', binding: null };
    expect((await service.check(device.id)).code).toBe('control-disabled');
    expect(probe.mock.calls.map((c) => c[1])).toEqual([
      'Shelly.GetDeviceInfo',
      'Switch.GetStatus',
    ]);
  });
});
