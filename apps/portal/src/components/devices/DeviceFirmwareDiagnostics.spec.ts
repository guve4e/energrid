import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedSession, setAuthenticatedSession } from '../../auth/auth-client';
import DeviceFirmwareDiagnostics from './DeviceFirmwareDiagnostics.vue';

const deviceId = 'device:upstream-lan:esp8266:324864';
let wrapper: ReturnType<typeof mount> | undefined;

function historyPayload(url: string, populated = false) {
  const query = new URL(url, window.location.origin).searchParams;
  const from = query.get('from')!;
  const to = query.get('to')!;
  const granularity = query.get('granularity')!;
  const step = granularity === 'raw' ? 30 * 60_000 : granularity === 'daily' ? 86_400_000 : 2 * 3_600_000;
  const observedAt = new Date(Date.parse(from) + step).toISOString();
  const laterAt = new Date(Date.parse(observedAt) + step).toISOString();
  const bucketWidth = granularity === 'daily' ? 86_400_000 : 3_600_000;
  const bucketFor = (at: string, value: number) => {
    const bucketStart = Math.floor(Date.parse(at) / bucketWidth) * bucketWidth;
    return { schemaVersion: 1, tenantId: 'tenant-demo', siteId: 'site-home', deviceId, physicalDeviceId: 'esp8266:324864', granularity,
      bucketStartAt: new Date(bucketStart).toISOString(), bucketEndAt: new Date(bucketStart + bucketWidth).toISOString(),
      firstObservedAt: at, lastObservedAt: at, sampleCount: 1, expectedIntervalMs: 60_000, expectedSampleCount: 1,
      missingSampleCount: 0, coverageRatio: 1, partialBucket: false, metrics: { 'wifi.rssi': { minimum: value, maximum: value,
        sum: value, sampleCount: 1, missingSampleCount: 0, firstValue: value, firstObservedAt: at, lastValue: value,
        lastObservedAt: at, unit: 'dBm', source } }, counters: {} };
  };
  const source = 'http:GET:/api/v1/diagnostics';
  const stats = { minimum: -71, maximum: -55, average: -63, sum: -126, count: 2, missingCount: 0, unit: 'dBm', source,
    first: { value: -71, at: observedAt }, latest: { value: -55, at: laterAt } };
  const metrics = [
    { name: 'wifi.rssi', status: 'available', semantics: 'gauge', statistics: stats },
    { name: 'memory.free_heap', status: 'unavailable', reason: 'no_samples_in_range', semantics: 'gauge' },
    { name: 'uptime', status: 'available', semantics: 'counter', counterSeries: [{ bootSessionId: 'boot-2', firstValue: 1000, firstObservedAt: observedAt, lastValue: 2_000, lastObservedAt: laterAt, delta: 1_000, resetObserved: false, orderingComplete: true, unit: 'ms', source }] },
  ];
  const sample = (at: string, value: number) => ({ tenantId: 'tenant-demo', siteId: 'site-home', deviceId,
    physicalDeviceId: 'esp8266:324864', sampleId: `sample-${value}`, observedAt: at, bootSessionId: 'boot-2', resetEvidence: null,
    metrics: [{ name: 'wifi.rssi', value, unit: 'dBm', semantics: 'gauge', source }] });
  const buckets = [bucketFor(observedAt, -71), bucketFor(laterAt, -55)];
  const eventAt = new Date(Date.parse(from) + Math.min(10 * 60_000, (Date.parse(to) - Date.parse(from)) / 5)).toISOString();
  const event = { tenantId: 'tenant-demo', siteId: 'site-home', id: 'event-1', deviceId, physicalDeviceId: 'esp8266:324864', observedAt: eventAt,
    kind: 'reboot-detected', bootSessionId: 'boot-2', confidence: 'confirmed', source, summary: 'A new boot session was observed.',
    explanation: 'The firmware reported a different boot-session identifier.', observedAtBasis: 'server-detection-time', detectedAt: eventAt,
    inferredBootAt: { at: new Date(Date.parse(eventAt) - 5_000).toISOString(), basis: 'collected-at-minus-reported-uptime' },
    evidenceReferences: [{ type: 'firmware-diagnostic-snapshot', observedAt: eventAt, bootSessionId: 'boot-2' }] };
  const failure = { tenantId: 'tenant-demo', siteId: 'site-home', id: 'failure-1', deviceId, physicalDeviceId: 'esp8266:324864',
    attemptedAt: eventAt, reason: 'request_timeout', source, requestDurationMs: null, recoveryObservedAt: laterAt, recoveryObservedAfterMs: 30 * 60_000 };
  const device = { deviceId, physicalDeviceId: 'esp8266:324864', firstObservedAt: observedAt, latestObservedAt: laterAt,
    observedSampleCount: populated ? 2 : 0, expectedSampleCount: populated ? 2 : 0, missingSampleCount: 0,
    coverageRatio: populated ? 1 : null, coverageBasis: populated ? 'observed-sample-span' : 'requested-window-no-samples', metrics: populated ? metrics : [],
    failureCount: populated ? 1 : 0, failures: populated ? [{ ...failure, recoveryObservedAt: laterAt, recoveryObservedAfterMs: 30 * 60_000 }] : [],
    bootSessionTransitions: populated ? [{ from: 'boot-1', to: 'boot-2', observedAt: eventAt, observedAtBasis: 'server-detection-time', eventId: 'event-1',
      evidenceReferences: event.evidenceReferences }] : [], resetEvidence: [], resetEvents: [], events: populated ? [event] : [] };
  const series = populated ? granularity === 'raw' ? [sample(observedAt, -71), sample(laterAt, -55)] : buckets : [];
  return { schemaVersion: 1, tenantId: 'tenant-demo', siteId: 'site-home', granularity, from, to, records: [],
    analysis: { schemaVersion: 1, tenantId: 'tenant-demo', siteId: 'site-home', from, to, timezone: 'Europe/Sofia', granularity,
      devices: [device], site: { deviceCount: 1, observedSampleCount: device.observedSampleCount, failureCount: device.failureCount, metricAverages: [] },
      series, page: { limit: 1000, nextCursor: null, hasMore: false } } };
}

