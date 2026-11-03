import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceConnectionDiagnostics from './DeviceConnectionDiagnostics.vue';
import type { DeviceConnectionReport } from '@energrid/domain-devices';
import { setAuthenticatedSession } from '../../auth/auth-client';

const device = {
  id: 'shelly:switch:0',
  kind: 'physical',
  trustStatus: 'approved',
  capabilities: [{ actions: ['turn_on', 'turn_off'] }],
  adapter: { protocol: 'http', driver: 'shelly-lan' },
};
const result: DeviceConnectionReport = {
  deviceId: device.id,
  checkedAt: '2026-10-13T08:00:00Z',
  readOnly: true,
  code: 'mqtt-disabled',
  title: 'Device reachable, but MQTT is disabled',
  summary: 'The Shelly answers over HTTP.',
  nextAction: 'Enable MQTT or deliberately configure HTTP control.',
  currentRelay: { on: false, checkedAt: '2026-10-13T08:00:00Z' },
  lastCommand: {
    action: 'turn_on',
    outcome: 'timed_out',
    requestedAt: '2026-10-13T07:00:00Z',
    publishedAt: '2026-10-13T07:00:01Z',
    completedAt: '2026-10-13T07:00:05Z',
  },
  checks: [
    {
      id: 'identity',
      label: 'Device over HTTP',
      status: 'passed',
      detail: 'The expected Shelly answered.',
      checkedAt: '2026-10-13T08:00:00Z',
    },
  ],
};
let page: ReturnType<typeof mount>;
let fetchMock: ReturnType<typeof vi.fn>;
function setup(overrides = {}) {
  page = mount(DeviceConnectionDiagnostics, {
    props: {
      device: { ...device, ...overrides },
      apiBase: '/api',
      accessToken: 'unit-token',
    },
  });
  return page;
}
beforeEach(() => {
  setAuthenticatedSession({ accessToken: 'unit-token', expiresIn: 900, user: { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'admin' } });
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => structuredClone(result) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  page?.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connection diagnostic UI', () => {
  it('does not probe automatically or perform an action/configuration request', async () => {
    setup();
    expect(page.text()).toContain('Not checked');
    expect(fetchMock).not.toHaveBeenCalled();
    await page.get('button').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/portal/devices/shelly%3Aswitch%3A0/diagnostics',
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer unit-token');
    expect(page.text()).toContain('MQTT is disabled');
    expect(page.text()).toContain('Next step');
    expect(page.text()).toContain('Relay at check time: Off');
    expect(page.text()).toContain('Not confirmed');
    expect(page.get('details summary').text()).toContain('Evidence');
  });
  it.each([
    { trustStatus: 'discovered' },
    { trustStatus: 'blocked' },
    { kind: 'logical' },
    { adapter: { protocol: 'simulated', driver: 'simulated-switch' } },
  ])('does not offer live diagnostics for %j', (overrides) => {
    setup(overrides);
    expect(page.find('button').exists()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('blocks duplicate clicks during a check', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    setup();
    await page.get('button').trigger('click');
    await page.get('button').trigger('click');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.get('button').attributes('disabled')).toBeDefined();
  });
  it('keeps a shared-topic warning visible without expanding technical evidence', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...result,
        checks: [
          ...result.checks,
          {
            id: 'shared-topic',
            label: 'Shared topic',
            status: 'warning',
            detail: 'Another physical device uses this command topic.',
            checkedAt: result.checkedAt,
          },
        ],
      }),
    });
    setup();
    await page.get('button').trigger('click');
    await flushPromises();
    expect(page.get('.device-diagnostic-routing-warning').text()).toContain(
      'Before switching',
    );
    expect(page.get('.device-diagnostic-routing-warning').text()).toContain(
      'Another physical device',
    );
  });
  it.each([
    { ok: false },
    {
      ok: true,
      json: async () => {
        throw new Error('upstream-secret');
      },
    },
    { ok: true, json: async () => ({ ...result, deviceId: 'other' }) },
    { ok: true, json: async () => ({ ...result, readOnly: false }) },
    { ok: true, json: async () => ({}) },
  ])(
    'explains incomplete checks without exposing raw errors or saying offline',
    async (response) => {
      fetchMock.mockResolvedValue(response);
      setup();
      await page.get('button').trigger('click');
      await flushPromises();
      expect(page.find('[role="alert"]').exists()).toBe(true);
      expect(page.find('[role="alert"]').text().toLowerCase()).not.toContain('offline');
      expect(page.text()).not.toContain('upstream-secret');
      expect(page.get('button').attributes('disabled')).toBeUndefined();
    },
  );
  it('ignores a late response when the selected device changes and aborts the old request', async () => {
    let resolve!: (r: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    setup();
    await page.get('button').trigger('click');
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await page.setProps({ device: { ...device, id: 'other' } });
    expect(signal.aborted).toBe(true);
    resolve({ ok: true, json: async () => result });
    await flushPromises();
    expect(page.find('.device-diagnostic-result').exists()).toBe(false);
    expect(page.text()).toContain('Not checked');
  });
  it('unlocks an HTTP route only when the read-only report verifies the exact identity', async () => {
    const httpDevice = {
      ...device,
      control: {
        status: 'ready' as const,
        reason: 'Configured',
        binding: {
          kind: 'shelly-http' as const,
          enabled: true,
          physicalId: 'shellyplus1-78ee4ccf4b54',
          channel: 0,
          baseUrl: 'http://192.168.7.21',
        },
      },
    };
    setup(httpDevice);
    await page.get('button').trigger('click');
    await flushPromises();
    expect(page.emitted('identity-verification')?.at(-1)?.[0]).toEqual({
      deviceId: device.id,
      route: 'http://192.168.7.21',
      verified: true,
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...result,
        checks: [{ ...result.checks[0], status: 'failed', detail: 'Different Shelly.' }],
      }),
    });
    await page.get('button').trigger('click');
    await flushPromises();
    expect(page.emitted('identity-verification')?.at(-1)?.[0]).toEqual({
      deviceId: device.id,
      route: 'http://192.168.7.21',
      verified: false,
    });
  });
  it('unlocks a site-local HTTP route only after a successful authorized remote status observation', async () => {
    const remoteDevice = {
      ...device, tenantId: 'tenant-demo', siteId: 'site-home',
      metadata: { physicalId: 'shellyplus1-8813bfcdc8bc', component: 'switch:0', channel: 0 },
      control: { status: 'ready' as const, reason: 'Permission enabled.', binding: {
        kind: 'shelly-http' as const, enabled: true, physicalId: 'shellyplus1-8813bfcdc8bc',
        channel: 0, baseUrl: 'http://192.168.1.219',
      } },
    }
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ deviceId: remoteDevice.id, component: 'switch:0',
      output: true, observedAt: new Date().toISOString(), observer: { id: 'pi-upstream-bathroom', host: 'pi' } }) })
    setup(remoteDevice)
    await page.get('.shelly-read-status button').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/portal/devices/shelly%3Aswitch%3A0/observe-shelly-status')
    expect(page.emitted('identity-verification')?.at(-1)?.[0]).toEqual({
      deviceId: remoteDevice.id, tenantId: 'tenant-demo', siteId: 'site-home', route: 'http://192.168.1.219', verified: true,
    })
    expect(page.text()).toContain('On')
  })
  it('shows a scoped authorization failure without exposing server details', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'scope details with internal data' }),
    });
    setup();
    await page.get('button').trigger('click');
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('selected site');
    expect(page.get('[role="alert"]').text()).not.toContain('internal data');
  });
  it('invalidates a result when the control route changes', async () => {
    setup();
    await page.get('button').trigger('click');
    await flushPromises();
    await page.setProps({
      device: {
        ...device,
        control: { status: 'disabled', reason: '', binding: null },
      },
    });
    expect(page.find('.device-diagnostic-result').exists()).toBe(false);
  });
  it('marks a completed check as an earlier snapshot instead of pretending it stays live', async () => {
    vi.useFakeTimers();
    setup();
    await page.get('button').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60001);
    expect(page.text()).toContain('Earlier snapshot');
    expect(page.text()).toContain('over a minute old');
  });
  it('aborts a hung check after the bounded deadline', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    );
    setup();
    await page.get('button').trigger('click');
    await vi.advanceTimersByTimeAsync(25001);
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('timed out after 25 seconds');
  });

  it('performs one authenticated read-only status request for an approved Shelly switch and displays its provenance', async () => {
    const observedAt = '2026-10-31T20:00:00.000Z';
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      deviceId: 'shellyplus1-00c0de000002:switch:0', component: 'switch:0', output: true,
      observedAt, source: 'site-local-http-rpc:virtual-observer',
      observer: { id: 'virtual-observer', host: '192.168.1.138' },
    }) });
    setup({ id: 'shellyplus1-00c0de000002:switch:0', kind: 'physical', metadata: { component: 'switch:0' } });

    const statusButton = page.findAll('button').find(button => button.text().includes('Read status once'))!;
    await statusButton.trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/portal/devices/shellyplus1-00c0de000002%3Aswitch%3A0/observe-shelly-status');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(page.text()).toContain('Switch 1 was On');
    expect(page.text()).toContain('virtual-observer (192.168.1.138)');
    expect(page.emitted('status-observed')).toHaveLength(1);
  });

  it('offers the read-only status action for an approved discovered Shelly switch profile', () => {
    setup({
      id: 'shellypro2pm-ec6260888084:switch:0',
      kind: 'physical',
      metadata: { component: 'switch:0' },
      adapter: { protocol: 'mqtt', driver: 'shelly-discovered' },
    });
    expect(page.text()).toContain('Read status once');
  });

  it('shows the API reason when authorized read-only status verification is rejected', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({
      message: 'The reconciled endpoint evidence belongs to a different observer.',
    }) });
    setup({
      id: 'shellypro2pm-ec6260888084:switch:0',
      kind: 'physical', metadata: { component: 'switch:0' },
      adapter: { protocol: 'mqtt', driver: 'shelly-discovered' },
    });
    await page.findAll('button').find(button => button.text().includes('Read status once'))!.trigger('click');
    await flushPromises();
    expect(page.text()).toContain('belongs to a different observer');
    expect(page.text()).toContain('No device command was sent');
  });

  it('reads and labels the selected second Shelly channel without changing the operation', async () => {
    const observedAt = '2026-10-31T20:00:00.000Z';
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      deviceId: 'shellypro2pm-ec6260888084:switch:1', component: 'switch:1', output: false,
      observedAt, source: 'site-local-http-rpc:mac-eero-en0',
      observer: { id: 'mac-eero-en0', host: 'mac.local' },
    }) });
    setup({
      id: 'shellypro2pm-ec6260888084:switch:1', kind: 'physical',
      metadata: { component: 'switch:1' },
      adapter: { protocol: 'mqtt', driver: 'shelly-discovered' },
    });

    expect(page.text()).toContain('One read-only Switch 2 status request');
    await page.findAll('button').find(button => button.text().includes('Read status once'))!.trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/shellypro2pm-ec6260888084%3Aswitch%3A1/observe-shelly-status');
    expect(page.text()).toContain('Switch 2 was Off');
    expect(page.emitted('status-observed')).toHaveLength(1);
  });

  it.each([
    { trustStatus: 'discovered', metadata: { component: 'switch:0' } },
    { kind: 'logical', metadata: { component: 'switch:0' } },
    { adapter: { protocol: 'http', driver: 'http-json-sensor' }, metadata: { component: 'switch:0' } },
    { metadata: { component: 'em1:0' } },
    { adapter: { protocol: 'http', driver: 'http-json-sensor' }, metadata: { component: 'switch:1' } },
  ])('does not offer a Shelly status request when the approved physical Shelly boundary is absent (%j)', overrides => {
    setup(overrides);
    expect(page.text()).not.toContain('Read status once');
  });
});
