import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import HomeDashboard from './HomeDashboard.vue';
import { clearAuthenticatedSession, setAuthenticatedSession } from '../../auth/auth-client';

const physicalId = 'shellyplus1-00c0de000001:switch:0';

function switchDevice(control: Record<string, unknown> = { status: 'needs-setup', binding: null, reason: 'No explicit control route.' }, trustStatus = 'approved') {
  return {
    id: physicalId,
    displayName: 'shellyplus1-00c0de000001 switch:0',
    zoneName: 'Lab',
    trustStatus,
    capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
    adapter: { protocol: 'mqtt', driver: 'shelly-lan', configured: true, target: 'shellyplus1-00c0de000001' },
    control,
    state: { values: { on: false }, observedAt: new Date().toISOString(), status: 'online' },
  };
}

function installFetch(devices: unknown[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/portal/state')) {
      return { ok: true, status: 200, json: async () => ({ site: { name: 'Virtual Device Lab' }, devices }) } as Response;
    }
    if (url.includes('/portal/weather/dashboard')) {
      return { ok: true, status: 200, json: async () => ({ location: 'Lab', fetchedAt: new Date().toISOString(), current: { temperature: null, windKmh: null, gustKmh: null }, dataQuality: { status: 'available' } }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function render(devices: unknown[]) {
  setAuthenticatedSession({ accessToken: 'test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
  const fetchMock = installFetch(devices);
  const wrapper = mount(HomeDashboard, {
    props: {
      apiBase: '', accessToken: 'test-token', nativeWakeAvailable: false,
      nativeWakeEnabled: false, nativeWakeStatus: 'unavailable',
    },
  });
  await flushPromises();
  return { wrapper, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthenticatedSession(false);
});

describe('Home Dashboard control authorization', () => {
  it('keeps an approved switch visible as read-only when control is not set up', async () => {
    const { wrapper } = await render([switchDevice()]);
    expect(wrapper.find('.relay-section').exists()).toBe(true);
    expect(wrapper.find('.relay-card').text()).toContain('Off');
    expect(wrapper.find('.relay-read-only').text()).toContain('No explicit control route.');
    expect(wrapper.findAll('.relay-actions button')).toHaveLength(0);
    wrapper.unmount();
  });

  it('offers On/Off actions for an approved switch with a ready control route', async () => {
    const control = {
      status: 'ready', reason: 'Explicit control route configured.',
      binding: { kind: 'shelly-mqtt', enabled: true, physicalId: 'shellyplus1-00c0de000001', channel: 0, topic: 'lab/shelly/rpc' },
    };
    const { wrapper, fetchMock } = await render([switchDevice(control)]);
    const buttons = wrapper.findAll('.relay-actions button');
    expect(buttons.map(button => button.text())).toEqual(['On', 'Off']);
    await buttons[0].trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      `/portal/devices/${encodeURIComponent(physicalId)}/actions`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'turn_on' }) }),
    );
    wrapper.unmount();
  });

  it('does not offer switching actions for an unapproved device', async () => {
    const { wrapper } = await render([switchDevice({ status: 'ready', binding: {} }, 'discovered')]);
    expect(wrapper.findAll('.relay-actions button')).toHaveLength(0);
    expect(wrapper.find('.relay-section').exists()).toBe(false);
    wrapper.unmount();
  });

  it('preserves existing non-switch Home Dashboard presentation', async () => {
    const sensor = {
      id: 'esp8266:324b44', displayName: 'Kitchen temperature', zoneName: 'Kitchen', trustStatus: 'approved',
      capabilities: [{ kind: 'temperature', actions: ['read'] }],
      adapter: { protocol: 'http', driver: 'energrid-esp8266', configured: true },
      state: { values: { temperature: 21.4 }, observedAt: new Date().toISOString(), status: 'online' },
    };
    const { wrapper } = await render([sensor]);
    expect(wrapper.text()).toContain('Kitchen');
    expect(wrapper.find('.relay-section').exists()).toBe(false);
    wrapper.unmount();
  });
});
