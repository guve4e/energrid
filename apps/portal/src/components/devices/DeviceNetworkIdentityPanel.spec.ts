import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceNetworkIdentityPanel from './DeviceNetworkIdentityPanel.vue';

const discovered = {
  identity: 'endpoint:iot:192.168.1.133',
  device: {
    ipAddress: '192.168.1.133',
    hostname: 'ESP-3254B7',
    networkZoneId: 'iot',
    networkZoneName: 'IoT network',
    discoveredAt: '2026-10-19T12:00:00.000Z',
  },
};
let fetchMock: ReturnType<typeof vi.fn>;

function response(payload: unknown) {
  return { ok: true, json: async () => structuredClone(payload) };
}

function mountPanel(deviceId = 'temp-kitchen', enrollmentStatus: 'enrolled' | 'retired' = 'enrolled') {
  return mount(DeviceNetworkIdentityPanel, {
    props: {
      deviceId,
      deviceName: deviceId,
      enrollmentStatus,
      protocol: 'mqtt',
      protocolEndpoint: 'devices/temp-kitchen/data',
      apiBase: '/api',
      accessToken: 'test-token',
    },
  });
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(response({ association: null, history: [] }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('DeviceNetworkIdentityPanel', () => {
  it('shows explicit unknown identity and does not associate a LAN record automatically', async () => {
    const page = mountPanel();
    await flushPromises();
    expect(page.text()).toContain('Enrollment status');
    expect(page.text()).toContain('Not identified');
    expect(page.text()).toContain('MQTT · devices/temp-kitchen/data');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    expect(page.text()).not.toContain('Associate a LAN device');
    expect(page.find('select').exists()).toBe(false);
    expect(page.text()).not.toContain('User confirmed');
  });

  it('retires an enrollment only after explicit confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    fetchMock.mockImplementation((_url, options) => {
      if (options?.method === 'POST') {
        return Promise.resolve(response({ status: 'retired' }));
      }
      return Promise.resolve(response({ association: null, history: [] }));
    });
    const page = mountPanel();
    await flushPromises();
    await page.get('button').trigger('click');
    await flushPromises();

    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(post).toBeDefined();
    expect(post![0]).toContain('/devices/temp-kitchen/retire');
    expect(page.emitted('retired')).toHaveLength(1);
    expect(window.confirm).toHaveBeenCalled();
  });

  it('requires a separate explicit action to reenroll a retired device', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const page = mountPanel('temp-kitchen', 'retired');
    await flushPromises();
    await page.get('button').trigger('click');
    await flushPromises();
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(post?.[0]).toContain('/devices/temp-kitchen/reenroll');
    expect(page.emitted('reenrolled')).toHaveLength(1);
  });

  it('assigns a protocol-identified component and an explicit logical role', async () => {
    const inventory = {
      physicalDevice: {
        physicalDeviceId: 'physical-proem',
        verificationStatus: 'protocol_observed',
        identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellypro3em-001122334455' },
        components: [{ key: 'em1:0', capabilities: ['power'] }],
        endpoints: [],
        assignments: [{ deviceId: 'temp-kitchen', componentKey: 'em1:0' }],
      },
      logicalAssignment: { deviceId: 'temp-kitchen', physicalDeviceId: 'physical-proem', componentKey: 'em1:0' },
    };
    fetchMock.mockImplementation((_url, options) => {
      if (options?.method === 'POST') return Promise.resolve(response({ physicalDevice: inventory.physicalDevice }));
      return Promise.resolve(response({ association: null, history: [], ...inventory }));
    });
    const page = mountPanel();
    await flushPromises();
    await page.get('button.ghost').trigger('click');
    await page.get('input').setValue('Boiler');
    await page.get('button.primary').trigger('click');
    await flushPromises();

    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(JSON.parse(post![1].body)).toEqual({
      physicalDeviceId: 'physical-proem', componentKey: 'em1:0', role: 'Boiler',
    });
  });

  it('shows the same physical IP and MAC for two logical devices with distinct components', async () => {
    const physicalDevice = {
      physicalDeviceId: 'shelly-proem-001',
      verificationStatus: 'user_confirmed',
      components: [
        { key: 'em1:0', capabilities: ['power'] },
        { key: 'em1:1', capabilities: ['power'] },
      ],
      endpoints: [
        { protocol: 'mqtt', kind: 'topic', address: 'shelly/boiler@oven/status' },
        { protocol: 'http', kind: 'rpc', address: 'http://192.168.1.204/rpc' },
      ],
      networkObservations: [],
      assignments: [
        { deviceId: 'boiler-power', componentKey: 'em1:0', role: 'Boiler' },
        { deviceId: 'oven-power', componentKey: 'em1:1', role: 'Oven' },
      ],
    };
    const association = {
      ipAddress: '192.168.1.204',
      macAddress: '00:11:22:33:44:55',
      hostname: 'shelly-proem',
      gatewayId: 'gateway-home',
      networkZoneName: 'Home LAN',
      observedAt: '2026-10-19T12:00:00.000Z',
      evidenceSource: 'lan_discovery',
      verificationStatus: 'user_confirmed',
    };
    fetchMock.mockImplementation((url: string) => {
      const deviceId = String(url).includes('boiler-power') ? 'boiler-power' : 'oven-power';
      const logicalAssignment = physicalDevice.assignments.find(item => item.deviceId === deviceId);
      return Promise.resolve(response({
        logicalDeviceId: deviceId,
        logicalAssignment,
        physicalDevice,
        association,
        history: [association],
        records: [],
      }));
    });

    const boiler = mountPanel('boiler-power');
    const oven = mountPanel('oven-power');
    await flushPromises();

    for (const page of [boiler, oven]) {
      expect(page.text()).toContain('192.168.1.204');
      expect(page.text()).toContain('00:11:22:33:44:55');
      expect(page.text()).toContain('Physical device · shelly-proem-001');
      expect(page.text()).toContain('shelly-proem');
      expect(page.text()).toContain('gateway-home · Home LAN');
      expect(page.text()).toContain('MQTT shelly/boiler@oven/status');
      expect(page.text()).toContain('HTTP http://192.168.1.204/rpc');
      expect(page.text()).toContain('Evidence sourceLAN Discovery');
    }
    expect(boiler.text()).toContain('Logical device ID');
    expect(boiler.text()).toContain('boiler-power');
    expect(boiler.text()).toContain('Component ID · em1:0');
    expect(oven.text()).toContain('Logical device ID');
    expect(oven.text()).toContain('oven-power');
    expect(oven.text()).toContain('Component ID · em1:1');
  });

  it('labels a per-device current observation as last observed, not live IP ownership', async () => {
    fetchMock.mockResolvedValue(response({
      association: {
        ipAddress: '192.168.1.133',
        macAddress: '02:00:00:00:00:0a',
        networkZoneId: 'gateway-home:iot',
        networkZoneName: 'gateway-home:iot',
        observedAt: '2026-10-19T12:10:00.000Z',
        evidenceSource: 'lan_discovery_protocol_match',
        verificationStatus: 'user_confirmed',
        isCurrent: true,
      },
      history: [],
      physicalDevice: null,
    }));

    const page = mountPanel('device-a');
    await flushPromises();

    expect(page.text()).toContain('Last observed');
    expect(page.text()).not.toContain('Live-confirmed');
    expect(page.text()).not.toContain('Current IP owner');
  });
});
