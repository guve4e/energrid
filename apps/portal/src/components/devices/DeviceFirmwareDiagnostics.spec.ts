import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedSession, setAuthenticatedSession } from '../../auth/auth-client';
import DeviceFirmwareDiagnostics from './DeviceFirmwareDiagnostics.vue';

const deviceId = 'device:upstream-lan:esp8266:324864';
let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  clearAuthenticatedSession(false);
  vi.unstubAllGlobals();
});

describe('device firmware diagnostics', () => {
  it('renders firmware health separately and explains confirmed and possible findings', async () => {
    setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
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
    }) });
    vi.stubGlobal('fetch', fetchMock);
    wrapper = mount(DeviceFirmwareDiagnostics, { props: { deviceId, apiBase: '', accessToken: 'portal-test-token' } });
    await flushPromises();
    expect(wrapper.text()).toContain('2m 0s');
    expect(wrapper.text()).toContain('Hardware Watchdog');
    expect(wrapper.text()).toContain('0.3.0');
    expect(wrapper.text()).toContain('52%');
    expect(wrapper.text()).toContain('3 / 2');
    expect(wrapper.text()).toContain('Restarts · last 10 min');
    expect(wrapper.text()).toContain('Connectivity');
    expect(wrapper.text()).toContain('Free heap');
    expect(wrapper.text()).toContain('Largest free block');
    expect(wrapper.text()).toContain('Boot session and reset evidence');
    expect(wrapper.text()).toContain('The firmware reports a watchdog reset.');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer portal-test-token');
  });

  it('shows the pre-flash unavailable state without implying a device failure', async () => {
    setAuthenticatedSession({ accessToken: 'portal-test-token', expiresIn: 900, user: { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ deviceId, available: false, events: [], restartCount10m: 0 }) }));
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
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
    }) }));
    wrapper = mount(DeviceFirmwareDiagnostics, { props: { deviceId, apiBase: '', accessToken: 'portal-test-token' } });
    await flushPromises();

    expect(wrapper.text()).toContain('last successful device snapshot is retained');
    expect(wrapper.text()).toContain('does not establish that the ESP lost power or Wi-Fi');
    expect(wrapper.text()).toContain('Wi-Fi connected');
    expect(wrapper.text()).toContain('Mac-LAB');
    expect(wrapper.text()).toContain('192.168.1.25/24');
    expect(wrapper.text()).toContain('192.168.7.48');
    expect(wrapper.text()).toContain('Eero LAN');
    expect(wrapper.text()).toContain('request_timeout');
  });
});
