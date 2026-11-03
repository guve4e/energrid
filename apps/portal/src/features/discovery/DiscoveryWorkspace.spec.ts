import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import DiscoveryWorkspace from './DiscoveryWorkspace.vue';

describe('Discovery feature route composition', () => {
  it('preserves one shared feature state when switching between Inbox and Network Intelligence', async () => {
    const snapshots = ref([{ scanId: 'remembered-1' }]);
    const model = {
      state: ref({ networkZones: [], zones: [] }), stateError: ref(''), serverLabel: ref('Lab'),
      discoveredDevices: ref([]), approvedOnboardingDevices: ref([]), pendingEnrollmentCards: ref([]),
      networkSnapshots: snapshots, latestNetworkSnapshot: ref(null), networkSnapshotComparison: ref(null),
      networkSnapshotsError: ref(''), nmapCapability: ref(null), networkRuntime: ref(null),
      networkEndpointLifecycle: ref([]), enrolledPhysicalDeviceCount: ref(0), enrollmentError: ref(''),
      verifiedEnrolledNetworkDevices: ref([]), deviceChannelPhysicalIds: ref([]),
      scanningNetwork: ref(false), scanElapsedSeconds: ref(0), scanFeedback: ref(''), scanError: ref(''),
      discoveryMemory: ref(null), discoveryMemoryLoading: ref(false), discoveryMemoryError: ref(''),
      liveNetworkDevices: ref([]), aiInvestigating: ref({}), discoveryInventoryUiState: {},
      selectedAiDeviceId: ref(null), deviceIntelligencePanel: ref(null),
      networkEndpointInvestigations: ref({}), networkEndpointHttpProbes: ref({}),
      networkEndpointIdentityRefreshes: ref({}), siteLocalEvidenceImport: ref(null),
      siteLocalEvidenceImportBusy: ref(false), siteLocalEvidenceImportError: ref(''),
      onboardingNetworkEndpoint: ref(false),
      scanNetwork: vi.fn(), cancelNetworkScan: vi.fn(), loadDiscoveryMemory: vi.fn(),
      openPendingEnrollment: vi.fn(), openEnrolledDevice: vi.fn(), openDeviceIntelligenceOnly: vi.fn(),
      investigateNetworkDeviceWithAi: vi.fn(), reviewNetworkDevice: vi.fn(),
      onLog: vi.fn(), startNetworkEndpointOnboarding: vi.fn(), investigateSnapshotEndpoint: vi.fn(),
      probeSnapshotEndpoint: vi.fn(), refreshSnapshotEndpointIdentity: vi.fn(),
      reviewSavedSiteLocalShellyEvidence: vi.fn(), importSiteLocalShellyEvidence: vi.fn(),
      reconcileSiteLocalShellyEvidence: vi.fn(), intelligenceModel: {},
    };
    const wrapper = mount(DiscoveryWorkspace, {
      props: { mode: 'discovery', model: model as any },
      global: { stubs: { DiscoveryNetworkInventory: true, DiscoveryOnboarding: true,
        DeviceIntelligencePanel: true, NetworkIntelligencePanel: true } },
    });
    expect(wrapper.text()).toContain('Discovery inbox');
    await wrapper.setProps({ mode: 'network-intelligence' });
    expect(wrapper.find('.network-intelligence-workspace').exists()).toBe(true);
    expect(snapshots.value[0].scanId).toBe('remembered-1');
    await wrapper.setProps({ mode: 'discovery' });
    expect(wrapper.text()).toContain('Discovery inbox');
    wrapper.unmount();
  });
});
