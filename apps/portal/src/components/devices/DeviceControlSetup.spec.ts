import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DeviceControlSetup from './DeviceControlSetup.vue';
import { setAuthenticatedSession } from '../../auth/auth-client';
import { controlRouteLabel, type ControlSetupDevice } from './device-control';

const physicalId = 'shellyplus1-00c0de000001';
const device: ControlSetupDevice = {
  id: `${physicalId}:switch:0`,
  trustStatus: 'approved',
  capabilities: [{ actions: ['turn_on', 'turn_off'] }],
  adapter: { protocol: 'http', driver: 'shelly-lan', target: physicalId },
  metadata: {
    physicalId,
    channel: 0,
    component: 'switch:0',
    networkScope: 'virtual-lab-observer:device-lab-vlan',
  },
  control: { status: 'needs-setup', binding: null, reason: 'No explicit switch permission.' },
};
let page: ReturnType<typeof mount> | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  vi.unstubAllGlobals();
});

function render(value = device, ok = true) {
  setAuthenticatedSession({ accessToken: 'unit-token', expiresIn: 900, user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) => ({
    ok,
    json: async () => ({ persistence: 'local' }),
  }));
  vi.stubGlobal('fetch', fetch);
  page = mount(DeviceControlSetup, { props: { device: value, apiBase: '', accessToken: 'unit-only' } });
  return { page, fetch };
}

describe('device control setup UI', () => {
  it('offers only the component permission for Shelly and posts no transport or endpoint', async () => {
    const { page, fetch } = render();
    expect(page.text()).toContain('Allow switching');
    expect(page.text()).toContain('Execution is resolved from the authorized network scope after permission is enabled');
    expect(page.text()).toContain('virtual-lab-observer:device-lab-vlan');
    expect(page.text()).not.toContain('Authorized Virtual Lab observer');
    expect(page.text()).not.toContain('MQTT command topic');
    expect(page.find('select').exists()).toBe(false);
    expect(page.find('input[type="url"]').exists()).toBe(false);
    await page.get('input[type="checkbox"]').setValue(true);
    await page.get('form').trigger('submit');
    await flushPromises();
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.binding).toEqual({ kind: 'shelly-switch', enabled: true, physicalId, channel: 0 });
    expect(body.binding).not.toHaveProperty('topic');
    expect(body.binding).not.toHaveProperty('baseUrl');
  });

  it('offers the same explicit permission for an enrolled Shelly discovered over MQTT', async () => {
    const discovered = {
      ...device,
      adapter: { protocol: 'mqtt', driver: 'shelly-discovered', target: physicalId },
      metadata: { ...device.metadata, networkScope: 'gateway-unknown:192.168.7.0/24' },
    }
    const { page, fetch } = render(discovered)
    expect(page.text()).toContain('Execution is resolved from the authorized network scope')
    expect((page.get('input[type="checkbox"]').element as HTMLInputElement).disabled).toBe(false)
    await page.get('input[type="checkbox"]').setValue(true)
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      binding: { kind: 'shelly-switch', enabled: true, physicalId, channel: 0 },
    })
  })

  it('keeps permission opt-in and shows saved permission disabled without selecting a route', async () => {
    const existing = {
      ...device,
      control: {
        status: 'disabled' as const,
        reason: 'Switching is disabled.',
        binding: { kind: 'shelly-switch' as const, enabled: false, physicalId, channel: 0 },
      },
    };
    const { page } = render(existing);
    expect((page.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
    expect(page.text()).toContain('Switching permission disabled');
    expect(page.find('select').exists()).toBe(false);
  });

  it('retains an existing authorized MQTT route for a legacy Shelly profile without exposing transport selection', async () => {
    const legacyRoute = {
      kind: 'shelly-mqtt' as const,
      enabled: true,
      physicalId,
      channel: 0,
      topic: 'shelly/device/rpc',
    };
    const legacy = {
      ...device,
      adapter: { protocol: 'mqtt', driver: 'shelly-rpc', target: physicalId },
      control: { status: 'ready' as const, binding: legacyRoute, reason: 'Enabled.' },
    };
    const { page, fetch } = render(legacy);
    expect(page.text()).toContain('The existing authorized Shelly route is retained');
    expect(page.find('select').exists()).toBe(false);
    await page.get('input[type="checkbox"]').setValue(false);
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      binding: { ...legacyRoute, enabled: false },
    });
  });

  it('does not allow a new Shelly permission when no authorized execution route exists', () => {
    const legacyProfile: ControlSetupDevice = {
      ...device,
      adapter: { protocol: 'mqtt', driver: 'shelly-rpc', target: physicalId },
      control: { status: 'needs-setup', binding: null, reason: 'No route.' },
    };
    const { page } = render(legacyProfile);
    expect(page.text()).toContain('No authorized execution route is available');
    expect((page.get('input[type="checkbox"]').element as HTMLInputElement).disabled).toBe(true);
    expect((page.get('button[type="submit"]').element as HTMLButtonElement).disabled).toBe(true);
    expect(page.find('select').exists()).toBe(false);
  });

  it('saves non-Shelly MQTT setup with its existing contract', async () => {
    const generic: ControlSetupDevice = {
      ...device,
      id: 'light-1',
      adapter: { protocol: 'mqtt', driver: 'native-mqtt' },
      metadata: {},
      control: { status: 'needs-setup', binding: null, reason: 'No explicit switch permission.' },
    };
    const { page, fetch } = render(generic);
    await page.get('select').setValue('mqtt');
    await page.get('input[placeholder="device-prefix/rpc"]').setValue('house/lights/command');
    await page.get('input[type="checkbox"]').setValue(true);
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      binding: { kind: 'generic-mqtt', enabled: true, topic: 'house/lights/command' },
    });
  });

  it('does not offer switching permission for an unapproved or read-only Shelly', () => {
    const unapproved = render({ ...device, trustStatus: 'discovered' });
    expect(unapproved.page.find('form').exists()).toBe(false);
    unapproved.page.unmount();
    const readOnly = render({ ...device, capabilities: [{ actions: ['read'] }] });
    expect(readOnly.page.find('form').exists()).toBe(false);
  });

  it('labels a saved remote route as configuration without claiming it is currently verified', () => {
    expect(controlRouteLabel({
      ...device,
      control: {
        status: 'ready', reason: 'legacy',
        binding: { kind: 'shelly-virtual-lab', enabled: true, physicalId, channel: 0 },
      },
    })).toContain('Configured remote RPC route · current scope verification required');
  });

  it('does not describe an unverified local endpoint as revalidated', () => {
    expect(controlRouteLabel({
      ...device,
      control: {
        status: 'ready', reason: 'legacy',
        binding: { kind: 'shelly-http', enabled: true, physicalId, channel: 0, baseUrl: 'http://192.0.2.1' },
      },
    })).toContain('Configured local RPC route · current endpoint verification required');
  });

  it('explains that site-local command execution performs its own identity preflight', () => {
    expect(controlRouteLabel({
      ...device,
      metadata: {
        ...device.metadata,
        identityEvidenceSource: 'verified_site_local_shelly_rpc',
        componentEvidenceSource: 'verified_site_local_shelly_rpc',
        siteLocalObserverId: 'pi-upstream-bathroom',
      },
      control: {
        status: 'ready', reason: 'Explicit switching permission.',
        binding: { kind: 'shelly-http', enabled: true, physicalId, channel: 0, baseUrl: 'http://192.168.1.219' },
      },
    })).toContain('identity and component checked before each command');
  });
});
