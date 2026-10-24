import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedSession, setAuthenticatedSession } from '../../auth/auth-client';
import DeviceObservationApproval from './DeviceObservationApproval.vue';

const deviceId = 'device:eero-lan:esp8266:324b44';
const proposal = {
  approved: false,
  approvalStatus: 'missing' as const,
  sourceId: 'energrid-http-status',
  selector: '/api/v1/status',
  fields: [
    { metric: 'temperature', rawKey: 'temperatureC', unit: 'Cel', displayUnit: '°C' },
    { metric: 'humidity', rawKey: 'humidityPct', unit: '%RH', displayUnit: '%RH' },
  ],
};
let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  clearAuthenticatedSession(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DeviceObservationApproval', () => {
  it('shows a proposal without writing authority until the operator explicitly confirms', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => init?.method === 'POST' ? { ...proposal, approved: true, approvalStatus: 'approved' as const } : proposal,
    }));
    vi.stubGlobal('fetch', fetchMock);
    setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    wrapper = mount(DeviceObservationApproval, { props: { deviceId, enabled: true, apiBase: '', accessToken: 'portal-test-token' } });
    await flushPromises();

    expect(wrapper.text()).toContain('Measurement approval required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('temperatureC → temperature (°C)');
    expect(wrapper.text()).toContain('humidityPct → humidity (%RH)');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('confirm', vi.fn(() => false));
    await wrapper.get('button:not(.approval-cancel)').trigger('click');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('confirm', vi.fn(() => true));
    await wrapper.get('button:not(.approval-cancel)').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      confirmedDeviceId: deviceId,
      approvedFields: ['temperature', 'humidity'],
    });
    expect(wrapper.text()).toContain('explicitly approved');
  });

  it('does not request or expose approval for non-Energrid devices', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    wrapper = mount(DeviceObservationApproval, { props: { deviceId: 'shelly-device', enabled: false, apiBase: '', accessToken: '' } });
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.find('section').exists()).toBe(false);
  });
});
