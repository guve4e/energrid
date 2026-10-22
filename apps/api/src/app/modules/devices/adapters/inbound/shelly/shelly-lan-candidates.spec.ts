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
  it('merges the same MQTT and verified LAN switch identity into one pending HTTP review candidate', () => {
    const env = process.env;
    process.env = {
      PORTAL_APPROVED_DEVICES_JSON: '[]',
      PORTAL_DISCOVERED_DEVICES_JSON: '[]',
    };
    try {
      const registry = new DeviceRegistryService();
      const plusOne: NetworkDiscoveredDevice = {
        ...device,
        id: 'shellyplus1-8813bfcdc8bc',
        ipAddress: '192.168.1.220',
        model: 'SNSW-001X16EU',
        app: 'Plus1',
        macAddress: '88:13:bf:cd:c8:bc',
        components: [{ component: 'switch:0', channel: 0 }],
      };
      registry.registerDiscoveredShellyDevice(plusOne.id, 'switch:0', 0, 'shellyplus1-8813bfcdc8bc/rpc');
      const lanCandidate = shellyLanCandidates(plusOne)[0];
      expect(registry.registerDiscoveredDevice(lanCandidate)).toBe(true);

      const candidates = registry.getDevices().filter(item => item.id === lanCandidate.id);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        id: 'shellyplus1-8813bfcdc8bc:switch:0',
        trustStatus: 'discovered',
        adapter: { protocol: 'http', transport: 'http', driver: 'shelly-lan' },
        metadata: {
          physicalId: 'shellyplus1-8813bfcdc8bc', component: 'switch:0', channel: 0,
          mqttCommandTopic: 'shellyplus1-8813bfcdc8bc/rpc', ipAddress: '192.168.1.220',
        },
      });
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
  it('confirms advertised Gen2 switch components with their read-only status RPC', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: [
        { key: 'switch:0', status: { id: 0 } },
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, output: false }) });
    global.fetch = fetch;

    await expect(probeShellyComponents('192.168.1.220')).resolves.toEqual([
      { component: 'switch:0', channel: 0 },
    ]);
    expect(fetch).toHaveBeenNthCalledWith(1,
      'http://192.168.1.220/rpc/Shelly.GetComponents',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(2,
      'http://192.168.1.220/rpc/Switch.GetStatus?id=0',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });
  it('does not record a component when its status RPC reports a different id or no response', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: [
        { key: 'switch:0', status: { id: 0 } },
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1, output: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: [
        { key: 'switch:0', status: { id: 0 } },
      ] }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(probeShellyComponents('192.168.1.220')).resolves.toEqual([]);
    await expect(probeShellyComponents('192.168.1.220')).resolves.toEqual([]);
  });
  it('uses bounded read-only RPCs and accepts only confirmed relay and meter components', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ error: 'Method not found' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        'switch:0': {}, 'switch:1': {}, 'em1:0': {}, 'input:0': {},
        'switch:2': {}, 'switch:32': {}, 'switch:4': {}, 'switch:5': [],
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, output: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1, output: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, act_power: 100 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 3, output: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 4, output: 'on' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    global.fetch = fetch;
    expect(await probeShellyComponents(device.ipAddress)).toEqual(
      device.components,
    );
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(fetch).toHaveBeenCalledWith(
      'http://192.168.7.21/rpc/Shelly.GetComponents',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://192.168.7.21/rpc/Shelly.GetStatus',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://192.168.7.21/rpc/Switch.GetStatus?id=0',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
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
