import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceConnectionDiagnostics from './DeviceConnectionDiagnostics.vue';
import type { DeviceConnectionReport } from '@energrid/domain-devices';

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
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer unit-token' },
    });
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
      expect(page.get('[role="alert"]').text()).toContain(
        'state is still unknown',
      );
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
    expect(page.get('[role="alert"]').text()).toContain('could not finish');
  });
});
