<script setup lang="ts">
import DiscoveryNetworkInventory from './DiscoveryNetworkInventory.vue';
import DeviceIntelligencePanel from './DeviceIntelligencePanel.vue';
import DiscoveryOnboarding from './DiscoveryOnboarding.vue';
import NetworkIntelligencePanel from '../../components/discovery/NetworkIntelligencePanel.vue';
import type { useDiscoveryWorkspace } from './useDiscoveryWorkspace';
const props = defineProps<{
  mode: 'discovery' | 'network-intelligence';
  model: ReturnType<typeof useDiscoveryWorkspace>;
}>();
const {
  state, stateError, serverLabel, discoveredDevices, approvedOnboardingDevices,
  pendingEnrollmentCards, networkZones, networkSnapshots, latestNetworkSnapshot, networkSnapshotComparison,
  networkSnapshotsError, nmapCapability, networkRuntime, networkEndpointLifecycle, enrolledPhysicalDeviceCount,
  enrollmentError, verifiedEnrolledNetworkDevices, deviceChannelPhysicalIds, scanningNetwork, scanElapsedSeconds,
  scanFeedback, scanError, scanNetwork, cancelNetworkScan, discoveryMemory,
  discoveryMemoryLoading, discoveryMemoryError, loadDiscoveryMemory, liveNetworkDevices, discoveryInventoryUiState,
  openPendingEnrollment, openEnrolledDevice, reviewNetworkDevice, onLog, selectedAiDeviceId,
  aiInvestigating, deviceIntelligencePanel, networkEndpointInvestigations, networkEndpointHttpProbes, networkEndpointIdentityRefreshes,
  siteLocalEvidenceImport, siteLocalEvidenceImportBusy, siteLocalEvidenceImportError, onboardingNetworkEndpoint, startNetworkEndpointOnboarding,
  investigateSnapshotEndpoint, probeSnapshotEndpoint, refreshSnapshotEndpointIdentity, reviewSavedSiteLocalShellyEvidence, importSiteLocalShellyEvidence,
  reconcileSiteLocalShellyEvidence, openDeviceIntelligenceOnly, investigateNetworkDeviceWithAi
} = props.model;
const intelligenceModel = props.model.intelligenceModel;
</script>
<template>
        <section
          v-if="mode === 'network-intelligence'"
          class="network-intelligence-workspace"
        >
          <NetworkIntelligencePanel
            :scopes="state?.networkZones || []"
            :snapshots="networkSnapshots"
            :latest="latestNetworkSnapshot"
            :comparison="networkSnapshotComparison"
            :nmap-capability="nmapCapability"
            :observer="networkRuntime"
            :pending-count="stateError ? null : pendingEnrollmentCards.length"
            :enrolled-count="enrollmentError ? null : enrolledPhysicalDeviceCount"
            :enrollment-state-available="!enrollmentError"
            :endpoint-lifecycle="networkEndpointLifecycle"
            :endpoint-investigations="networkEndpointInvestigations"
            :endpoint-http-probes="networkEndpointHttpProbes"
            :endpoint-identity-refreshes="networkEndpointIdentityRefreshes"
            :site-local-evidence-import="siteLocalEvidenceImport"
            :site-local-evidence-import-busy="siteLocalEvidenceImportBusy"
            :site-local-evidence-import-error="siteLocalEvidenceImportError"
            :busy="scanningNetwork"
            :onboarding-busy="onboardingNetworkEndpoint"
            :error="networkSnapshotsError || scanError || stateError"
            @scan="scanNetwork"
            @cancel="cancelNetworkScan"
            @start-onboarding="startNetworkEndpointOnboarding"
            @open-pending="openPendingEnrollment"
            @open-device="openEnrolledDevice"
            @investigate-endpoint="investigateSnapshotEndpoint"
            @refresh-endpoint-identity="refreshSnapshotEndpointIdentity"
            @review-saved-site-local-evidence="reviewSavedSiteLocalShellyEvidence"
            @probe-endpoint="probeSnapshotEndpoint"
            @import-site-local-evidence="importSiteLocalShellyEvidence"
            @reconcile-site-local-evidence="reconcileSiteLocalShellyEvidence"
          />
        </section>

        <section
          v-else-if="mode === 'discovery'"
          class="panel workspace-panel discovery-workspace"
        >
          <div class="page-heading split-heading">
            <div>
              <p class="eyebrow">Local Onboarding</p>
              <h2>Discovery inbox</h2>
              <span
                >Scan the networks visible from this site brain, then approve
                only the devices that belong here.</span
              >
            </div>
          </div>

          <nav class="discovery-jump-links" aria-label="Discovery sections">
            <a href="#discovery-memory">Memory <span>{{ discoveryMemory?.summary.known ?? '—' }}</span></a>
            <a href="#pending-onboarding">Pending <span>{{ discoveredDevices.length }}</span></a>
            <a href="#approved-onboarding">Approved <span>{{ approvedOnboardingDevices.length }}</span></a>
          </nav>

          <div v-if="scanningNetwork" class="discovery-scan-progress" role="status" aria-live="polite">
            <div class="discovery-scan-progress-heading">
              <strong>Scanning configured networks…</strong>
              <span>{{ scanElapsedSeconds }}s elapsed</span>
            </div>
            <div class="discovery-scan-track">
              <div class="discovery-scan-indicator"></div>
            </div>
            <small>Collecting network evidence. The scan may take longer across routed networks.</small>
          </div>
          <p v-else-if="scanFeedback" class="discovery-scan-feedback" role="status">
            {{ scanFeedback }}
            <span>· {{ scanElapsedSeconds }}s</span>
          </p>

          <DiscoveryNetworkInventory
            :live-network-devices="liveNetworkDevices"
            :memory="discoveryMemory"
            :memory-loading="discoveryMemoryLoading"
            :memory-error="discoveryMemoryError"
            :network-zones="networkZones"
            :network-snapshots="networkSnapshots"
            :server-label="serverLabel"
            :enrolled-devices="verifiedEnrolledNetworkDevices"
            :channel-physical-ids="deviceChannelPhysicalIds"
            :ai-investigating="aiInvestigating"
            :ui-state="discoveryInventoryUiState"
            @refresh-memory="loadDiscoveryMemory"
            @review="openDeviceIntelligenceOnly"
            @investigate="investigateNetworkDeviceWithAi"
            @channels="reviewNetworkDevice"
            @copy-ssh="onLog"
          />

          <div v-if="selectedAiDeviceId" ref="deviceIntelligencePanel">
            <DeviceIntelligencePanel :model="intelligenceModel" />
          </div>

          <DiscoveryOnboarding :model="model" />
        </section>


</template>
