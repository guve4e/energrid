import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DevicesPage from './DevicesPage.vue';

const dummyModel = {} as any;
function page(streamStatus: 'idle' | 'connected' = 'connected') {
  return mount(DevicesPage, {
    props: { inventory: dummyModel, actions: dummyModel, apiBase: '', accessToken: 'token',
      networkDevices: [], loadingState: false, streamStatus,
      deviceStateClock: Date.now(), stateError: '', discoveryDecisionBusy: {}, discoveryDecisionError: '' },
    global: { stubs: { DeviceInventoryTable: true, DeviceDetailsSheet: true } },
  });
}
describe('Devices page composition', () => {
  it('renders explicit SSE state and delegates refresh to the application', async () => {
    const wrapper = page();
    expect(wrapper.get('[data-status="connected"]').text()).toContain('connected');
    await wrapper.findAll('button').find(b => b.text() === 'Refresh')!.trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
    wrapper.unmount();
  });
  it('reports disconnected status without implying a reachable device', () => {
    const wrapper = page('idle');
    expect(wrapper.get('[data-status="idle"]').text()).toContain('not connected');
    wrapper.unmount();
  });
});
