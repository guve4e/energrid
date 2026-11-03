import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import DeviceDetailsSheet from './DeviceDetailsSheet.vue';
import { useDeviceInventory } from './useDeviceInventory';
import { useDeviceActions } from './useDeviceActions';
import { testDevice, testState } from './device-test-fixtures';

function harness(trustStatus: 'approved' | 'discovered') {
  const device = testDevice({ trustStatus });
  const state = ref(testState([device]));
  const selectedExecutionTraceId = ref<string | null>(null);
  let inventory!: ReturnType<typeof useDeviceInventory>;
  let actions!: ReturnType<typeof useDeviceActions>;
  const wrapper = mount(defineComponent({ setup() {
    actions = useDeviceActions({ apiBase: '/api', accessToken: ref('token'), state,
      request: vi.fn() as unknown as typeof import('../../auth/auth-client').authFetch,
      onRefresh: async () => {}, onLog: () => {} });
    inventory = useDeviceInventory({ state, enrolledDeviceKeys: ref(new Set<string>()),
      enrollmentStatuses: ref(new Map()), lifecycleEnrollmentRecords: ref([]), enrollmentError: ref(''),
      selectedExecutionTraceId, deviceStateClock: ref(Date.parse('2026-11-03T17:01:00Z')),
      canUseDeviceControl: actions.canUseDeviceControl,
      confirmDiscardInstallationChanges: () => true, onRefresh: async () => {} });
    inventory.selectedDeviceId.value = device.id;
    return () => h(DeviceDetailsSheet, { inventory, actions, apiBase: '', accessToken: 'token',
      networkDevices: [], deviceStateClock: Date.parse('2026-11-03T17:01:00Z'),
      stateError: '', discoveryDecisionBusy: {}, discoveryDecisionError: '' });
  } }), { global: { stubs: {
    DeviceCapabilityDetails: true, DeviceNetworkIdentityPanel: true,
    DeviceFirmwareDiagnostics: true, DeviceConnectionDiagnostics: true,
    DeviceControlSetup: true, DeviceCommissioning: true,
  } } });
  return { wrapper, inventory };
}

describe('Devices details sheet', () => {
  it('does not approve an untrusted device on render and delegates explicit operator review', async () => {
    const { wrapper } = harness('discovered');
    expect(wrapper.get('[aria-label="Device details"]').text()).toContain('Approval required');
    expect(wrapper.findComponent(DeviceDetailsSheet).emitted('approve')).toBeUndefined();
    await wrapper.findAll('button').find(b => b.text() === 'Approve device')!.trigger('click');
    expect(wrapper.findComponent(DeviceDetailsSheet).emitted('approve')).toHaveLength(1);
    wrapper.unmount();
  });
  it('closes selected details without deleting inventory or issuing commands', async () => {
    const { wrapper, inventory } = harness('approved');
    await wrapper.get('[aria-label="Close device details"]').trigger('click');
    expect(inventory.selectedDeviceId.value).toBe(null);
    expect(inventory.deviceCards.value).toHaveLength(1);
    wrapper.unmount();
  });
});
