import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useDeviceInventory } from './useDeviceInventory';
import { testDevice, testState } from './device-test-fixtures';

function harness(allowSelection = true) {
  const device = testDevice();
  const state = ref(testState([device, testDevice({ id: 'candidate', trustStatus: 'discovered' })]));
  const enrolledDeviceKeys = ref(new Set([JSON.stringify([device.tenantId, device.siteId, device.id])]));
  const enrollmentStatuses = ref(new Map([[JSON.stringify([device.tenantId, device.siteId, device.id]), 'enrolled' as const]]));
  const lifecycleEnrollmentRecords = ref([]);
  const enrollmentError = ref('');
  const deviceStateClock = ref(Date.parse('2026-11-03T17:00:30.000Z'));
  const selectedExecutionTraceId = ref<string | null>('trace-1');
  const confirmDiscardInstallationChanges = vi.fn(() => allowSelection);
  let model!: ReturnType<typeof useDeviceInventory>;
  const wrapper = mount(defineComponent({
    setup() {
      model = useDeviceInventory({ state, enrolledDeviceKeys, enrollmentStatuses,
        lifecycleEnrollmentRecords, enrollmentError, deviceStateClock, selectedExecutionTraceId,
        canUseDeviceControl: () => true, confirmDiscardInstallationChanges,
        onRefresh: async () => {} });
      return () => h('div');
    },
  }));
  return { model, wrapper, state, enrolledDeviceKeys, deviceStateClock,
    selectedExecutionTraceId, confirmDiscardInstallationChanges };
}

describe('Devices inventory ownership', () => {
  it('separates discovered candidates from enrolled inventory', () => {
    const h = harness();
    expect(h.model.enrolledInventoryDevices.value.map(d => d.id)).toEqual(['shellyplus1-001:switch:0']);
    expect(h.model.discoveredDevices.value.map(d => d.id)).toEqual(['candidate']);
    expect(h.model.inventoryDeviceSummary.value.components).toBe(1);
    h.wrapper.unmount();
  });
  it('owns filters and clear behavior instead of mutating the app shell', () => {
    const h = harness();
    h.model.deviceSearch.value = 'nonexistent';
    expect(h.model.filteredInventoryDevices.value).toHaveLength(0);
    h.model.clearInventoryFilters();
    expect(h.model.filteredInventoryDevices.value).toHaveLength(1);
    h.wrapper.unmount();
  });
  it('honors unsaved installation changes before selecting a device', () => {
    const h = harness(false);
    h.model.selectDevice(h.state.value.devices![0]);
    expect(h.model.selectedDeviceId.value).toBe(null);
    expect(h.confirmDiscardInstallationChanges).toHaveBeenCalled();
    h.wrapper.unmount();
  });
  it('never treats an old observation as current connectivity evidence', () => {
    const h = harness();
    h.deviceStateClock.value = Date.parse('2026-11-10T12:00:00.000Z');
    expect(h.model.deviceObservedStatus(h.state.value.devices![0])).toContain('Stale');
    h.wrapper.unmount();
  });
  it('limits selected device details to devices in the current snapshot', () => {
    const h = harness();
    h.model.selectedDeviceId.value = h.state.value.devices![0].id;
    expect(h.model.selectedDevice.value?.displayName).toBe('Kitchen relay');
    h.state.value = testState([]);
    expect(h.model.selectedDevice.value).toBe(null);
    h.wrapper.unmount();
  });
});
