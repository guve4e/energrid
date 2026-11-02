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
    expect(page.text()).toContain('Enrollment');
    expect(page.text()).toContain('Unknown');
    expect(page.text()).toContain('MQTT · devices/temp-kitchen/data');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    expect(page.text()).not.toContain('Associate a LAN device');
    expect(page.find('select').exists()).toBe(false);
    expect(page.text()).not.toContain('User confirmed');
  });

  it('distinguishes verified Shelly RPC identity from an unverified MAC association', async () => {
    fetchMock.mockResolvedValue(response({
      association: {
        ipAddress: '192.168.7.39', networkZoneId: 'eero-lan', networkZoneName: 'eero-lan',
        observedAt: '2026-10-29T05:23:04.000Z', evidenceSource: 'lan discovery protocol match',
        verificationStatus: 'protocol_observed', isCurrent: true, macAddress: 'ec:62:60:88:80:84',
      },
      history: [],
      physicalDevice: { physicalDeviceId: 'pi-id', assignments: [], components: [], endpoints: [] },
      rpcVerification: {
        status: 'verified', physicalId: 'shellypro2pm-ec6260888084', component: 'switch:0',
        endpoint: '192.168.7.39', networkScope: 'eero-lan:192.168.7.0/24', observerId: 'mac-eero-en0',
        identityVerifiedAt: '2026-10-29T05:23:00.000Z', componentVerifiedAt: '2026-10-29T05:23:01.000Z',
      },
      recovery: { status: 'not_recoverable', reason: 'Already associated.' },
    }));
    const page = mountPanel('shellypro2pm-ec6260888084:switch:0');
    await flushPromises();

    expect(page.text()).toContain('Shelly RPC identity and componentVerified');
    expect(page.text()).toContain('mac-eero-en0');
    expect(page.text()).toContain('MAC address last verified');
    expect(page.text()).toContain('No independent MAC verification recorded');
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

  it('does not expose recovery when the server says the device is linked or not recoverable', async () => {
    fetchMock.mockResolvedValue(response({ association: null, history: [],
      recovery: { status: 'not_recoverable', reason: 'The logical component is already linked.' } }));
    const page = mountPanel('shellyplus1-00c0de000001:switch:0');
    await flushPromises();
    expect(page.text()).toContain('Partial enrollment recovery unavailable');
    expect(page.text()).toContain('The logical component is already linked.');
    expect(page.text()).not.toContain('Complete identity association');
    expect(page.text()).not.toContain('Verify selected device');
  });

  it('completes the existing enrollment retry and confirms the authoritative inventory assignment', async () => {
    const physicalDeviceId = '3e709572-76c5-4d5f-8c89-ec23a8d7c55b';
    const physicalId = 'shellyplus1-00c0de000001';
    const deviceId = `${physicalId}:switch:0`;
    const base = { physicalDeviceId, physicalId, componentKey: 'switch:0' };
    const linked = { deviceId, physicalDeviceId, componentKey: 'switch:0' };
    fetchMock.mockImplementation((url: string, options) => {
      if (options?.method === 'POST') return Promise.resolve(response({ status: 'approved', enrollment: 'enrolled', device: { id: deviceId } }));
      return Promise.resolve(response({ association: null, history: [],
        physicalDevice: { physicalDeviceId, verificationStatus: 'protocol_observed',
          identity: { namespace: 'mac', value: '02:c0:de:00:00:01' },
          identities: [
            { namespace: 'mac', value: '02:c0:de:00:00:01' },
            { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
          ],
          components: [{ key: 'switch:0', capabilities: ['switch'] }], endpoints: [], assignments: [linked] },
        logicalAssignment: linked,
        recovery: { status: 'ready', reason: 'Fresh identity and component evidence is available.', ...base },
      }));
    });
    const page = mountPanel(deviceId);
    await flushPromises();
    await page.get('button').trigger('click');
    await flushPromises();
    const post = fetchMock.mock.calls.find(call => call[1]?.method === 'POST');
    expect(post?.[0]).toContain(`/portal/discovery/${encodeURIComponent(deviceId)}/approve`);
    expect(post?.[1].body).toBe('{}');
    expect(fetchMock.mock.calls.filter(call => !call[1]?.method)).toHaveLength(2);
    expect(page.text()).toContain(physicalDeviceId);
    expect(page.text()).toContain(`mqtt:shelly-protocol-id · ${physicalId}`);
    expect(page.text()).not.toContain('Complete identity association');
    expect(page.emitted('recovered')).toHaveLength(1);
  });

  it('runs selected-device verification when evidence is stale and only shows recovery after refreshed server eligibility', async () => {
    const physicalDeviceId = '3e709572-76c5-4d5f-8c89-ec23a8d7c55b';
    const physicalId = 'shellyplus1-00c0de000001';
    const deviceId = `${physicalId}:switch:0`;
    let gets = 0;
    fetchMock.mockImplementation((url: string, options) => {
      if (String(url).includes('/verify-shelly')) return Promise.resolve(response({ status: 'verified', physicalId, componentKeys: ['switch:0'] }));
      if (options?.method === 'POST') return Promise.resolve(response({ status: 'approved', enrollment: 'enrolled', device: { id: deviceId } }));
      gets += 1;
      return Promise.resolve(response({ association: null, history: [], recovery: gets === 1
        ? { status: 'verification_required', reason: 'Fresh selected-device RPC verification is required.', physicalDeviceId, physicalId, componentKey: 'switch:0' }
        : { status: 'ready', reason: 'Fresh verification is available.', physicalDeviceId, physicalId, componentKey: 'switch:0' } }));
    });
    const page = mountPanel(deviceId);
    await flushPromises();
    expect(page.text()).toContain('Verify selected device');
    await page.get('button').trigger('click');
    await flushPromises();
    const verify = fetchMock.mock.calls.find(call => String(call[0]).includes('/verify-shelly'));
    expect(verify?.[0]).toContain(`/portal/discovery/${encodeURIComponent(deviceId)}/verify-shelly`);
    expect(page.text()).toContain('Complete identity association');
    expect(page.emitted('recovered')).toBeUndefined();
  });

  it('keeps recovery unavailable when selected-device verification fails', async () => {
    fetchMock.mockImplementation((url: string) => String(url).includes('/verify-shelly')
      ? Promise.resolve({ ok: false, json: async () => ({ message: 'RPC identity mismatch' }) })
      : Promise.resolve(response({ association: null, history: [], recovery: { status: 'verification_required', reason: 'Fresh RPC verification is required.', physicalDeviceId: 'p', physicalId: 'shellyplus1-00c0de000001', componentKey: 'switch:0' } })));
    const page = mountPanel('shellyplus1-00c0de000001:switch:0');
    await flushPromises();
    await page.get('button').trigger('click');
    await flushPromises();
    expect(page.text()).toContain('RPC identity mismatch');
    expect(page.text()).not.toContain('Complete identity association');
    expect(page.emitted('recovered')).toBeUndefined();
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
      identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellypro3em-001122334455' },
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
      expect(page.text()).toContain('Physical inventory IDshelly-proem-001');
      expect(page.text()).toContain('mqtt:shelly-protocol-id · shellypro3em-001122334455');
      expect(page.text()).toContain('shelly-proem');
      expect(page.text()).toContain('Home LAN');
      expect(page.text()).toContain('gateway-home');
      expect(page.text()).toContain('MQTT · devices/temp-kitchen/data');
      expect(page.text()).toContain('Stored endpoints: MQTT shelly/boiler@oven/status · HTTP http://192.168.1.204/rpc');
      expect(page.text()).toContain('Evidence sourceLAN Discovery');
      expect(page.text()).toContain('Last known IP address');
      expect(page.text()).toContain('Observed MAC address');
    }
    expect(boiler.text()).toContain('Logical device ID');
    expect(boiler.text()).toContain('boiler-power');
    expect(boiler.text()).toContain('em1:0');
    expect(oven.text()).toContain('Logical device ID');
    expect(oven.text()).toContain('oven-power');
    expect(oven.text()).toContain('em1:1');
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

  it('labels the MAC as verified only when verified evidence has a timestamp', async () => {
    fetchMock.mockResolvedValue(response({
      association: {
        ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0a',
        networkZoneId: 'gateway-home:iot', observedAt: '2026-10-19T12:10:00.000Z',
        hardwareVerifiedAt: '2026-10-19T12:11:00.000Z', evidenceSource: 'lan_discovery_protocol_match',
        verificationStatus: 'hardware_verified', isCurrent: true,
      },
      history: [], physicalDevice: null,
    }));
    const page = mountPanel('device-a');
    await flushPromises();
    expect(page.text()).toContain('Current IP address');
    expect(page.text()).toContain('Verified MAC address');
    expect(page.text()).toContain('Hardware verified');
    expect(page.text()).toContain(new Date('2026-10-19T12:11:00.000Z').toLocaleString());
  });

  it('distinguishes a claimed protocol identity from missing site-local RPC evidence', async () => {
    fetchMock.mockResolvedValue(response({
      association: { ipAddress: '192.168.7.39', networkZoneId: 'eero-lan', networkZoneName: 'Eero LAN', observedAt: '2026-10-29T05:23:04.000Z', evidenceSource: 'lan_discovery_protocol_match', verificationStatus: 'protocol_observed', isCurrent: true },
      history: [],
      physicalDevice: { physicalDeviceId: 'home-pro2', identities: [{ namespace: 'mqtt:shelly-protocol-id', value: 'shellypro2pm-ec6260888084' }], components: [{ key: 'switch:0', capabilities: ['switch'] }, { key: 'switch:1', capabilities: ['switch'] }], endpoints: [], assignments: [{ deviceId: 'shellypro2pm-ec6260888084:switch:1', physicalDeviceId: 'home-pro2', componentKey: 'switch:1' }] },
      logicalAssignment: { deviceId: 'shellypro2pm-ec6260888084:switch:1', physicalDeviceId: 'home-pro2', componentKey: 'switch:1' },
      rpcVerification: { status: 'not_verified' },
      recovery: { status: 'not_recoverable', reason: 'This is not an approved, site-owned discovery enrollment.' },
    }));
    const page = mountPanel('shellypro2pm-ec6260888084:switch:1');
    await flushPromises();
    expect(page.text()).toContain('shellypro2pm-ec6260888084');
    expect(page.text()).toContain('Not verified');
    expect(page.text()).toContain('not fresh, site-local RPC evidence for this component');
    expect(page.text()).toContain('Partial enrollment recovery unavailable');
    expect(page.text()).not.toContain('Identity recovery unavailable');
  });
});
