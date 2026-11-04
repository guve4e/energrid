<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref } from 'vue';
import { usePortalSession } from './app/usePortalSession';
import { usePortalState } from './app/usePortalState';
import PortalChrome from './app/PortalChrome.vue';
import PortalLogin from './app/PortalLogin.vue';
import { usePortalChromeState } from './app/usePortalChromeState';
import SystemsPage from './features/systems/SystemsPage.vue';
import ExecutionsPage from './features/operations/ExecutionsPage.vue';
import LogsPage from './features/operations/LogsPage.vue';

import DiscoveryWorkspace from './features/discovery/DiscoveryWorkspace.vue';
import { useDiscoveryWorkspace } from './features/discovery/useDiscoveryWorkspace';
import type { PortalDevice } from './portal-state';
import { useDiscoveryDecisions } from './features/discovery/useDiscoveryDecisions';
import type { NetworkDevice } from './features/discovery/discovery-contracts';
import EnergridChatWidget from './components/assistant/EnergridChatWidget.vue';
import VoiceAssistantPage from './features/assistant/VoiceAssistantPage.vue';
import StandaloneVoiceScreen from './features/assistant/StandaloneVoiceScreen.vue';
import { useVoiceWorkspace } from './features/assistant/useVoiceWorkspace';
import HomeDashboard from './components/home/HomeDashboard.vue';
import MobileDashboard from './components/mobile/MobileDashboard.vue';
import DisplayDashboard from './components/display/DisplayDashboard.vue';
import './discovery.css';
import ExecutionTimelineModal from './components/execution/ExecutionTimelineModal.vue';
import WeatherDashboard from './components/weather/WeatherDashboard.vue';
import EnergyDashboard from './components/energy/EnergyDashboard.vue';
import { pageFromPath, pathForPage } from './portal-route';
import BusPage from './features/bus/BusPage.vue';
import DevicesPage from './features/devices/DevicesPage.vue';
import { useDeviceMembership } from './features/devices/useDeviceMembership';
import { useDeviceActions } from './features/devices/useDeviceActions';
import { useDeviceInventory } from './features/devices/useDeviceInventory';
import { useDeviceStateStream } from './features/devices/useDeviceStateStream';

const ExpensesDashboard = defineAsyncComponent(() => import('./components/expenses/ExpensesDashboard.vue'));



function cleanBaseUrl(url: string) {
  return url.replace(/\/$/, '');
}

const apiBase = cleanBaseUrl(import.meta.env.VITE_API_BASE_URL || '');
const isLocalLivePreview =
  import.meta.env.VITE_BACKEND_LABEL === 'local-live';

const { email, password, loginError, accessToken, user, isAuthRestoring,
  login, logout, restore: restorePortalSession, dispose: disposeSession } = usePortalSession({
  apiBase,
  onSignedIn: async () => {
    if (activePage.value === 'network-intelligence') await refreshNetworkIntelligence();
    else await loadState();
  },
  onRestored: () => {
    setEndpointMode(endpointMode.value);
    if (activePage.value === 'discovery') void refreshDiscovery();
    else if (activePage.value === 'network-intelligence') void refreshNetworkIntelligence();
    else void loadState();
    void loadVoiceRuns();
  },
  onSignedOut: () => {
    disconnectVoice();
    resetMenus();
    verifiedHttpControlRoutes.value = {};
    state.value = null;
  },
});
const eventLog = ref<string[]>([]);
const voice = useVoiceWorkspace({ apiBase, accessToken, eventLog, onLog: appendLog, isLocalLivePreview });
const { nativeWakeAvailable, nativeWakeEnabled, nativeWakeStatus, toggleNativeWakeWord,
  standaloneAssistantOpen, openStandaloneAssistant, closeStandaloneAssistant,
  endpointMode, setEndpointMode, disconnectVoice, loadVoiceRuns,
  handleAssistantTurnCompleted } = voice;
const standaloneHome = location.pathname.replace(/\/+$/, '') === '/d/home';
const activePage = ref(standaloneHome ? 'home' : pageFromPath(location.pathname));
const serverLabel = computed(() => import.meta.env.VITE_BACKEND_LABEL || apiBase || 'same-origin');
const { state, loadingState, stateError, siteSwitchBusy, siteSwitchError,
  loadState, switchPortalSite } = usePortalState({
  apiBase,
  accessToken,
  activePage,
  serverLabel,
  onLog: appendLog,
  loadMembership: () => loadEnrollmentMembership(),
  loadDiscoveryMemory: () => discoveryWorkspace.loadDiscoveryMemory(),
  beforeSiteSwitch: () => { stopDeviceStateStream(); verifiedHttpControlRoutes.value = {}; },
  onSiteSwitchFailure: () => syncDeviceStateStream(),
});



