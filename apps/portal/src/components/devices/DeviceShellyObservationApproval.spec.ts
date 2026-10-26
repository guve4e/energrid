import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedSession, setAuthenticatedSession } from '../../auth/auth-client';
import DeviceShellyObservationApproval from './DeviceShellyObservationApproval.vue';

const deviceId = 'shellypro2pm-001122334455:switch:0';
const proposal = {
  approved: false,
  approvalStatus: 'missing' as const,
  sourceId: 'shelly-mqtt' as const,
  selector: 'shellypro2pm-001122334455/events/rpc',
  fields: [{ metric: 'power' as const, rawKey: 'power' as const, unit: 'W' as const, displayUnit: 'W' as const }],
};
let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  clearAuthenticatedSession(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DeviceShellyObservationApproval', () => {
  it('requires explicit operator confirmation for the exact component power feed', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => init?.method === 'POST' ? { ...proposal, approved: true, approvalStatus: 'approved' as const } : proposal,
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => false));
    setAuthenticatedSession({ accessToken: 'portal-token', expiresIn: 900, user: { id: 'admin', email: 'admin@test', name: 'Admin', role: 'admin' } });
    wrapper = mount(DeviceShellyObservationApproval, { props: { deviceId, enabled: true, apiBase: '', accessToken: 'portal-token' } });
    await flushPromises();
    expect(wrapper.text()).toContain('MQTT identity alone does not authorize measurements');
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('shellypro2pm-001122334455/events/rpc');
    await wrapper.get('button:not(:last-child)').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('confirm', vi.fn(() => true));
    await wrapper.get('button:not(:last-child)').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ confirmedDeviceId: deviceId, approvedFields: ['power'] });
    expect(wrapper.text()).toContain('Power is explicitly approved');
  });
});
