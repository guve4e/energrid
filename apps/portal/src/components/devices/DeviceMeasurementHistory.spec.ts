import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedSession, setAuthenticatedSession } from '../../auth/auth-client';
import DeviceMeasurementHistory from './DeviceMeasurementHistory.vue';

const deviceId = 'device:upstream-lan:esp8266:324864';
let wrapper: ReturnType<typeof mount> | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function json(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => structuredClone(payload) };
}

function installFetch(fields = {
  temperature: { value: 18.2, sourceId: 'energrid-http-status', receivedAt: new Date().toISOString(), ageSeconds: 2, freshness: 'fresh', authority: 'approved' },
  humidity: { value: 49.4, sourceId: 'energrid-http-status', receivedAt: new Date().toISOString(), ageSeconds: 2, freshness: 'fresh', authority: 'approved' },
}, historyUnavailable = false, emptyHistory = false) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/observations')) return json({ deviceId, freshnessLimitSeconds: 60, fields });
    const parsed = new URL(url, window.location.origin);
    const metric = parsed.searchParams.get('metric') || 'temperature';
    if (historyUnavailable) return json({ message: 'unavailable' }, false, 503);
    return json({ deviceId, metric, unit: metric === 'temperature' ? 'Cel' : '%RH', measurements: emptyHistory ? [] : [
      { observedAt: '2026-10-24T09:30:00.000Z', value: metric === 'temperature' ? 18 : 49, unit: metric === 'temperature' ? 'Cel' : '%RH', quality: 'measured' },
    ] });
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function render(deviceStatus = 'online') {
  setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
  wrapper = mount(DeviceMeasurementHistory, {
    props: { deviceId, deviceStatus, apiBase: '', accessToken: 'portal-test-token' },
  });
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  clearAuthenticatedSession(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('device measurement history', () => {
  it('renders Core readings with units, timestamp, separate connection and freshness, plus history points', async () => {
    installFetch();
    const page = await render();
    expect(page.text()).toContain('Connected');
    expect(page.text()).toContain('Fresh');
    expect(page.text()).toContain('18.2');
    expect(page.text()).toContain('°C');
    expect(page.text()).toContain('%RH');
    expect(page.text()).toContain('Last observed');
    expect(page.text()).toContain('Each point is a stored measurement; gaps are not interpolated.');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/observations'))).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/measurements?'))).toHaveLength(2);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer portal-test-token');
  });

  it('never presents stale values as current and keeps device connectivity separate', async () => {
    installFetch({
      temperature: { value: 18.2, sourceId: 'energrid-http-status', receivedAt: '2026-10-24T08:00:00.000Z', ageSeconds: 7200, freshness: 'stale', authority: 'approved' },
      humidity: { value: 49.4, sourceId: 'energrid-http-status', receivedAt: '2026-10-24T08:00:00.000Z', ageSeconds: 7200, freshness: 'stale', authority: 'approved' },
    });
    const page = await render('online');
    expect(page.text()).toContain('Connected');
    expect(page.text()).toContain('Stale');
    expect(page.text()).not.toContain('18.2');
    expect(page.text()).not.toContain('49.4');
  });

  it('shows unavailable and empty history states and changes the requested range', async () => {
    installFetch({
      temperature: { value: 18.2, sourceId: 'energrid-http-status', receivedAt: new Date().toISOString(), ageSeconds: 1, freshness: 'fresh', authority: 'approved' },
      humidity: { value: 49.4, sourceId: 'energrid-http-status', receivedAt: new Date().toISOString(), ageSeconds: 1, freshness: 'fresh', authority: 'approved' },
    }, true);
    const page = await render('offline');
    expect(page.text()).toContain('Disconnected');
    expect(page.text()).toContain('Measurement history is unavailable.');
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes('/measurements?')).map(([url]) => String(url));
    const sevenDays = page.findAll('button').find(button => button.text() === '7 days');
    await sevenDays?.trigger('click');
    await flushPromises();
    const after = fetchMock.mock.calls.filter(([url]) => String(url).includes('/measurements?')).map(([url]) => String(url));
    expect(after).toHaveLength(before.length + 2);
    expect(after.at(-1)).toContain('metric=humidity');
    const sevenDayQuery = new URL(String(after.at(-1)), window.location.origin).searchParams;
    expect(Date.parse(sevenDayQuery.get('to')!) - Date.parse(sevenDayQuery.get('from')!)).toBeGreaterThan(6 * 24 * 60 * 60_000);
    expect(page.find('button[aria-pressed="true"]').text()).toBe('7 days');
  });

  it('shows a clear empty-history state without synthesizing samples', async () => {
    installFetch(undefined, false, true);
    const page = await render();
    expect(page.text()).toContain('No temperature history in this range.');
    expect(page.text()).toContain('No humidity history in this range.');
    expect(page.findAll('circle.chart-point')).toHaveLength(0);
  });

  it('does not request history for fields with no active observation approval', async () => {
    installFetch({});
    const page = await render();
    expect(page.text()).toContain('No authorized temperature or humidity observations are available');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/measurements?'))).toBe(false);
  });
});
