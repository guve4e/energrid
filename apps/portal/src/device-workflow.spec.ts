import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from './App.vue';

const id = 'shellyplus1-aabbccddeeff:switch:0';
const relay = {
  id,
  displayName: 'Kitchen Shelly',
  kind: 'physical',
  trustStatus: 'discovered',
  tenantId: 'tenant-demo',
  siteId: 'site-home',
  siteName: 'Home',
  zoneId: 'kitchen',
  zoneName: 'Kitchen',
  capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
  adapter: {
    protocol: 'http',
    driver: 'shelly-lan',
    configured: false,
    target: 'http://192.168.7.21/rpc/Switch.GetStatus?id=0',
  },
  metadata: {
    physicalId: 'shellyplus1-aabbccddeeff',
    component: 'switch:0',
    channel: 0,
    httpBaseUrl: 'http://192.168.7.21',
  },
  state: { status: 'unknown', values: {}, source: 'http', observedAt: null },
  control: {
    status: 'unapproved',
    binding: null,
    reason: 'Device is not approved.',
  },
  responseProfile: {},
  policy: {},
};
const network = {
  id: 'shellyplus1-aabbccddeeff',
  ipAddress: '192.168.7.21',
  vendor: 'Shelly',
  protocol: 'http',
  status: 'online',
  generation: 2,
  components: [{ component: 'switch:0', channel: 0 }],
  networkZoneId: 'lan',
  networkZoneName: 'LAN',
  settingsUrl: 'http://192.168.7.21',
  reason: 'Shelly HTTP response',
};
let page: VueWrapper | undefined;
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  localStorage.setItem('energrid.portal.token', 'unit-only');
  localStorage.setItem(
    'energrid.portal.user',
    JSON.stringify({ id: 'admin', name: 'Admin', email: 'unit@test' }),
  );
});
afterEach(() => {
  page?.unmount();
  page = undefined;
  localStorage.clear();
  history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function data(devices: unknown[] = []) {
  return {
    tenant: { id: 'tenant-demo', name: 'Demo' },
    site: { id: 'site-home', name: 'Home', mode: 'home' },
    devices,
    systems: [],
    zones: [],
    gateways: [],
    sites: [],
    networkDevices: [] as unknown[],
    networkZones: [] as Array<{ id: string; name: string; cidr: string; seedIps: string[] }>,
    executionTraces: [],
  };
}
function scanResult(devices: any[], zones: ReturnType<typeof data>['networkZones']) {
  const now = '2026-10-21T10:00:00.000Z';
  const selectedZones = zones || [];
  return {
    zones: selectedZones,
    devices,
    snapshot: {
      schemaVersion: 1, scanId: `scan-${devices.length}`, startedAt: now, completedAt: now,
      collector: { id: 'test-host/en0', host: 'test-host', interfaces: ['en0'] },
      scopes: selectedZones.map(zone => ({ id: zone.id, name: zone.name, cidr: zone.cidr, complete: true, gatewayIpsObserved: [] })),
      methods: ['neighbor_table'], successes: devices.length, failures: [], limitations: [], rawEvidence: [], rawEvidenceOmitted: 0,
      endpoints: devices, topology: { relationships: [] },
    },
    comparison: null,
  };
}
function enrollmentsFor(state: ReturnType<typeof data>) {
  return state.devices.flatMap((value: any) => value.trustStatus === 'approved' ? [{
    tenantId: value.tenantId, siteId: value.siteId, deviceId: value.id, status: 'enrolled',
  }] : []);
}
function button(text: string) {
  return page!.findAll('button').find((b) => b.text() === text)!;
}
async function render(path: string, fetch: unknown) {
  history.replaceState({}, '', path);
  const mockedFetch = fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<any>;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/portal/network/snapshots')) return { ok: true, json: async () => ({ snapshots: [] }) };
    return mockedFetch(input, init);
  });
  page = mount(App, { global: { stubs: { ExecutionSimulator: true } } });
  await flushPromises();
}
describe('device onboarding page workflow with mocked services', () => {
  it('loads network snapshots and configured scopes after signing into Network Intelligence', async () => {
    localStorage.clear();
    const state = { ...data(), networkZones: [{ id: 'lan', name: 'LAN', cidr: '192.168.7.0/24', seedIps: [] }] };
    const fetch = vi.fn(async (url: string) => {
      if (url === '/auth/login') return { ok: true, json: async () => ({ accessToken: 'network-token', user: { id: 'admin', name: 'Admin', email: 'unit@test' } }) };
      if (url === '/portal/state') return { ok: true, json: async () => structuredClone(state) };
      if (url === '/portal/devices/enrollments') return { ok: true, json: async () => ({ enrollments: [] }) };
      if (url === '/portal/network/capabilities') return { ok: true, json: async () => ({ nmap: { available: true, enabled: true }, observer: null }) };
      return { ok: true, json: async () => ({}) };
    });
    await render('/network-intelligence/', fetch);
    await page!.get('#email').setValue('unit@test');
    await page!.get('#password').setValue('test-password');
    await button('Sign in').trigger('click');
    await flushPromises();

    expect(page!.find('select[aria-label="Select network scope"]').element).toBeTruthy();
    expect(page!.text()).toContain('LAN · 192.168.7.0/24');
    expect(page!.text()).not.toContain('Network snapshots unavailable');
    expect(fetch.mock.calls.some(([url]) => url === '/portal/network/capabilities')).toBe(true);
  });

  it('shows backend network identity evidence and an explicit missing-evidence reason in Pending Enrollment', async () => {
    const physicalId = 'shellyproem50-8c4f00dbd258';
    const shellyCandidate = {
      ...relay,
      id: `${physicalId}:em1:0`,
      displayName: `${physicalId} em1:0`,
      adapter: { ...relay.adapter, protocol: 'mqtt', target: `${physicalId}/rpc` },
      metadata: { physicalId, component: 'em1:0', channel: 0 },
      discovery: { source: 'mqtt', confidence: 0.8, reason: 'Shelly MQTT telemetry' },
    };
    const secondShellyCandidate = {
      ...shellyCandidate,
      id: `${physicalId}:em1:1`,
      displayName: `${physicalId} em1:1`,
      metadata: { physicalId, component: 'em1:1', channel: 1 },
    };
    const espCandidate = {
      ...relay,
      id: 'temp-kitchen',
      displayName: 'Kitchen temperature sensor',
      adapter: { ...relay.adapter, protocol: 'mqtt', target: 'devices/temp-kitchen/status' },
      metadata: { mqttEvidenceCandidate: true },
      discovery: { source: 'mqtt', confidence: 0.55, reason: 'Captured MQTT status evidence' },
    };
    const state = {
      ...data([shellyCandidate, secondShellyCandidate, espCandidate]),
      pendingDeviceIdentities: {
        [shellyCandidate.id]: {
          logicalCandidateId: shellyCandidate.id, physicalDeviceId: 'inventory-physical-1',
          physicalHardwareId: physicalId, componentId: 'em1:0', ipAddress: '192.168.1.204',
          macAddress: '8c:4f:00:db:d2:58', hostname: 'shelly-proem', gatewayId: 'gateway-home',
          networkId: 'iot', discoverySource: 'mqtt', protocol: 'mqtt', endpoint: `${physicalId}/rpc`,
          evidenceSource: 'mqtt_protocol_message + lan_http_rpc', lastObservedAt: '2026-10-20T09:00:00.000Z',
          verificationStatus: 'protocol_observed', status: 'correlated',
          reason: 'Exact Shelly protocol hardware ID and component match current LAN HTTP/RPC evidence. This is protocol correlation, not independent hardware authentication.',
        },
        [secondShellyCandidate.id]: {
          logicalCandidateId: secondShellyCandidate.id, physicalDeviceId: 'inventory-physical-1',
          physicalHardwareId: physicalId, componentId: 'em1:1', ipAddress: '192.168.1.204',
          macAddress: '8c:4f:00:db:d2:58', hostname: 'shelly-proem', gatewayId: 'gateway-home',
          networkId: 'iot', discoverySource: 'mqtt', protocol: 'mqtt', endpoint: `${physicalId}/rpc`,
          evidenceSource: 'mqtt_protocol_message + lan_http_rpc', lastObservedAt: '2026-10-20T09:00:00.000Z',
          lastObservedIpAddress: '192.168.1.204', lastObservedMacAddress: '8c:4f:00:db:d2:58',
          lastObservedHostname: 'shelly-proem', lastObservedGatewayId: 'gateway-home',
          lastObservedNetworkId: 'iot', verificationStatus: 'protocol_observed', status: 'correlated',
          reason: 'Exact Shelly protocol hardware ID and component match current LAN HTTP/RPC evidence. This is protocol correlation, not independent hardware authentication.',
        },
        [espCandidate.id]: {
          logicalCandidateId: espCandidate.id, physicalDeviceId: null, physicalHardwareId: null,
          componentId: null, ipAddress: null, macAddress: null, hostname: null, gatewayId: null,
          networkId: null, discoverySource: 'mqtt', protocol: 'mqtt', endpoint: 'devices/temp-kitchen/status',
          evidenceSource: 'MQTT status/evidence', lastObservedAt: '2026-10-20T09:00:00.000Z',
          verificationStatus: 'not_identified', status: 'not_identified',
          reason: 'MQTT evidence identifies a logical source but contains no stable hardware identifier.',
        },
      },
    };
    const fetch = vi.fn(async (url: string) => {
      if (url === '/portal/network/scan') return { ok: true, json: async () => ({ devices: [], zones: [] }) };
      if (url === '/portal/network/memory') return { ok: true, json: async () => ({ devices: [], summary: { known: 0, observedInLatestScan: 0, notObservedInLatestScan: 0, lastScanId: null } }) };
      if (url.includes('/devices/enrollments')) return { ok: true, json: async () => ({ enrollments: [] }) };
      return { ok: true, json: async () => url === '/portal/state' ? structuredClone(state) : { runs: [] } };
    });

    await render('/discovery/', fetch);

    expect(page!.text()).toContain('Recently confirmed');
    expect(page!.text()).toContain('192.168.1.204');
    expect(page!.text()).toContain('8c:4f:00:db:d2:58');
    expect(page!.text()).toContain('em1:0');
    expect(page!.text()).toContain('Kitchen temperature sensor');
    expect(page!.text()).toContain('MQTT source — network address not established');
    const shellyCard = page!.findAll('.pending-device-card').find(card => card.text().includes(physicalId))!;
    await shellyCard.find('.pending-review-button').trigger('click');
    await flushPromises();
    expect(shellyCard.text()).toContain('not independent hardware authentication');
    const channelRows = shellyCard.findAll('.pending-channel-detail');
    expect(channelRows).toHaveLength(2);
    await channelRows[1].findAll('button').find(candidateButton => candidateButton.text() === 'Approve')!.trigger('click');
    await flushPromises();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/portal/discovery/') && String(url).includes('%3Aem1%3A1/approve'))).toBe(true);
  });

  it('shows persisted LAN identity as last observed and avoids an automatic scan when history exists', async () => {
    const physicalId = 'shellyproem50-8c4f00dbd258';
    const shellyCandidate = {
      ...relay,
      id: `${physicalId}:em1:1`,
      displayName: `${physicalId} em1:1`,
      adapter: { ...relay.adapter, protocol: 'mqtt', target: `${physicalId}/rpc` },
      metadata: { physicalId, component: 'em1:1', channel: 1 },
      discovery: { source: 'mqtt', confidence: 0.8, reason: 'Shelly MQTT telemetry' },
    };
    const state = {
      ...data([shellyCandidate]),
      pendingDeviceIdentities: {
        [shellyCandidate.id]: {
          logicalCandidateId: shellyCandidate.id,
          physicalDeviceId: 'inventory-physical-1', physicalHardwareId: physicalId,
          componentId: 'em1:1', ipAddress: null, macAddress: null, hostname: null,
          gatewayId: null, networkId: null, discoverySource: 'mqtt', protocol: 'mqtt',
          endpoint: `${physicalId}/rpc`, evidenceSource: 'mqtt_protocol_message + persisted_lan_discovery_memory',
          lastObservedAt: '2026-10-20T09:00:00.000Z',
          lastObservedIpAddress: '192.168.1.204', lastObservedMacAddress: '8c:4f:00:db:d2:58',
          lastObservedHostname: 'shelly-proem', lastObservedGatewayId: 'gateway-home',
          lastObservedNetworkId: 'IoT', verificationStatus: 'protocol_observed',
          status: 'protocol_observed',
          reason: 'Exact Shelly protocol hardware ID and component match persisted LAN HTTP/RPC evidence. These are historical last-observed network details; run a new LAN scan to confirm the current address.',
        },
      },
    };
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/devices/enrollments')) return { ok: true, json: async () => ({ enrollments: [] }) };
      if (url === '/portal/network/memory') return {
        ok: true,
        json: async () => ({ devices: [{ device: network }], summary: { known: 1, observedInLatestScan: 0, notObservedInLatestScan: 1, lastScanId: '2026-10-20T09:30:00.000Z' } }),
      };
      return { ok: true, json: async () => url === '/portal/state' ? structuredClone(state) : { runs: [] } };
    });

    await render('/discovery/', fetch);

    const card = page!.find('.pending-device-card');
    expect(card.text()).toContain('Last observed');
    expect(card.text()).toContain('192.168.1.204');
    expect(card.text()).toContain('Historical · not recently confirmed');
    await card.find('.pending-review-button').trigger('click');
    await flushPromises();
    expect(card.text()).toContain('historical last-observed network details');
    expect(fetch.mock.calls.filter(([url]) => url === '/portal/network/scan')).toHaveLength(0);
  });

  it('shows an unlinked LAN endpoint IP without attaching it to the MQTT kitchen candidate', async () => {
    const kitchen = {
      ...relay,
      id: 'temp-kitchen', displayName: 'Kitchen temperature sensor',
      adapter: { ...relay.adapter, protocol: 'mqtt', target: 'devices/temp-kitchen/data' },
      metadata: { mqttEvidenceCandidate: true },
      capabilities: [{ kind: 'temperature', actions: ['read'] }, { kind: 'humidity', actions: ['read'] }],
      discovery: { source: 'mqtt', confidence: 0.55, reason: 'Captured MQTT status evidence' },
    };
    const lanEndpoint = {
      ...network, id: 'ESP-3254B7', ipAddress: '192.168.1.133', hostname: 'esp-3254b7',
      macAddress: '3c:71:bf:32:54:b7', vendor: undefined, model: undefined,
      networkZoneId: 'upstream-lan', networkZoneName: 'Upstream LAN', reason: 'ICMP response; HTTP 404',
    };
    const state = {
      ...data([kitchen]), networkDevices: [lanEndpoint],
      networkZones: [{ id: 'upstream-lan', name: 'Upstream LAN', cidr: '192.168.1.0/24', seedIps: [] }],
    };
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/devices/enrollments')) return { ok: true, json: async () => ({ enrollments: [] }) };
      if (url === '/portal/network/memory') return { ok: true, json: async () => ({ devices: [], summary: { known: 0, observedInLatestScan: 0, notObservedInLatestScan: 0, lastScanId: null } }) };
      return { ok: true, json: async () => url === '/portal/state' ? structuredClone(state) : { runs: [] } };
    });

    await render('/discovery/', fetch);

    expect(page!.find('.network-discovery-card').text()).toContain('192.168.1.133');
    expect(page!.find('.network-discovery-card').text()).toContain('Upstream LAN');
    const pending = page!.find('.pending-device-card');
    expect(pending.text()).toContain('MQTT source — network address not established');
    expect(pending.text()).not.toContain('192.168.1.133');
  });

  it('keeps search and combined inventory filters interactive without reloading', async () => {
    const kitchen = { ...relay, trustStatus: 'approved', control: { status: 'needs-setup', binding: null, reason: '' } };
    const meter = { ...kitchen, id: 'meter', displayName: 'Utility meter', zoneId: 'utility', zoneName: 'Utility', capabilities: [{ kind: 'power', actions: ['read'] }], control: { status: 'read-only', binding: null, reason: '' } };
    const example = { ...kitchen, id: 'example', displayName: 'Example relay', metadata: { simulated: true } };
    const pending = { ...relay, id: 'pending', displayName: 'Pending relay' };
    const state = data([kitchen, meter, example, pending]);
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/portal/state') ? structuredClone(state) : url.includes('/devices/enrollments') ? { enrollments: enrollmentsFor(state) } : { runs: [] } }));
    await render('/devices/', fetch);
    const initialRequests = fetch.mock.calls.length;
    const search = page!.get('[aria-label="Search devices"]');
    const count = () => page!.get('.inventory-filter-summary [role="status"]').text();
    const table = page!.get('.device-table-wrap').element;
    table.scrollTop = 250;
    table.scrollLeft = 90;
    await search.setValue('Kitchen');
    expect(count()).toBe('1 shown');
    expect(table.scrollTop).toBe(0);
    expect(table.scrollLeft).toBe(0);
    expect(page!.get('tbody').text()).toContain('Kitchen Shelly');
    await search.setValue('missing-device');
    expect(count()).toBe('0 shown');
    expect(page!.text()).toContain('No devices match this filter');
    await button('Clear filters').trigger('click');
    expect(count()).toBe('2 shown');
    await page!.get('[aria-label="Filter by capability"]').setValue('power');
    expect(count()).toBe('1 shown');
    expect(page!.get('tbody').text()).toContain('Utility meter');
    await page!.get('[aria-label="Filter by zone"]').setValue('kitchen');
    expect(count()).toBe('0 shown');
    await button('Clear filters').trigger('click');
    await page!.get('[aria-label="Filter by status"]').setValue('needs_setup');
    expect(count()).toBe('1 shown');
    await button('Clear filters').trigger('click');
    expect(count()).toBe('2 shown');
    expect(page!.get('tbody').text()).not.toContain('Pending relay');
    await page!.get('[aria-label="Filter by source"]').setValue('examples');
    expect(count()).toBe('1 shown');
    expect(page!.get('tbody').text()).toContain('Example relay');
    await button('Clear filters').trigger('click');
    expect(count()).toBe('2 shown');
    expect(button('Clear filters').attributes('disabled')).toBeDefined();
    expect(fetch.mock.calls.length).toBe(initialRequests);
  });
  it('keeps search and an edited setup draft when state is refreshed', async () => {
    const approved = { ...relay, trustStatus: 'approved', control: { status: 'needs-setup', binding: null, reason: '' } };
    const state = data([approved]);
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/portal/state') ? structuredClone(state) : url.includes('/devices/enrollments') ? { enrollments: enrollmentsFor(state) } : { runs: [] } }));
    await render('/devices/', fetch);
    await page!.get('[aria-label="Search devices"]').setValue('Kitchen');
    await button('Kitchen Shelly').trigger('click');
    const setup = page!.get('.control-setup');
    await setup.get('select').setValue('http');
    await setup.get('input[type="url"]').setValue('http://192.168.7.99');
    await button('Refresh').trigger('click');
    await flushPromises();
    expect((page!.get('[aria-label="Search devices"]').element as HTMLInputElement).value).toBe('Kitchen');
    expect(setup.get('select').element.value).toBe('http');
    expect((setup.get('input[type="url"]').element as HTMLInputElement).value).toBe('http://192.168.7.99');
    expect(page!.get('.inventory-filter-summary [role="status"]').text()).toBe('1 shown');
    expect(fetch.mock.calls.some(([url]) => /\/(actions|control|approve)$/.test(url))).toBe(false);
  });
  it('finds and fills the local address for an MQTT-discovered device without saving or switching', async () => {
    const mqttRelay = {
      ...relay,
      trustStatus: 'approved',
      adapter: { ...relay.adapter, protocol: 'mqtt', driver: 'shelly-discovered', target: network.id },
      metadata: { physicalId: network.id, channel: 0, component: 'switch:0' },
      control: { status: 'needs-setup', binding: null, reason: 'No route' },
    };
    const state = { ...data([mqttRelay]), networkZones: [{ id: 'lan', name: 'LAN', cidr: '192.168.7.0/24', seedIps: [] }] };
    const fetch = vi.fn(async (url: string) => {
      if (url === '/portal/network/scan') {
        state.networkDevices = [network];
        return { ok: true, json: async () => scanResult([network], state.networkZones) };
      }
      return { ok: true, json: async () => url.endsWith('/portal/state') ? structuredClone(state) : url.includes('/devices/enrollments') ? { enrollments: enrollmentsFor(state) } : { runs: [] } };
    });
    await render('/devices/', fetch);
    await button('Kitchen Shelly').trigger('click');
    const setup = page!.get('.control-setup');
    await setup.get('select').setValue('http');
    expect((setup.get('input[type="url"]').element as HTMLInputElement).value).toBe('');
    expect(fetch.mock.calls.filter(([url]) => url === '/portal/network/scan')).toHaveLength(0);
    await button('Find address').trigger('click');
    await flushPromises();
    expect((setup.get('input[type="url"]').element as HTMLInputElement).value).toBe('http://192.168.7.21');
    expect(setup.get('select').element.value).toBe('http');
    expect((setup.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
    expect(fetch.mock.calls.filter(([url]) => url === '/portal/network/scan')).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => /\/(control|actions|approve)$/.test(url))).toBe(false);
  });
  it('shows all detected devices, reviews a channel, then keeps approval and switching separate', async () => {
    const state = { ...data(), networkZones: [{ id: 'lan', name: 'LAN', cidr: '192.168.7.0/24', seedIps: [] }] };
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/portal/network/memory') return { ok: true, json: async () => ({ devices: [], summary: { known: 0, observedInLatestScan: 0, notObservedInLatestScan: 0, lastScanId: null } }) };
      if (url === '/portal/network/snapshots') return { ok: true, json: async () => ({ snapshots: [] }) };
      if (url === '/portal/network/capabilities') return { ok: true, json: async () => ({ nmap: { available: true, enabled: true }, observer: null }) };
      if (url === '/portal/network/scan') {
        state.networkDevices = [
          network,
          {
            ...network,
            id: 'camera',
            vendor: 'Ring',
            protocol: 'unknown',
            components: [],
          },
        ];
        state.devices = [relay];
        return {
          ok: true,
          json: async () => scanResult(state.networkDevices as any[], state.networkZones),
        };
      }
      if (url.endsWith('/approve')) {
        state.devices = [
          {
            ...relay,
            trustStatus: 'approved',
            adapter: { ...relay.adapter, configured: true },
            control: {
              status: 'needs-setup',
              binding: null,
              reason: 'No route',
            },
          },
        ];
        return { ok: true, json: async () => ({ status: 'approved' }) };
      }
      if (url.endsWith('/control')) {
        const binding = JSON.parse(String(options?.body)).binding;
        state.devices = [
          {
            ...(state.devices[0] as object),
            control: {
              status: binding.enabled ? 'ready' : 'disabled',
              binding,
              reason: 'Explicit route',
            },
          },
        ];
        return { ok: true, json: async () => ({ persistence: 'runtime' }) };
      }
      if (url.includes('/devices/enrollments')) return { ok: true, json: async () => ({ enrollments: enrollmentsFor(state) }) };
      return {
        ok: true,
          json: async () => (url === '/portal/state' ? structuredClone(state) : { runs: [] }),
      };
    });
    await render('/network-intelligence/', fetch);
    await button('Scan network').trigger('click');
    await flushPromises();
    await button('Discovery').trigger('click');
    await flushPromises();
    expect(button('All devices').attributes('aria-pressed')).toBe('true');
    expect(page!.text()).toContain('Ring');
    expect(page!.text()).toContain('Adapter needed');
    await page!.get('.network-device-more').get('summary').trigger('click');
    await button('Review channels').trigger('click');
    await flushPromises();
    expect(page!.find('aside[aria-label="Device details"]').exists()).toBe(
      true,
    );
    expect(page!.text()).toContain('Approval required');
    expect(page!.findAll('a').find(link => link.text() === 'Open settings')?.attributes('href')).toBe('http://192.168.7.21');
    await button('Approve device').trigger('click');
    await flushPromises();
    expect(page!.find('.device-switch-control').exists()).toBe(false);
    const form = page!.get('.control-setup');
    await form.get('select').setValue('http');
    expect(
      (form.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.21');
    await form.get('input[type="checkbox"]').setValue(true);
    await form.get('form').trigger('submit');
    await flushPromises();
    expect(page!.find('.device-switch-control').exists()).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/actions'))).toBe(
      false,
    );
  });
  it('shows backend control failures alongside the requested device', async () => {
    const ready = {
      ...relay,
      trustStatus: 'approved',
      control: {
        status: 'ready',
        binding: {
          kind: 'shelly-mqtt',
          physicalId: relay.metadata.physicalId,
          channel: 0,
          topic: 'kitchen/rpc',
          enabled: true,
        },
        reason: 'Configured',
      },
    };
    const state = data([ready]);
    await render(
      '/devices/',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith('/actions')
            ? { status: 'failed', message: 'Broker unavailable' }
            : url === '/portal/state'
              ? state
              : url.includes('/devices/enrollments')
                ? { enrollments: enrollmentsFor(state) }
              : { runs: [] },
      })),
    );
    await page!
      .get('.device-switch-control')
      .findAll('button')[1]
      .trigger('click');
    await flushPromises();
    expect(page!.get('.device-control-error').text()).toBe(
      'Broker unavailable',
    );
  });
  it('hides examples by default and filters actual control readiness', async () => {
    const state = data([
      { ...relay, trustStatus: 'approved' },
      {
        ...relay,
        id: 'example',
        displayName: 'Lab example',
        trustStatus: 'approved',
        metadata: { simulated: true },
      },
    ]);
    await render(
      '/devices/',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => url === '/portal/state' ? state : url.includes('/devices/enrollments') ? { enrollments: enrollmentsFor(state) } : { runs: [] },
      })),
    );
    expect(page!.findAll('tbody tr')).toHaveLength(1);
    await page!
      .get('select[aria-label="Filter by status"]')
      .setValue('controllable');
    expect(page!.text()).toContain('No devices match this filter');
    await page!.get('select[aria-label="Filter by status"]').setValue('all');
    await page!
      .get('select[aria-label="Filter by source"]')
      .setValue('examples');
    expect(page!.findAll('tbody tr')).toHaveLength(1);
    expect(page!.get('tbody').text()).toContain('Lab example');
  });
});
