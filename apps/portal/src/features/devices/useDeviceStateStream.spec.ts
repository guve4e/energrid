import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { PortalState } from '../../portal-state';
import { useDeviceStateStream } from './useDeviceStateStream';
import { testState } from './device-test-fixtures';

const outputChanged = {
  sequence: 1, tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'shellyplus1-001:switch:0',
  state: { values: { output: true }, observedAt: '2026-11-03T17:01:00Z', source: 'http', status: 'online' },
};

describe('device operational-state stream', () => {
  it('reconciles the snapshot before applying external device changes and closes on route exit', async () => {
    const state = ref<PortalState | null>(testState());
    const accessToken = ref('token-a');
    const activePage = ref('logs');
    const signals: AbortSignal[] = [];
    const requests = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/portal/state')) {
        return { ok: true, json: async () => testState() } as Response;
      }
      if (!url.endsWith('/portal/devices/state/events')) throw new Error('Unexpected endpoint');
      signals.push(options!.signal!);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `event: ready\ndata: ${JSON.stringify({ tenantId: 'tenant-a', siteId: 'site-a' })}\n\n` +
            `event: device-state-changed\ndata: ${JSON.stringify(outputChanged)}\n\n`,
          ));
          options!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      });
      return { ok: true, status: 200, body } as Response;
    });
    let stream!: ReturnType<typeof useDeviceStateStream>;
    const wrapper = mount(defineComponent({ setup() {
      stream = useDeviceStateStream({ apiBase: '/api', accessToken, activePage, state,
        request: requests as unknown as typeof import('../../auth/auth-client').authFetch });
      return () => h('div');
    } }));
    expect(requests).not.toHaveBeenCalled();
    activePage.value = 'devices';
    await nextTick();
    await vi.waitFor(() => expect(state.value?.devices?.[0].state.values.output).toBe(true));
    expect(stream.deviceStateStreamStatus.value).toBe('connected');
    expect(requests.mock.calls.some(call => call[0].endsWith('/portal/state'))).toBe(true);
    activePage.value = 'logs';
    await nextTick();
    expect(stream.deviceStateStreamStatus.value).toBe('idle');
    expect(signals).toHaveLength(1);
    // Ensures route departure aborts the previously opened stream.
    expect(signals[0].aborted).toBe(true);
    wrapper.unmount();
    await flushPromises();
  });

  it('never subscribes without a token and tears down on sign-out', async () => {
    const state = ref<PortalState | null>(testState());
    const accessToken = ref('');
    const activePage = ref('devices');
    const request = vi.fn();
    let stream!: ReturnType<typeof useDeviceStateStream>;
    const wrapper = mount(defineComponent({ setup() {
      stream = useDeviceStateStream({ apiBase: '/api', accessToken, activePage, state,
        request: request as unknown as typeof import('../../auth/auth-client').authFetch });
      return () => h('div');
    } }));
    await nextTick();
    expect(stream.deviceStateStreamStatus.value).toBe('idle');
    expect(request).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
