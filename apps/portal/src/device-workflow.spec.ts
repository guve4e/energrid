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
    networkZones: [],
    executionTraces: [],
  };
}
function button(text: string) {
  return page!.findAll('button').find((b) => b.text() === text)!;
}
async function render(path: string, fetch: unknown) {
  history.replaceState({}, '', path);
  vi.stubGlobal('fetch', fetch);
  page = mount(App, { global: { stubs: { ExecutionSimulator: true } } });
  await flushPromises();
}
describe('device onboarding page workflow with mocked services', () => {
  it('keeps repeated search, combined filters, empty results and approval-tab changes interactive without reloading', async () => {
    const kitchen = { ...relay, trustStatus: 'approved', control: { status: 'needs-setup', binding: null, reason: '' } };
    const meter = { ...kitchen, id: 'meter', displayName: 'Utility meter', zoneId: 'utility', zoneName: 'Utility', capabilities: [{ kind: 'power', actions: ['read'] }], control: { status: 'read-only', binding: null, reason: '' } };
    const example = { ...kitchen, id: 'example', displayName: 'Example relay', metadata: { simulated: true } };
    const pending = { ...relay, id: 'pending', displayName: 'Pending relay' };
    const state = data([kitchen, meter, example, pending]);
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/portal/state' ? structuredClone(state) : { runs: [] } }));
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
    await button('Pending 1').trigger('click');
    expect(count()).toBe('0 shown');
    await button('Clear filters').trigger('click');
    expect(count()).toBe('1 shown');
    expect(button('Pending 1').attributes('aria-pressed')).toBe('true');
    expect(page!.get('tbody').text()).toContain('Pending relay');
    await button('Approved 3').trigger('click');
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
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/portal/state' ? structuredClone(state) : { runs: [] } }));
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
    const state = data([mqttRelay]);
    const fetch = vi.fn(async (url: string) => {
      if (url === '/portal/network/scan') {
        state.networkDevices = [network];
        return { ok: true, json: async () => ({ devices: [network], zones: [] }) };
      }
      return { ok: true, json: async () => url === '/portal/state' ? structuredClone(state) : { runs: [] } };
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
    const state = data();
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
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
          json: async () => ({ devices: state.networkDevices, zones: [] }),
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
      return {
        ok: true,
          json: async () => (url === '/portal/state' ? structuredClone(state) : { runs: [] }),
      };
    });
    await render('/discovery/', fetch);
    expect(button('All devices').attributes('aria-pressed')).toBe('true');
    expect(page!.text()).toContain('Ring');
    expect(page!.text()).toContain('Adapter needed');
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
        json: async () => (url === '/portal/state' ? state : { runs: [] }),
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
