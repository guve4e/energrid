import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import type { PortalState } from '../../portal-state';
import { useDeviceActions } from './useDeviceActions';
import { testDevice, testState } from './device-test-fixtures';

function response(body: object, ok = true): Response {
  return { ok, status: ok ? 200 : 403, json: async () => body } as Response;
}
function harness(requestImpl: (url: string, init: RequestInit) => Promise<Response> = async () => response({ status: 'acked' })) {
  const accessToken = ref('token-a');
  const state = ref<PortalState | null>(testState());
  const request = vi.fn(requestImpl);
  const onRefresh = vi.fn(async () => {});
  const onLog = vi.fn();
  let model!: ReturnType<typeof useDeviceActions>;
  const wrapper = mount(defineComponent({
    setup() {
      model = useDeviceActions({ apiBase: '/api', accessToken, state, onRefresh, onLog,
        request: request as unknown as typeof import('../../auth/auth-client').authFetch });
      return () => h('div');
    },
  }));
  return { model, wrapper, request, accessToken, state, onRefresh, onLog };
}
afterEach(() => vi.restoreAllMocks());

describe('authorized device commands', () => {
  it('never invokes a device action for an unapproved or disabled device', async () => {
    const h = harness();
    const unapproved = testDevice({ trustStatus: 'discovered' });
    await h.model.sendDeviceAction(unapproved, 'turn_on');
    await h.model.sendDeviceAction(testDevice({ siteId: 'other-site' }), 'turn_on');
    await h.model.sendDeviceAction(testDevice({ control: { status: 'disabled', binding: null, reason: 'Denied' } }), 'turn_on');
    expect(h.request).not.toHaveBeenCalled();
    h.wrapper.unmount();
  });
  it('posts the exact approved action without optimistically changing observed state', async () => {
    const h = harness();
    const before = h.state.value!.devices![0].state.values.output;
    await h.model.sendDeviceAction(h.state.value!.devices![0], 'turn_on');
    expect(h.request).toHaveBeenCalledWith('/api/portal/devices/shellyplus1-001%3Aswitch%3A0/actions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'turn_on' }) }));
    expect(h.state.value!.devices![0].state.values.output).toBe(before);
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
    expect(h.model.deviceActionBusy.value).toEqual({});
    h.wrapper.unmount();
  });
  it('allows a direct HTTP route only after explicit identity verification', () => {
    const h = harness();
    const device = testDevice({ control: { status: 'ready', binding: {
      kind: 'shelly-http', enabled: true, physicalId: 'shellyplus1-001', channel: 0,
      baseUrl: 'http://172.30.250.3' }, reason: 'Ready' } });
    expect(h.model.canUseDeviceControl(device)).toBe(false);
    h.model.updateHttpIdentityVerification({ deviceId: device.id, route: 'http://172.30.250.3', verified: true });
    expect(h.model.canUseDeviceControl(device)).toBe(true);
    h.wrapper.unmount();
  });
  it('prevents duplicate in-flight dispatch and reports rejected commands without faking success', async () => {
    let release!: (value: Response) => void;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const device = h.state.value!.devices![0];
    const pending = h.model.sendDeviceAction(device, 'turn_on');
    await h.model.sendDeviceAction(device, 'turn_off');
    expect(h.request).toHaveBeenCalledTimes(1);
    release(response({ message: 'Permission denied' }, false));
    await pending;
    expect(h.model.deviceActionError.value[device.id]).toBe('Permission denied');
    expect(h.onRefresh).not.toHaveBeenCalled();
    h.wrapper.unmount();
  });
  it('does not apply the old site command result to the new site', async () => {
    let release!: (value: Response) => void;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const pending = h.model.sendDeviceAction(h.state.value!.devices![0], 'turn_on');
    h.state.value = testState([], 'site-b');
    await nextTick();
    release(response({ status: 'acked' }));
    await pending;
    expect(h.model.deviceActionBusy.value).toEqual({});
    expect(h.onRefresh).not.toHaveBeenCalled();
    h.wrapper.unmount();
  });
});
