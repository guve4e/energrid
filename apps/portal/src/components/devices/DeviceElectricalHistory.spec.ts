import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DeviceElectricalHistory from './DeviceElectricalHistory.vue';
import { setAuthenticatedSession, clearAuthenticatedSession } from '../../auth/auth-client';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; clearAuthenticatedSession(false); vi.unstubAllGlobals(); });

function installFetch(empty = false) {
  const fetchMock = vi.fn(async (url: string) => {
    const query = new URL(url, window.location.origin).searchParams;
    const metric = query.get('metric') || 'power';
    return { ok: true, json: async () => ({
      deviceId: 'meter-1', metric,
      unit: metric === 'power' ? 'W' : 'kWh',
      measurements: empty ? [] : [{ observedAt: '2026-10-24T11:30:00.000Z', value: metric === 'power' ? 128 : 2.75, unit: metric === 'power' ? 'W' : 'kWh' }],
    }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
async function render() {
  setAuthenticatedSession({ accessToken: 'portal-token', expiresIn: 900, user: { id: 'admin', email: 'a@example.test', name: 'Admin', role: 'admin' } });
  wrapper = mount(DeviceElectricalHistory, { props: { deviceId: 'meter-1', deviceStatus: 'online', apiBase: '', accessToken: 'portal-token' } });
  await flushPromises();
  return wrapper;
}

describe('device electrical history', () => {
  it('shows authorized power and energy series with their canonical units', async () => {
    const fetchMock = installFetch();
    const page = await render();
    expect(page.text()).toContain('128 W');
    expect(page.text()).toContain('2.75 kWh');
    expect(page.text()).toContain('Imported energy');
    expect(page.text()).toContain('Exported energy');
    expect(page.findAll('.electrical-point').length).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/electrical-measurements?'))).toBe(true);
  });
  it('does not draw empty charts when supported telemetry has no stored readings', async () => {
    installFetch(true);
    const page = await render();
    expect(page.text()).toContain('no electrical readings have been recorded yet');
    expect(page.findAll('.electrical-chart-card')).toHaveLength(0);
  });
});
