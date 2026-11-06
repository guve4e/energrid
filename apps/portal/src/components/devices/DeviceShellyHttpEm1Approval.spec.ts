import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { clearAuthenticatedSession, setAuthenticatedSession } from '../../auth/auth-client';
import DeviceShellyHttpEm1Approval from './DeviceShellyHttpEm1Approval.vue';

const deviceA = 'shellyproem50-8c4f00dbd258:em1:0';
const deviceB = 'shellyproem50-08f9e0e84910:em1:0';

function approval(endpoint: string, approved = false) {
  return {
    approved,
    approvalStatus: approved ? 'approved' : 'missing',
    sourceId: 'shelly-http-em1',
    selector: 'EM1.GetStatus?id=0',
    endpoint,
    networkScope: 'gateway-unknown:eero-lan',
    fields: [{ metric: 'power', rawKey: 'power', unit: 'W' }],
  };
}

function response(value: unknown) {
  return { ok: true, json: async () => value };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAuthenticatedSession(false);
});

describe('Shelly EM1 HTTP approval review', () => {
  it('keeps the selected device, endpoint, and POST target identical through approval', async () => {
    setAuthenticatedSession({ accessToken: 'token', expiresIn: 900,
      user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(approval('192.168.7.54')))
      .mockResolvedValueOnce(response(approval('192.168.7.54', true)));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const wrapper = mount(DeviceShellyHttpEm1Approval, { props: { deviceId: deviceA, deviceName: 'Energy meter 1', apiBase: '', accessToken: 'token' } });
    await flushPromises();
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('Energy meter 1');
    expect(wrapper.text()).toContain(deviceA);
    expect(wrapper.text()).toContain('192.168.7.54');
    await wrapper.get('button:not(:last-child)').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenNthCalledWith(1, `/portal/devices/${encodeURIComponent(deviceA)}/shelly-http-em1-approval`,
      expect.objectContaining({ credentials: 'include' }));
    const post = fetchMock.mock.calls[1];
    expect(post[0]).toBe(`/portal/devices/${encodeURIComponent(deviceA)}/shelly-http-em1-approval`);
    expect(post[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(post[1]?.body))).toEqual({
      confirmedDeviceId: deviceA, approvedFields: ['power'], confirmedSourceId: 'shelly-http-em1',
      confirmedSelector: 'EM1.GetStatus?id=0', confirmedEndpoint: '192.168.7.54',
    });
    expect(wrapper.emitted('approved')).toHaveLength(1);
    wrapper.unmount();
  });

  it('ignores a late response from the previously selected meter', async () => {
    setAuthenticatedSession({ accessToken: 'token', expiresIn: 900,
      user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    let resolveA!: (value: unknown) => void;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes(encodeURIComponent(deviceA))) return new Promise(resolve => { resolveA = resolve; });
      return Promise.resolve(response(approval('192.168.1.204')));
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(DeviceShellyHttpEm1Approval, { props: { deviceId: deviceA, deviceName: 'Energy meter 1', apiBase: '', accessToken: 'token' } });
    await wrapper.setProps({ deviceId: deviceB, deviceName: 'Energy meter 2' });
    await flushPromises();
    resolveA(response(approval('192.168.7.54')));
    await flushPromises();
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('Energy meter 2');
    expect(wrapper.text()).toContain(deviceB);
    expect(wrapper.text()).toContain('192.168.1.204');
    expect(wrapper.text()).not.toContain('192.168.7.54');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('shows the structured route rejection without implying approval', async () => {
    setAuthenticatedSession({ accessToken: 'token', expiresIn: 900,
      user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(approval('192.168.7.54')))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({
        code: 'observer_component_not_authorized',
        message: 'EM1 power approval is blocked: observer_component_not_authorized. Add this exact EM1 component to the authorized observer assignment.',
        action: 'Add this exact EM1 component to the authorized observer assignment.',
      }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const wrapper = mount(DeviceShellyHttpEm1Approval, { props: { deviceId: deviceA, deviceName: 'Energy meter 1', apiBase: '', accessToken: 'token' } });
    await flushPromises();
    await wrapper.get('button').trigger('click');
    await wrapper.get('button:not(:last-child)').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('observer_component_not_authorized');
    expect(wrapper.get('[role="alert"]').text()).toContain('authorized observer assignment');
    expect(wrapper.emitted('approved')).toBeUndefined();
    wrapper.unmount();
  });
});
