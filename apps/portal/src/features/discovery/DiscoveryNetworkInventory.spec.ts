import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import DiscoveryNetworkInventory from './DiscoveryNetworkInventory.vue';
import type { DiscoveryMemoryResponse, NetworkDevice } from './discovery-contracts';
import { useDiscoveryInventoryUiState } from './useDiscoveryNetworkModel';

const shelly: NetworkDevice = {
  id: 'shelly-1', ipAddress: '172.30.250.3', networkZoneId: 'lab', networkZoneName: 'Virtual Lab',
  macAddress: '02:63:60:34:06:4d', vendor: 'Shelly', protocol: 'http', model: 'Plus 1',
  confidence: 1, status: 'online', discoveredAt: '2026-11-03T12:00:00Z', reason: 'RPC identity',
  observations: [{ source: 'tcp', attribute: 'port.22.open', value: true, observedAt: '2026-11-03T12:00:00Z' }],
};
const old: NetworkDevice = { ...shelly, id: 'esp-2', vendor: 'Espressif', macAddress: 'aa:bb:cc:dd:ee:ff',
  model: 'ESP8266', ipAddress: '172.30.250.10', status: 'online', observations: [] };
const memory: DiscoveryMemoryResponse = {
  summary: { lastScanId: '2026-11-01', known: 1, observedInLatestScan: 0, notObservedInLatestScan: 1 },
  devices: [{ schemaVersion: 1, identity: 'mac:aa:bb:cc:dd:ee:ff', device: old,
    firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-31T00:00:00Z', lastScanId: '2026-10-31' }],
};
const base = {
  liveNetworkDevices: [shelly], memory, memoryLoading: false, memoryError: '',
  networkZones: [{ id: 'lab', name: 'Virtual Lab', cidr: '172.30.250.0/28', seedIps: [] }],
  networkSnapshots: [], serverLabel: 'site brain', enrolledDevices: [],
  channelPhysicalIds: ['shelly-1'], aiInvestigating: {},
};

describe('Discovery network inventory', () => {
  it('shows live and historical devices without pretending remembered devices are online', () => {
    const wrapper = mount(DiscoveryNetworkInventory, { props: base });
    expect(wrapper.text()).toContain('2 found');
    expect(wrapper.text()).toContain('1 online in the last API scan');
    expect(wrapper.findAll('.network-discovery-card')).toHaveLength(2);
    expect(wrapper.text()).toContain('unknown');
    wrapper.unmount();
  });

  it('owns its search/filter and forwards review, channel, and investigation actions', async () => {
    const wrapper = mount(DiscoveryNetworkInventory, { props: base });
    await wrapper.findAll('button').find(button => button.text() === 'Shelly devices')!.trigger('click');
    expect(wrapper.findAll('.network-discovery-card')).toHaveLength(1);
    await wrapper.get('input[aria-label="Search network devices"]').setValue('esp-2');
    expect(wrapper.findAll('.network-discovery-card')).toHaveLength(1); // Search searches all sources
    await wrapper.get('.network-device-inspect button').trigger('click');
    expect(wrapper.emitted('review')?.[0]).toEqual(['esp-2']);
    await wrapper.get('input[aria-label="Search network devices"]').setValue('shelly-1');
    const buttons = wrapper.findAll('.network-discovery-card button');
    await buttons.find(button => button.text() === 'Review channels')!.trigger('click');
    await buttons.find(button => button.text() === 'Investigate with AI')!.trigger('click');
    expect(wrapper.emitted('channels')?.[0]).toEqual([shelly]);
    expect(wrapper.emitted('investigate')?.[0]).toEqual([shelly]);
    wrapper.unmount();
  });

  it('keeps refresh explicit and renders saved discovery history on request', async () => {
    const wrapper = mount(DiscoveryNetworkInventory, { props: base });
    expect(wrapper.find('.network-table-wrap').exists()).toBe(false);
    await wrapper.findAll('button').find(button => button.text() === 'Show history')!.trigger('click');
    expect(wrapper.text()).toContain('Not observed in latest scan');
    await wrapper.findAll('button').find(button => button.text() === 'Refresh memory')!.trigger('click');
    expect(wrapper.emitted('refreshMemory')).toHaveLength(1);
    wrapper.unmount();
  });

  it('restores search and filter preferences after navigating away and back', async () => {
    const uiState = useDiscoveryInventoryUiState();
    const first = mount(DiscoveryNetworkInventory, { props: { ...base, uiState } });
    await first.findAll('button').find(button => button.text() === 'Shelly devices')!.trigger('click');
    await first.get('input[aria-label="Search network devices"]').setValue('esp-2');
    first.unmount();
    const returned = mount(DiscoveryNetworkInventory, { props: { ...base, uiState } });
    expect(returned.get('input[aria-label="Search network devices"]').element).toHaveProperty('value', 'esp-2');
    expect(returned.findAll('.network-discovery-card')).toHaveLength(1);
    returned.unmount();
  });

  it('responds to a new site data set without retaining the previous site inventory', async () => {
    const wrapper = mount(DiscoveryNetworkInventory, { props: base });
    await wrapper.setProps({ liveNetworkDevices: [], memory: null, networkZones: [] });
    await nextTick();
    expect(wrapper.text()).toContain('No current or remembered endpoints');
    expect(wrapper.text()).not.toContain('172.30.250.3');
    wrapper.unmount();
  });
});