const { theme, userMenuOpen, notificationsOpen, mobileMenuOpen, navItems, userInitials,
  toggleTheme, toggleNotifications, toggleUserMenu, closeMobileMenu, resetMenus } = usePortalChromeState(activePage, user);

const { deviceStateStreamStatus, deviceStateClock, stopDeviceStateStream, syncDeviceStateStream } =
  useDeviceStateStream({ apiBase, accessToken, state, activePage });
const { enrolledDeviceKeys, enrollmentStatuses, lifecycleEnrollmentRecords, enrollmentError, loadEnrollmentMembership } =
  useDeviceMembership({ apiBase, accessToken, state });
const deviceActions = useDeviceActions({ apiBase, accessToken, state, onRefresh: loadState, onLog: appendLog });
const { verifiedHttpControlRoutes, deviceActionBusy, deviceActionError,
  canUseDeviceControl, sendDeviceAction } = deviceActions;
const installationChangesPending = ref(false);
const selectedExecutionTraceId = ref<string | null>(null);
const deviceInventory = useDeviceInventory({ state, enrolledDeviceKeys, enrollmentStatuses,
  lifecycleEnrollmentRecords, enrollmentError, deviceStateClock, selectedExecutionTraceId,
  canUseDeviceControl, confirmDiscardInstallationChanges, onRefresh: loadState });
const { deviceCards, selectedDeviceId, deviceApprovalFilter, deviceSearch, deviceSourceFilter,
  deviceCapabilityFilter, deviceZoneFilter, deviceStatusFilter,
  enrolledInventoryDevices, approvedDevices, discoveredDevices, siteSystems,
  selectDevice } = deviceInventory;
const selectedExecutionTrace = computed(() => {
  const trace =
    state.value?.executionTraces?.find(
      (trace) => trace.id === selectedExecutionTraceId.value,
    ) || null;

  return trace;
});

function setActivePage(pageId: string, syncUrl = true) {
  if (!confirmDiscardInstallationChanges()) return;
  activePage.value = pageId;
  window.scrollTo({ top: 0 });
  selectedDeviceId.value = null;
  selectedExecutionTraceId.value = null;
  closeMobileMenu();
  if (syncUrl) {
    const path = pathForPage(pageId);
    if (location.pathname !== path) history.pushState({}, '', path);
  }
  if (pageId === 'assistant') void loadVoiceRuns();
  if (pageId === 'devices') void loadState();
  if (pageId === 'discovery') void refreshDiscovery();
  if (pageId === 'network-intelligence') void refreshNetworkIntelligence();
}

