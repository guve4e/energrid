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
      measurements: empty ? [] : [{ observedAt: new Date(Date.now() - 30_000).toISOString(), value: metric === 'power' ? 128 : 2.75, unit: metric === 'power' ? 'W' : 'kWh' }],
    }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
async function render() {
  setAuthenticatedSession({ accessToken: 'portal-token', expiresIn: 900, user: { id: 'admin', email: 'a@example.test', name: 'Admin', role: 'admin' } });
  wrapper = mount(DeviceElectricalHistory, { props: { deviceId: 'meter-1', deviceStatus: 'online', apiBase: '', accessToken: 'portal-token', authorizedMetrics: ['power', 'energy_import_total', 'energy_export_total'] } });
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
    expect(page.findAll('.chart-point').length).toBe(3);
    expect(page.find('.chart-summary').text()).toContain('Median');
    expect(page.find('.chart-summary').text()).toContain('128.0 W');
    expect(page.findAll('.chart-summary')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/electrical-measurements?'))).toBe(true);
  });
  it('does not draw empty charts when supported telemetry has no stored readings', async () => {
    installFetch(true);
    const page = await render();
    expect(page.text()).toContain('no electrical readings have been recorded yet');
    expect(page.findAll('.electrical-chart-card')).toHaveLength(0);
  });
  it('requests only explicitly authorized electrical metrics', async () => {
    const fetchMock = installFetch();
    setAuthenticatedSession({ accessToken: 'portal-token', expiresIn: 900, user: { id: 'admin', email: 'a@example.test', name: 'Admin', role: 'admin' } });
    wrapper = mount(DeviceElectricalHistory, { props: {
      deviceId: 'meter-1', deviceStatus: 'online', apiBase: '', accessToken: 'portal-token', authorizedMetrics: ['power'],
    } });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('metric=power');
    expect(wrapper.text()).toContain('128 W');
  });

  it('shows actual power statistics while cumulative energy remains a distinct counter series', async () => {
    installFetch();
    const page = await render();
    expect(page.findAll('.electrical-chart-card')).toHaveLength(3);
    expect(page.findAll('.chart-summary')).toHaveLength(1);
    expect(page.findAll('.time-series-point').length).toBe(3);
    expect(page.findAll('.electrical-current-card').map(card => card.text()).join(' ')).toContain('2.75 kWh');
  });

  it('requests the selected time range and replaces the prior device series', async () => {
    const requests: string[] = [];
    setAuthenticatedSession({ accessToken: 'portal-token', expiresIn: 900, user: { id: 'admin', email: 'a@example.test', name: 'Admin', role: 'admin' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      const deviceId = decodeURIComponent(new URL(url, window.location.origin).pathname.split('/').at(-2)!);
      return { ok: true, json: async () => ({ deviceId, metric: 'power', unit: 'W', measurements: [{ observedAt: new Date().toISOString(), value: deviceId === 'meter-2' ? 42 : 11 }] }) };
    }));
    wrapper = mount(DeviceElectricalHistory, { props: { deviceId: 'meter-1', deviceStatus: 'online', apiBase: '', accessToken: 'portal-token', authorizedMetrics: ['power'] } });
    await flushPromises();
    await wrapper.setProps({ deviceId: 'meter-2' });
    await flushPromises();
    expect(wrapper.text()).toContain('42 W');
    expect(wrapper.text()).not.toContain('11 W');
    await wrapper.findAll('button').find(button => button.text() === '7 days')?.trigger('click');
    await flushPromises();
    const latest = new URL(requests.at(-1)!, window.location.origin);
    expect(decodeURIComponent(latest.pathname)).toContain('/meter-2/');
    expect(Date.parse(latest.searchParams.get('to')!) - Date.parse(latest.searchParams.get('from')!)).toBeGreaterThan(6 * 24 * 60 * 60_000);
  });
});
