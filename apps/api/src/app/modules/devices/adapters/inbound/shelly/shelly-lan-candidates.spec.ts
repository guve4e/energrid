import { shellyLanCandidates } from './shelly-lan-candidates';
import { probeShellyComponents } from '../../../device-lan-discovery.service';
import { DeviceRegistryService } from '../../../device-registry.service';
import type { NetworkDiscoveredDevice } from '../../../device-registry.types';

const device: NetworkDiscoveredDevice = {
  id: 'shellyplus2pm-aabbccddeeff',
  ipAddress: '192.168.7.21',
  vendor: 'Shelly',
  generation: 2,
  status: 'online',
  protocol: 'http',
  networkZoneId: 'lan',
  networkZoneName: 'LAN',
  confidence: 0.9,
  discoveredAt: '2026-10-13T08:00:00Z',
  reason: 'Shelly HTTP response',
  components: [
    { component: 'switch:0', channel: 0 },
    { component: 'switch:1', channel: 1 },
    { component: 'em1:0', channel: 0 },
  ],
};
describe('Shelly LAN onboarding candidates', () => {
  it('keeps physical identity and each channel explicit without granting control', () => {
    const candidates = shellyLanCandidates(device);
    expect(candidates).toHaveLength(3);
    expect(candidates[1]).toMatchObject({
      id: `${device.id}:switch:1`,
      protocol: 'http',
      capabilities: ['switch'],
      target: 'http://192.168.7.21/rpc/Switch.GetStatus?id=1',
      metadata: {
        physicalId: device.id,
        component: 'switch:1',
        channel: 1,
        httpBaseUrl: 'http://192.168.7.21',
      },
    });
    expect(candidates[2].capabilities).toEqual(['power']);
    expect(candidates.every((c) => !('control' in c))).toBe(true);
  });
  it.each([
    { vendor: 'Other' },
    { generation: 1 },
    { generation: undefined },
    { status: 'offline' as const },
    { id: 'not-a-shelly' },
    { ipAddress: '169.254.169.254' },
    { ipAddress: '8.8.8.8' },
    { components: undefined },
  ])('does not invent supported channels for %o', (extra) => {
    expect(shellyLanCandidates({ ...device, ...extra })).toEqual([]);
  });
  it('deduplicates channels and rejects invalid component/channel assignments', () => {
    expect(
      shellyLanCandidates({
        ...device,
        components: [
          { component: 'switch:1', channel: 1 },
          { component: 'switch:1', channel: 1 },
          { component: 'switch:0', channel: 1 },
          { component: 'switch:32', channel: 32 },
          { component: 'input:0', channel: 0 },
        ],
      }),
    ).toHaveLength(1);
  });
  it('retains observed MQTT destinations when HTTP discovery enriches a channel', () => {
    const env = process.env;
    process.env = {
      PORTAL_APPROVED_DEVICES_JSON: '[]',
      PORTAL_DISCOVERED_DEVICES_JSON: '[]',
    };
    try {
      const registry = new DeviceRegistryService();
      registry.registerDiscoveredShellyDevice(
        device.id,
        'switch:1',
        1,
        'custom/kitchen/rpc',
      );
      registry.registerDiscoveredDevice(shellyLanCandidates(device)[1]);
      const candidate = registry
        .getDevices()
        .find((d) => d.id === `${device.id}:switch:1`)!;
      expect(candidate.trustStatus).toBe('discovered');
      expect(candidate.metadata).toMatchObject({
        mqttCommandTopic: 'custom/kitchen/rpc',
        httpBaseUrl: 'http://192.168.7.21',
      });
      const approved = registry.approveDiscoveredDevice(candidate.id)!;
      expect(approved.control?.status).toBe('needs-setup');
      registry.registerDiscoveredDevice({
        ...shellyLanCandidates(device)[1],
        target: 'http://192.168.7.99',
      });
      expect(
        registry.getDevices().find((d) => d.id === candidate.id)?.adapter
          .target,
      ).toBe(approved.adapter.target);
    } finally {
      process.env = env;
    }
  });
});

describe('read-only Shelly component probing', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });
  it('only reads GetStatus and accepts valid relays and meters', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        'switch:0': { id: 0, output: false },
        'switch:1': { id: 1, output: true },
        'em1:0': { id: 0, act_power: 100 },
        'input:0': { id: 0, state: false },
        'switch:2': { id: 3, output: true },
        'switch:32': { id: 32, output: true },
        'switch:4': { id: 4, output: 'on' },
        'switch:5': [],
      }),
    });
    global.fetch = fetch;
    expect(await probeShellyComponents(device.ipAddress)).toEqual(
      device.components,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://192.168.7.21/rpc/Shelly.GetStatus',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
  it.each([null, [], 42, { error: 'Authentication required' }])(
    'handles invalid responses %o without inventing channels',
    async (body) => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, json: async () => body });
      expect(await probeShellyComponents(device.ipAddress)).toEqual([]);
    },
  );
  it('handles authentication failures and network errors', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockRejectedValueOnce(new Error('Timeout'));
    expect(await probeShellyComponents(device.ipAddress)).toEqual([]);
    expect(await probeShellyComponents(device.ipAddress)).toEqual([]);
  });
  it('rejects public, loopback and metadata addresses before network I/O', async () => {
    const fetch = jest.fn();
    global.fetch = fetch;
    for (const ip of ['8.8.8.8', '127.0.0.1', '169.254.169.254', 'not-an-ip'])
      expect(await probeShellyComponents(ip)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
