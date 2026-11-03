import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from 'vue';
import { buildPendingEnrollmentCards } from '../../components/discovery/pending-enrollment';
import { resolveNetworkSnapshotLifecycles, type LifecycleDeviceRecord } from '../../components/discovery/network-endpoint-lifecycle';
import type { DiscoveryNetworkZone, NetworkDevice } from './discovery-contracts';
import type { PortalState, PortalDevice, NetworkSnapshot, NetworkSnapshotDiff } from '../../portal-state';
import { useDiscoveryMemory } from './useDiscoveryMemory';
import { useDiscoveryNetworkModel, useDiscoveryInventoryUiState } from './useDiscoveryNetworkModel';
import { useDiscoveryScan } from './useDiscoveryScan';
import { useDiscoveryIntelligence } from './useDiscoveryIntelligence';
import { useDiscoverySnapshots } from './useDiscoverySnapshots';
import { useDiscoveryEndpointActions } from './useDiscoveryEndpointActions';
import type { useDiscoveryDecisions } from './useDiscoveryDecisions';

/** Persistent site-scoped Discovery workspace, shared by Inbox and Network Intelligence routes. */
export function useDiscoveryWorkspace(deps: {
  apiBase: string;
  token: Ref<string>;
  state: Ref<PortalState | null>;
  stateError: Ref<string>;
  serverLabel: ComputedRef<string>;
  deviceCards: ComputedRef<PortalDevice[]>;
  approvedDevices: ComputedRef<PortalDevice[]>;
  discoveredDevices: ComputedRef<PortalDevice[]>;
  enrolledInventoryDevices: ComputedRef<PortalDevice[]>;
  enrolledDeviceKeys: Ref<Set<string>>;
  lifecycleEnrollmentRecords: Ref<LifecycleDeviceRecord[]>;
  enrollmentError: Ref<string>;
  decisions: ReturnType<typeof useDiscoveryDecisions>;
  loadState: () => Promise<void>;
  setActivePage: (page: string) => void;
  openPendingEnrollment: (id?: string) => void;
  openEnrolledDevice: (id: string) => void;
  openApprovedDevice: (device: PortalDevice) => void;
  reviewNetworkDevice: (device: NetworkDevice) => Promise<void>;
  onLog: (message: string) => void;
}) {
  const apiBase = deps.apiBase;
  const accessToken = deps.token;
  const state = deps.state;
  const stateError = deps.stateError;
  const serverLabel = deps.serverLabel;
  const deviceCards = deps.deviceCards;
  const approvedDevices = deps.approvedDevices;
  const discoveredDevices = deps.discoveredDevices;
  const enrolledInventoryDevices = deps.enrolledInventoryDevices;
  const enrolledDeviceKeys = deps.enrolledDeviceKeys;
  const lifecycleEnrollmentRecords = deps.lifecycleEnrollmentRecords;
  const enrollmentError = deps.enrollmentError;
  const loadState = deps.loadState;
  const appendLog = deps.onLog;
  const { applyDiscoveryDecision, verifyPendingShelly, discoveryDecisionBusy,
    shellyVerificationMessages, discoveryDecisionError } = deps.decisions;
  const setActivePage = deps.setActivePage;
const pendingEnrollmentNow = ref(Date.now());

const pendingEnrollmentFreshnessTimer = window.setInterval(() => {
  pendingEnrollmentNow.value = Date.now();
}, 1_000);

const { networkSnapshots, latestNetworkSnapshot, networkSnapshotComparison,
  networkSnapshotsError, nmapCapability, networkRuntime, loadNetworkSnapshots } =
  useDiscoverySnapshots({
    apiBase, token: accessToken,
    siteScope: () => state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null,
  });

const pendingEnrollmentCards = computed(() => buildPendingEnrollmentCards(
  discoveredDevices.value,
  state.value?.pendingDeviceIdentities ?? {},
  pendingEnrollmentNow.value,
));

const approvedOnboardingDevices = computed(() =>
  approvedDevices.value
    .filter((device) => device.metadata?.approvedFromDiscovery === true)
    .sort((left, right) => left.displayName.localeCompare(right.displayName)),
);

const enrolledPhysicalDeviceCount = computed(() => new Set(
  enrolledInventoryDevices.value.map(device => {
    const physicalId = [device.metadata?.physicalId, device.metadata?.hardwareId]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return `${device.tenantId}:${device.siteId}:${(physicalId || device.id).toLowerCase()}`;
  }),
).size);

const networkEndpointLifecycle = computed(() => resolveNetworkSnapshotLifecycles(
  networkSnapshots.value,
  pendingEnrollmentCards.value,
  lifecycleEnrollmentRecords.value,
  approvedDevices.value,
));

const networkZones = computed(() => state.value?.networkZones || []);

const { discoveryMemory, discoveryMemoryLoading, discoveryMemoryError, loadDiscoveryMemory } =
  useDiscoveryMemory(apiBase, accessToken, () => state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null);

const liveNetworkDevices = computed(() => state.value?.networkDevices || []);

const { networkDevices } = useDiscoveryNetworkModel(liveNetworkDevices, discoveryMemory, networkSnapshots);

const discoveryInventoryUiState = useDiscoveryInventoryUiState();

const verifiedEnrolledNetworkDevices = computed(() =>
  approvedDevices.value.filter(candidate =>
    enrolledDeviceKeys.value.has(JSON.stringify([candidate.tenantId, candidate.siteId, candidate.id])),
  ),
);

const deviceChannelPhysicalIds = computed(() =>
  deviceCards.value.map(candidate => candidate.metadata?.physicalId).filter((id): id is string => typeof id === 'string'),
);

function applyPendingDecision(candidateId: string, action: 'approve' | 'block', zoneId?: string) {
  const device = discoveredDevices.value.find(candidate => candidate.id === candidateId);
  if (device) void applyDiscoveryDecision(device, action, zoneId);
}

function logDiscoveryDecision(device: PortalDevice, action: string) {
  appendLog(`[discovery] ${action} requested for ${device.displayName}`);
}

function renamePendingCandidate(candidateId: string) {
  const device = discoveredDevices.value.find(candidate => candidate.id === candidateId);
  if (device) logDiscoveryDecision(device, 'rename');
}

const { scanningNetwork, scanElapsedSeconds, scanFeedback, scanError, scanNetwork, cancelNetworkScan } =
  useDiscoveryScan<NetworkSnapshot, NetworkSnapshotDiff>({
    apiBase,
    token: accessToken,
    siteScope: () => state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null,
    scopes: () => state.value?.networkZones || [],
    onLog: appendLog,
    onScanned: async (result, isCurrent) => {
      if (!isCurrent()) return;
      if (state.value) state.value = {
        ...state.value,
        networkZones: result.zones || state.value.networkZones,
        networkDevices: result.devices,
      };
      latestNetworkSnapshot.value = result.snapshot;
      networkSnapshotComparison.value = result.comparison;
      networkSnapshots.value = [result.snapshot, ...networkSnapshots.value.filter(snapshot => snapshot.scanId !== result.snapshot.scanId)];
      await loadState();
      if (!isCurrent()) return;
      await loadDiscoveryMemory();
      if (!isCurrent()) return;
      // Reload saved snapshot projections so existing enrollments appear in review.
      await loadNetworkSnapshots();
    },
  });

async function refreshDiscovery() {
  await loadState();
  await loadDiscoveryMemory();
  await loadNetworkSnapshots();
}

async function refreshNetworkIntelligence() {
  await loadState();
  if (!accessToken.value || !state.value) return;
  await loadNetworkSnapshots();
}
  const intelligence = useDiscoveryIntelligence({
    apiBase, accessToken, networkDevices, siteScope: () => state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null,
  });
  const endpointActions = useDiscoveryEndpointActions({
    apiBase, accessToken, stateError, loadState, loadNetworkSnapshots,
    siteScope: () => state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null,
    navigateToDiscovery: () => deps.setActivePage('discovery'),
    loadLlmProviderAvailability: intelligence.loadLlmProviderAvailability,
    confirmCloudEvidence: intelligence.confirmCloudEvidence,
  });
  onBeforeUnmount(() => window.clearInterval(pendingEnrollmentFreshnessTimer));
  return {
    state, stateError, serverLabel, discoveredDevices, approvedOnboardingDevices,
    pendingEnrollmentCards, networkZones, networkSnapshots, latestNetworkSnapshot,
    networkSnapshotComparison, networkSnapshotsError, nmapCapability, networkRuntime,
    networkEndpointLifecycle, enrolledPhysicalDeviceCount, enrollmentError,
    verifiedEnrolledNetworkDevices, deviceChannelPhysicalIds,
    scanningNetwork, scanElapsedSeconds, scanFeedback, scanError, scanNetwork, cancelNetworkScan,
    discoveryMemory, discoveryMemoryLoading, discoveryMemoryError, loadDiscoveryMemory,
    liveNetworkDevices, networkDevices, discoveryInventoryUiState, loadNetworkSnapshots,
    refreshDiscovery, refreshNetworkIntelligence, applyPendingDecision,
    renamePendingCandidate, verifyPendingShelly, discoveryDecisionBusy,
    shellyVerificationMessages, discoveryDecisionError,
    openPendingEnrollment: deps.openPendingEnrollment,
    openEnrolledDevice: deps.openEnrolledDevice,
    openApprovedDevice: deps.openApprovedDevice,
    reviewNetworkDevice: deps.reviewNetworkDevice,
    onLog: deps.onLog,
    intelligenceModel: intelligence,
    ...intelligence,
    ...endpointActions,
  };
}