function fixtureFetch(diagnostics: object, populatedHistory = false) {
  return vi.fn(async (input: string, _init?: RequestInit) => ({ ok: true, json: async () => input.includes('/device-health/history') ? historyPayload(input, populatedHistory) : diagnostics }));
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  clearAuthenticatedSession(false);
  vi.unstubAllGlobals();
});

describe('device firmware diagnostics', () => {
  it('renders firmware health separately and explains confirmed and possible findings', async () => {
    setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    const fetchMock = fixtureFetch({
      deviceId,
      sampledAt: '2026-10-24T10:00:00.000Z',
      current: {
        firmwareVersion: '0.3.0', bootSessionId: 'esp8266-324864-1234abcd', uptimeMs: 120_000,
        reset: { reason: 'Hardware Watchdog', reasonCode: 1, exception: null },
        memory: { freeHeapBytes: 7000, heapFragmentationPct: 52, largestFreeBlockBytes: 2000 },
        wifi: { connected: false, rssiDbm: null, disconnectCount: 3, reconnectCount: 2 },
      },
      events: [{ id: 'event-1', kind: 'watchdog-reset', observedAt: '2026-10-24T09:59:00.000Z', summary: 'The firmware reports a watchdog reset.', explanation: 'Device-reported reset cause.', confidence: 'confirmed' }],
      restartCount10m: 3,
      connectivity: 'disconnected',
    }, true);
    vi.stubGlobal('fetch', fetchMock);
    wrapper = mount(DeviceFirmwareDiagnostics, { props: { deviceId, apiBase: '', accessToken: 'portal-test-token' } });
    await flushPromises();
    await wrapper.get('.health-mode-control button:last-child').trigger('click');
    expect(wrapper.text()).toContain('2m 0s');
    expect(wrapper.text()).toContain('Hardware Watchdog');
    expect(wrapper.text()).toContain('0.3.0');
    expect(wrapper.text()).toContain('52%');
    expect(wrapper.text()).toContain('3 / 2');
    expect(wrapper.text()).toContain('Restarts observed in last 10 minutes');
    expect(wrapper.text()).toContain('Free memory');
    expect(wrapper.text()).toContain('Largest free block');
    expect(wrapper.text()).toContain('Latest device-reported snapshot');
    expect(wrapper.text()).toContain('A new boot session was observed.');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer portal-test-token');
  });

  it('shows the pre-flash unavailable state without implying a device failure', async () => {
    setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    vi.stubGlobal('fetch', fixtureFetch({ deviceId, available: false, events: [], restartCount10m: 0 }));
    wrapper = mount(DeviceFirmwareDiagnostics, { props: { deviceId, apiBase: '', accessToken: 'portal-test-token' } });
    await flushPromises();
    expect(wrapper.text()).toContain('No diagnostic snapshot is available.');
    expect(wrapper.text()).toContain('connectivity and measurement freshness are reported separately');
  });

  it('shows a recoverable diagnostics error without replacing connectivity or measurement state', async () => {
    setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    wrapper = mount(DeviceFirmwareDiagnostics, { props: { deviceId, apiBase: '', accessToken: 'portal-test-token' } });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('could not be loaded');
    expect(wrapper.text()).not.toContain('Findings recorded');
  });

  it('shows observer-relative failure beside the preserved device-reported snapshot', async () => {
    setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    vi.stubGlobal('fetch', fixtureFetch({
      deviceId,
      sampledAt: '2026-10-26T05:20:00.000Z',
      lastSuccessfulContactAt: '2026-10-26T05:20:00.000Z',
      lastAttemptAt: '2026-10-26T06:20:00.000Z',
      collectionStatus: 'failed',
      current: {
        firmwareVersion: '0.3.0', bootSessionId: 'esp8266-324b44-1234abcd', uptimeMs: 3_600_000,
        reset: { reason: 'Power On', reasonCode: 1, exception: null },
        memory: { freeHeapBytes: 7000, heapFragmentationPct: 12, largestFreeBlockBytes: 4000 },
        wifi: { connected: true, rssiDbm: -62, disconnectCount: 0, reconnectCount: 0 },
        sensor: { sampleCount: 20, readFailureCount: 0 },
      },
      snapshots: [{}], events: [], restartCount10m: 0, connectivity: 'connected',
      collectionFailures: [{
        id: 'failure-1', attemptedAt: '2026-10-26T06:20:00.000Z', reason: 'request_timeout',
        context: {
          observer: { id: 'Mac-LAB/darwin', host: 'Mac-LAB', platform: 'darwin', localScopes: [{ interfaceName: 'en0', cidr: '192.168.1.25/24', address: '192.168.1.25' }] },
          target: { endpoint: 'http://192.168.7.48', ipAddress: '192.168.7.48', networkScopeId: 'eero-lan', networkScopeName: 'Eero LAN' },
        },
      }],
    }, true));
    wrapper = mount(DeviceFirmwareDiagnostics, { props: { deviceId, apiBase: '', accessToken: 'portal-test-token' } });
    await flushPromises();
    await wrapper.get('.health-mode-control button:last-child').trigger('click');

    expect(wrapper.text()).toContain('last successful device snapshot is preserved');
    expect(wrapper.text()).toContain('does not show that the device lost power or Wi-Fi');
    expect(wrapper.text()).toContain('Device-reported Wi-Fi');
    expect(wrapper.text()).toContain('Connected');
    expect(wrapper.text()).toContain('Mac-LAB');
    expect(wrapper.text()).toContain('192.168.1.25/24');
    expect(wrapper.text()).toContain('192.168.7.48');
    expect(wrapper.text()).toContain('Eero LAN');
    expect(wrapper.text()).toContain('request_timeout');
  });

  it('shows the homeowner summary and Core-backed installer history with honest gaps and event provenance', async () => {
    setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    const fetchMock = fixtureFetch({ deviceId, sampledAt: new Date().toISOString(), lastSuccessfulContactAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(), collectionStatus: 'success', current: { firmwareVersion: '0.3.0', bootSessionId: 'boot-2', uptimeMs: 2_000,
        reset: { reason: 'Power on', reasonCode: 1, exception: null }, memory: { freeHeapBytes: 6_500, heapFragmentationPct: 18, largestFreeBlockBytes: 3_200 },
        wifi: { connected: true, rssiDbm: -55, disconnectCount: 1, reconnectCount: 1 }, sensor: { sampleCount: 100, readFailureCount: 0 } },
      events: [], collectionFailures: [], restartCount10m: 0, connectivity: 'connected' }, true);
    vi.stubGlobal('fetch', fetchMock);
    wrapper = mount(DeviceFirmwareDiagnostics, { props: { deviceId, apiBase: '', accessToken: 'portal-test-token' } });
    await flushPromises();

    expect(wrapper.text()).toContain('Last successful diagnostic contact');
    expect(wrapper.text()).toContain('Device-reported Wi-Fi');
    expect(wrapper.text()).toContain('Observer reachability');
    expect(wrapper.get('.health-home-summary > div:first-child strong').text()).toBe('1');
    expect(wrapper.get('.health-home-summary > div:first-child span').text()).toBe('communication problem in this period');
    await wrapper.get('.health-mode-control button:last-child').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Wi-Fi signal');
    expect(wrapper.text()).toContain('Min');
    expect(wrapper.text()).toContain('Max');
    expect(wrapper.text()).toContain('Avg');
    expect(wrapper.text()).toContain('No samples in range');
    expect(wrapper.text()).toContain('Estimated boot time');
    expect(wrapper.text()).toContain('not an exact reboot time');
    expect(wrapper.text()).toContain('Recovery was observed 30 min later');
    expect(wrapper.findAll('.health-point')).toHaveLength(2);

    await wrapper.get('.health-range-control button:first-child').trigger('click');
    await flushPromises();
    const rawRequest = fetchMock.mock.calls.map(call => call[0]).find(url => url.includes('/device-health/history') && url.includes('granularity=raw'));
    expect(rawRequest).toBeDefined();
    expect(wrapper.findAll('.health-point')).toHaveLength(2);
    expect(wrapper.findAll('.health-line')).toHaveLength(0);

    await wrapper.get('.health-range-control button:last-child').trigger('click');
    await flushPromises();
    expect(fetchMock.mock.calls.map(call => call[0]).some(url => url.includes('granularity=daily'))).toBe(true);
  });
});
