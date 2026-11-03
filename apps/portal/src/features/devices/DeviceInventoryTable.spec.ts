import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import DeviceInventoryTable from './DeviceInventoryTable.vue';
import { useDeviceInventory } from './useDeviceInventory';
import { useDeviceActions } from './useDeviceActions';
import { testDevice, testState } from './device-test-fixtures';

function harness() {
  const device = testDevice();
  const state = ref(testState([device]));
  const key = JSON.stringify([device.tenantId, device.siteId, device.id]);
  const enrolledDeviceKeys = ref(new Set([key]));
  const enrollmentStatuses = ref(new Map([[key, 'enrolled' as const]]));
  const lifecycleEnrollmentRecords = ref([]);
  const enrollmentError = ref('');
  const selectedExecutionTraceId = ref<string | null>(null);
  const deviceStateClock = ref(Date.parse('2026-11-03T17:01:00Z'));
  let inventory!: ReturnType<typeof useDeviceInventory>;
  let actions!: ReturnType<typeof useDeviceActions>;
  const wrapper = mount(defineComponent({ setup() {
    actions = useDeviceActions({ apiBase: '/api', accessToken: ref('token'), state,
      request: vi.fn() as unknown as typeof import('../../auth/auth-client').authFetch,
      onRefresh: async () => {}, onLog: () => {} });
    inventory = useDeviceInventory({ state, enrolledDeviceKeys, enrollmentStatuses,
      lifecycleEnrollmentRecords, enrollmentError, selectedExecutionTraceId,
      deviceStateClock, canUseDeviceControl: actions.canUseDeviceControl,
      confirmDiscardInstallationChanges: () => true, onRefresh: async () => {} });
    return () => h(DeviceInventoryTable, { inventory, actions });
  } }));
  return { wrapper, inventory };
}

describe('Devices inventory table', () => {
  it('renders the authorized physical component and delegates detail selection', async () => {
    const { wrapper, inventory } = harness();
    expect(wrapper.text()).toContain('Kitchen relay');
    expect(wrapper.findAll('.physical-device-component-row')).toHaveLength(1);
    await wrapper.get('.device-name-button').trigger('click');
    expect(inventory.selectedDeviceId.value).toBe('shellyplus1-001:switch:0');
    wrapper.unmount();
  });
  it('searches the enrolled inventory without mutating the network candidates', async () => {
    const { wrapper, inventory } = harness();
    await wrapper.get('input[aria-label="Search devices"]').setValue('unknown-item');
    expect(wrapper.text()).toContain('No devices match this filter');
    expect(inventory.discoveredDevices.value).toHaveLength(0);
    await wrapper.get('button.ghost:not(.icon-button)').trigger('click');
    await nextTick();
    expect(wrapper.findAll('.physical-device-component-row')).toHaveLength(1);
    wrapper.unmount();
  });
});