function openPendingEnrollment(recordId?: string) {
  setActivePage('discovery');
  void nextTick(() => {
    const targetId = recordId ? `pending-record-${encodeURIComponent(recordId)}` : 'pending-onboarding';
    (document.getElementById(targetId) || document.getElementById('pending-onboarding'))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function openEnrolledDevice(recordId: string) {
  setActivePage('devices');
  if (!recordId) return;
  void nextTick(() => {
    const device = deviceCards.value.find(candidate => candidate.id === recordId);
    if (device) selectDevice(device);
    document.getElementById(`device-record-${encodeURIComponent(recordId)}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function handlePortalRouteChange() {
  setActivePage(pageFromPath(location.pathname), false);
}

// Explicit approval and physical identity verification are independent from scanning.
const { discoveryDecisionBusy, shellyVerificationMessages, discoveryDecisionError,
  applyDiscoveryDecision, verifyPendingShelly } = useDiscoveryDecisions({
  apiBase,
  token: accessToken,
  siteScope: () => state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null,
  onRefresh: loadState,
  onLog: appendLog,
  onApproved: () => {
    if (activePage.value === 'devices') deviceApprovalFilter.value = 'approved';
  },
});


async function reviewNetworkDevice(device: NetworkDevice) {
  await loadState();
  const channel = deviceCards.value.find(candidate => candidate.metadata?.physicalId === device.id);
  if (!channel) { stateError.value = 'No supported channels are available. Run a new scan or check device authentication.'; return; }
  setActivePage('devices');
  deviceApprovalFilter.value = channel.trustStatus === 'approved' ? 'approved' : 'discovered';
  deviceSourceFilter.value = 'site';
  deviceCapabilityFilter.value = 'all';
  deviceZoneFilter.value = 'all';
  deviceStatusFilter.value = 'all';
  deviceSearch.value = device.id;
  selectDevice(channel);
}


// One persistent feature model for both Discovery routes. It never authorizes control on observation alone.
const discoveryWorkspace = useDiscoveryWorkspace({
  apiBase, token: accessToken, state, stateError, serverLabel,
  deviceCards, approvedDevices, discoveredDevices, enrolledInventoryDevices,
  enrolledDeviceKeys, lifecycleEnrollmentRecords, enrollmentError,
  decisions: { discoveryDecisionBusy, shellyVerificationMessages, discoveryDecisionError, applyDiscoveryDecision, verifyPendingShelly },
  loadState, setActivePage, openPendingEnrollment, openEnrolledDevice,
  openApprovedDevice, reviewNetworkDevice, onLog: appendLog,
});
const { refreshDiscovery, refreshNetworkIntelligence, networkDevices } = discoveryWorkspace;

function confirmDiscardInstallationChanges() {
  if (!installationChangesPending.value) return true;
  if (!window.confirm('Discard unsaved installation changes?')) return false;
  installationChangesPending.value = false;
  return true;
}

function openExecutionTrace(traceId: string) {
  selectedExecutionTraceId.value = traceId;
}

function closeExecutionTrace() {
  selectedExecutionTraceId.value = null;
}

function handleExecutionRecommendation(recommendationId: string) {
  if (recommendationId === 'inspect-mqtt') {
    activePage.value = 'mqtt';
    return;
  }

  if (recommendationId === 'inspect-device') {
    const trace = selectedExecutionTrace.value;
    const device = state.value?.devices?.find(
      (candidate) => candidate.id === trace?.deviceId,
    );

    if (device) {
      selectedDeviceId.value = device.id;
    }

    return;
  }

  console.warn(
    `[EXECUTION RECOMMENDATION] ${recommendationId} is not wired yet`,
  );
}

async function sendMobileDeviceAction(deviceId: string, action: 'turn_on' | 'turn_off') {
  const device = deviceCards.value.find((candidate) => candidate.id === deviceId);
  if (device) void sendDeviceAction(device, action);
}

function openApprovedDevice(device: PortalDevice) {
  setActivePage('devices');
  selectDevice(device);
}

async function handleDeviceRetired() {
  await Promise.all([loadEnrollmentMembership(), loadState()]);
}

async function handleDeviceReenrolled() {
  await Promise.all([loadEnrollmentMembership(), loadState()]);
}

function appendLog(message: string) {
  const time = new Date().toLocaleTimeString();
  eventLog.value.push(`${time} ${message}`);
  if (eventLog.value.length > 200)
    eventLog.value.splice(0, eventLog.value.length - 200);
}

window.addEventListener('popstate', handlePortalRouteChange);
void restorePortalSession();

onBeforeUnmount(() => {
  stopDeviceStateStream();
  disposeSession();
  window.removeEventListener('popstate', handlePortalRouteChange);
});
</script>

<template>
  <main v-if="isAuthRestoring" :class="['login-screen', `theme-${theme}`]">
    <section class="login-panel" aria-live="polite">Restoring secure session…</section>
  </main>

  <PortalLogin v-else-if="!accessToken" v-model:email="email" v-model:password="password"
    :theme="theme" :login-error="loginError" @login="login" />

  <main v-else-if="standaloneHome" class="standalone-home-route">
    <HomeDashboard
      v-if="!standaloneAssistantOpen"
      :api-base="apiBase"
      :access-token="accessToken"
      :native-wake-available="nativeWakeAvailable"
      :native-wake-enabled="nativeWakeEnabled"
      :native-wake-status="nativeWakeStatus"
      @toggle-wake-word="toggleNativeWakeWord"
      @assistant="openStandaloneAssistant"
    />

    <StandaloneVoiceScreen v-else :voice="voice" @close="closeStandaloneAssistant" />
  </main>

  <PortalChrome v-else :theme="theme" :mobile-menu-open="mobileMenuOpen"
    :notifications-open="notificationsOpen" :user-menu-open="userMenuOpen"
    :user-initials="userInitials" :user="user" :nav-items="navItems"
    :state="state" :site-switch-busy="siteSwitchBusy" :site-switch-error="siteSwitchError"
    @open-mobile-menu="mobileMenuOpen = true" @close-mobile-menu="closeMobileMenu"
    @toggle-notifications="toggleNotifications" @toggle-theme="toggleTheme"
    @toggle-user-menu="toggleUserMenu" @logout="logout"
    @navigate="setActivePage" @site-switch="switchPortalSite">
      <VoiceAssistantPage v-if="activePage === 'assistant'" :voice="voice"
          :server-label="serverLabel" :stt-provider="state?.voice.provider || '--'"
          :api-base="apiBase" :access-token="accessToken" />

        <DevicesPage
          v-else-if="activePage === 'devices'"
          :inventory="deviceInventory" :actions="deviceActions"
          :api-base="apiBase" :access-token="accessToken"
          :network-devices="networkDevices"
          :loading-state="loadingState" :stream-status="deviceStateStreamStatus"
          :device-state-clock="deviceStateClock" :state-error="stateError"
          :discovery-decision-busy="discoveryDecisionBusy"
          :discovery-decision-error="discoveryDecisionError"
          @refresh="loadState" @approve="applyDiscoveryDecision($event, 'approve')"
          @retired="handleDeviceRetired" @reenrolled="handleDeviceReenrolled"
          @trace="openExecutionTrace" @installation-dirty="installationChangesPending = $event"
        />

        <SystemsPage v-else-if="activePage === 'systems'" :systems="siteSystems" />
        <DiscoveryWorkspace
          v-else-if="activePage === 'network-intelligence' || activePage === 'discovery'"
          :mode="activePage === 'network-intelligence' ? 'network-intelligence' : 'discovery'"
          :model="discoveryWorkspace"
        />
        <BusPage
          v-else-if="activePage === 'bus'"
          :api-base="apiBase"
          :access-token="accessToken"
          @log="appendLog"
        />
        <ExecutionsPage v-else-if="activePage === 'executions'"
          :traces="state?.executionTraces || []" @refresh="loadState" @open-trace="openExecutionTrace" />
        <LogsPage v-else-if="activePage === 'logs'" :logs="state?.logs || []"
          :client-messages="eventLog" :api-base="apiBase" :access-token="accessToken" @refresh="loadState" />
        <HomeDashboard
          v-else-if="activePage === 'home'"
          :api-base="apiBase"
          :access-token="accessToken"
          :native-wake-available="nativeWakeAvailable"
          :native-wake-enabled="nativeWakeEnabled"
          :native-wake-status="nativeWakeStatus"
          @toggle-wake-word="toggleNativeWakeWord"
          @assistant="setActivePage('assistant')"
        />
        <MobileDashboard
          v-else-if="activePage === 'mobile'"
          :site-name="state?.site.name || 'Home'"
          :tenant-name="state?.tenant.name || 'Energrid'"
          :devices="deviceCards"
          :sensors="state?.zones.flatMap((zone) => zone.sensors) || []"
          :unread-count="0"
          :notifications="[]"
          :action-busy="deviceActionBusy"
          :action-errors="deviceActionError"
          :notifications-available="false"
          @action="sendMobileDeviceAction"
          @assistant="setActivePage('assistant')"
        />
        <DisplayDashboard
          v-else-if="activePage === 'display'"
          :site-name="state?.site.name || 'Home'"
          :tenant-name="state?.tenant.name || 'Energrid'"
          :devices="deviceCards"
          :sensors="state?.zones.flatMap((zone) => zone.sensors) || []"
          :unread-count="0"
          :api-base="apiBase"
          :access-token="accessToken"
        />
        <WeatherDashboard v-else-if="activePage === 'weather'" :api-base="apiBase" :access-token="accessToken" />
        <EnergyDashboard v-else-if="activePage === 'energy'" :api-base="apiBase" :access-token="accessToken" />
        <ExpensesDashboard v-else-if="activePage === 'expenses'" :api-base="apiBase" :access-token="accessToken" />
        <section v-else class="panel workspace-panel">
          <div class="page-heading">
            <p class="eyebrow">Coming Next</p>
            <h2>
              {{ navItems.find((item) => item.id === activePage)?.label }}
            </h2>
            <span
              >This section is reserved for the next automation workflow.</span
            >
          </div>
        </section>

        <p v-if="stateError" class="error">{{ stateError }}</p>

      <template #modal>
      <ExecutionTimelineModal
        :trace="selectedExecutionTrace"
        @close="closeExecutionTrace"
        @recommendation="handleExecutionRecommendation"
      />
      </template>
      <template #floating>
      <EnergridChatWidget
      v-if="accessToken"
      :api-base="apiBase"
      :access-token="accessToken"
      @turn-completed="handleAssistantTurnCompleted"
    />
      </template>
  </PortalChrome>
</template>
