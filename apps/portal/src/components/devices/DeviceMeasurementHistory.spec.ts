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

function installFetch(fields: Partial<{
  temperature: { value: number; sourceId: string; receivedAt: string; ageSeconds: number; freshness: string; authority: string };
  humidity: { value: number; sourceId: string; receivedAt: string; ageSeconds: number; freshness: string; authority: string };
}> = {
  temperature: { value: 18.2, sourceId: 'energrid-http-status', receivedAt: new Date().toISOString(), ageSeconds: 2, freshness: 'fresh', authority: 'approved' },
  humidity: { value: 49.4, sourceId: 'energrid-http-status', receivedAt: new Date().toISOString(), ageSeconds: 2, freshness: 'fresh', authority: 'approved' },
}, historyUnavailable = false, emptyHistory = false, historyRows?: Array<{ observedAt: string; value: number; unit: string; quality: 'measured' }>) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/observations')) return json({ deviceId, freshnessLimitSeconds: 60, fields });
    const parsed = new URL(url, window.location.origin);
    const metric = parsed.searchParams.get('metric') || 'temperature';
    if (historyUnavailable) return json({ message: 'unavailable' }, false, 503);
    const unit = metric === 'temperature' ? 'Cel' : '%RH';
    const value = metric === 'temperature' ? 18 : 49;
    const rows = historyRows ?? [
      { observedAt: new Date(Date.now() - 60_000).toISOString(), value: value - 0.2, unit, quality: 'measured' as const },
      { observedAt: new Date(Date.now() - 30_000).toISOString(), value, unit, quality: 'measured' as const },
    ];
    return json({ deviceId, metric, unit, measurements: emptyHistory ? [] : rows });
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
    expect(page.text()).toContain('Markers and trends use recorded samples only. Lines connect nearby readings; long gaps stay unconnected.');
    expect(page.text()).toContain('Median');
    const summaries = page.findAll('.measurement-chart').at(0)!.find('.chart-summary');
    expect(summaries.text()).toContain('Min17.8');
    expect(summaries.text()).toContain('Median17.9');
    expect(summaries.text()).toContain('Max18.0');
    expect(page.findAll('path.chart-line-segment')).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/observations'))).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/measurements?'))).toHaveLength(2);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer portal-test-token');
  });

  it('shows the exact saved reading and timestamp on hover and keyboard focus', async () => {
    installFetch();
    const page = await render();
    const firstPoint = page.findAll('circle.chart-point')[0];
    expect(firstPoint.attributes('tabindex')).toBe('0');
    await firstPoint.trigger('pointerenter');
    expect(page.findAll('.chart-tooltip')[0].text()).toContain('17.8 °C');
    expect(page.findAll('.chart-tooltip')[0].text()).toMatch(/Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep/);
    await firstPoint.trigger('pointerleave');
    expect(page.findAll('.chart-tooltip')).toHaveLength(0);
    await firstPoint.trigger('focus');
    expect(page.findAll('.chart-tooltip')).toHaveLength(1);
  });

  it('never presents stale values as current and keeps device connectivity separate', async () => {
    installFetch({
      temperature: { value: 18.2, sourceId: 'energrid-http-status', receivedAt: '2026-10-24T08:00:00.000Z', ageSeconds: 7200, freshness: 'stale', authority: 'approved' },
      humidity: { value: 49.4, sourceId: 'energrid-http-status', receivedAt: '2026-10-24T08:00:00.000Z', ageSeconds: 7200, freshness: 'stale', authority: 'approved' },
    });
    const page = await render('online');
    expect(page.text()).toContain('Connected');
    expect(page.text()).toContain('Stale');
    expect(page.findAll('.current-measurement strong').map(value => value.text())).toEqual(['—', '—']);
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
    await page.findAll('button').find(button => button.text() === '1 hour')?.trigger('click');
    await flushPromises();
    const oneHourUrl = fetchMock.mock.calls.filter(([url]) => String(url).includes('/measurements?')).at(-1)?.[0];
    const oneHourQuery = new URL(String(oneHourUrl), window.location.origin).searchParams;
    const oneHourMs = Date.parse(oneHourQuery.get('to')!) - Date.parse(oneHourQuery.get('from')!);
    expect(oneHourMs).toBeGreaterThan(59 * 60_000);
    expect(oneHourMs).toBeLessThan(61 * 60_000);
  });

  it('shows a clear empty-history state without synthesizing samples', async () => {
    installFetch(undefined, false, true);
    const page = await render();
    expect(page.text()).toContain('No temperature history in this range.');
    expect(page.text()).toContain('No humidity history in this range.');
    expect(page.findAll('circle.chart-point')).toHaveLength(0);
  });

  it('breaks the graph across long collection gaps instead of implying readings existed there', async () => {
    const now = Date.now();
    const rows = [
      { observedAt: new Date(now - 23 * 60 * 60_000).toISOString(), value: 17.8, unit: 'Cel', quality: 'measured' as const },
      { observedAt: new Date(now - 22 * 60 * 60_000).toISOString(), value: 18.1, unit: 'Cel', quality: 'measured' as const },
      { observedAt: new Date(now - 18 * 60 * 60_000).toISOString(), value: 18.3, unit: 'Cel', quality: 'measured' as const },
      { observedAt: new Date(now - 17 * 60 * 60_000).toISOString(), value: 18.5, unit: 'Cel', quality: 'measured' as const },
    ];
    installFetch(undefined, false, false, rows);
    const page = await render();
    const temperatureChart = page.findAll('svg').at(0)!;
    expect(temperatureChart.findAll('path.chart-line-segment')).toHaveLength(2);
    expect(temperatureChart.findAll('circle.chart-point')).toHaveLength(4);
  });

  it('does not request history for fields with no active observation approval', async () => {
    installFetch({});
    const page = await render();
    expect(page.text()).toContain('No authorized temperature or humidity observations are available');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/measurements?'))).toBe(false);
  });
});
