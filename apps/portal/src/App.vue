<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref } from 'vue';
import { authFetch, clearAuthenticatedSession, getAccessToken, logoutRequest, onAuthState, restoreSession, setAuthenticatedSession } from './auth/auth-client';
import DiscoveryWorkspace from './features/discovery/DiscoveryWorkspace.vue';
import { useDiscoveryWorkspace } from './features/discovery/useDiscoveryWorkspace';
import type { PortalState, PortalDevice } from './portal-state';
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
import InteractionTraces from './components/observability/InteractionTraces.vue';
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

type LoginResponse = {
  accessToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    name: string;
    role: 'admin' | 'installer' | 'viewer';
  };
};


type VoiceConfig = {
  sttProvider: string;
  openaiBatchModel: string;
  localWhisperFallbackToOpenAI: boolean;
  localWhisperWorker?: boolean;
  localWhisperModel: string;
  localWhisperLanguage: string;
};


type PortalSystem = NonNullable<PortalState['systems']>[number];
type OperationalLogEntry = NonNullable<PortalState['logs']>[number];

const themeKey = 'energrid.portal.theme.v2';

function cleanBaseUrl(url: string) {
  return url.replace(/\/$/, '');
}

const apiBase = cleanBaseUrl(import.meta.env.VITE_API_BASE_URL || '');
const isLocalLivePreview =
  import.meta.env.VITE_BACKEND_LABEL === 'local-live';

const email = ref('');
const password = ref('');
const loginError = ref('');
const accessToken = ref('');
const user = ref<LoginResponse['user'] | null>(null);
const isAuthRestoring = ref(true);
const state = ref<PortalState | null>(null);
const loadingState = ref(false);
const stateError = ref('');
const siteSwitchBusy = ref(false);
const siteSwitchError = ref('');


const eventLog = ref<string[]>([]);
const voice = useVoiceWorkspace({ apiBase, accessToken, eventLog, onLog: appendLog, isLocalLivePreview });
const { nativeWakeAvailable, nativeWakeEnabled, nativeWakeStatus, toggleNativeWakeWord,
  standaloneAssistantOpen, openStandaloneAssistant, closeStandaloneAssistant,
  endpointMode, setEndpointMode, disconnectVoice, loadVoiceRuns,
  handleAssistantTurnCompleted } = voice;
const theme = ref(localStorage.getItem(themeKey) || 'dark');
const userMenuOpen = ref(false);
const notificationsOpen = ref(false);
const mobileMenuOpen = ref(false);
const standaloneHome = location.pathname.replace(/\/+$/, '') === '/d/home';
const activePage = ref(standaloneHome ? 'home' : pageFromPath(location.pathname));

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
  deviceCapabilityFilter, deviceZoneFilter, deviceStatusFilter, selectedDevice,
  enrolledInventoryDevices, approvedDevices, discoveredDevices, deviceSummary, siteSystems,
  selectDevice, deviceDiagnostics, diagnosticSummary } = deviceInventory;
const logLevelFilter = ref('all');
const logSourceFilter = ref('all');
const logSearch = ref('');
const navItems = computed(() => [
  { id: 'home', label: 'Home', active: activePage.value === 'home' },
  { id: 'mobile', label: 'Mobile', active: activePage.value === 'mobile' },
  { id: 'display', label: 'Display', active: activePage.value === 'display' },
  {
    id: 'assistant',
    label: 'Assistant',
    active: activePage.value === 'assistant',
  },
  { id: 'devices', label: 'Devices', active: activePage.value === 'devices' },
  {
    id: 'discovery',
    label: 'Discovery',
    active: activePage.value === 'discovery',
  },
  {
    id: 'network-intelligence',
    label: 'Network Intelligence',
    active: activePage.value === 'network-intelligence',
  },
  { id: 'bus', label: 'Bus', active: activePage.value === 'bus' },
  { id: 'systems', label: 'Systems', active: activePage.value === 'systems' },
  { id: 'energy', label: 'Energy', active: activePage.value === 'energy' },
  { id: 'expenses', label: 'Expenses', active: activePage.value === 'expenses' },
  { id: 'weather', label: 'Weather', active: activePage.value === 'weather' },
  {
    id: 'executions',
    label: 'Executions',
    active: activePage.value === 'executions',
  },
  { id: 'logs', label: 'Logs', active: activePage.value === 'logs' },
]);

const notifications = [
  { tone: 'green', text: 'Kitchen temperature sensor online' },
  { tone: 'blue', text: 'Voice gateway ready' },
  { tone: 'amber', text: 'Local STT can be slow on Pi CPU' },
];

const starterIdentity = {
  tenantId: 'tenant-live',
  siteId: 'site-pi',
  siteName: 'Home',
  gatewayId: 'site-gateway',
};

const starterDevices: PortalDevice[] = [
  {
    id: 'kitchen_light',
    ...starterIdentity,
    displayName: 'Kitchen lights',
    kind: 'logical',
    zoneId: 'kitchen',
    zoneName: 'Kitchen',
    trustStatus: 'approved',
    capabilities: [{ kind: 'light', actions: ['turn_on', 'turn_off'] }],
    adapter: {
      id: 'kitchen-light-group',
      protocol: 'mqtt',
      driver: 'shelly-rpc',
      configured: true,
      target: 'shelly/rpc',
    },
    state: {
      values: {},
      observedAt: null,
      source: 'starter-registry',
      status: 'unknown',
    },
    memberDeviceIds: [
      'kitchen.light.wall.led',
      'kitchen.light.island.led',
      'kitchen.light.cans',
    ],
  },
  {
    id: 'kitchen_temperature',
    ...starterIdentity,
    displayName: 'Kitchen temperature',
    kind: 'physical',
    zoneId: 'kitchen',
    zoneName: 'Kitchen',
    trustStatus: 'approved',
    capabilities: [{ kind: 'temperature', actions: ['read'], unit: 'C' }],
    adapter: {
      id: 'arduino-mqtt-temperature',
      protocol: 'mqtt',
      driver: 'mqtt-json-sensor',
      configured: true,
      target: 'sensors/arduino/temp',
    },
    state: {
      values: { temperature: 23.7 },
      observedAt: new Date().toISOString(),
      source: 'starter-registry',
      status: 'online',
    },
  },
];

const starterSystems: PortalSystem[] = [
  {
    id: 'kitchen_lighting',
    ...starterIdentity,
    displayName: 'Kitchen lighting',
    kind: 'lighting',
    zoneId: 'kitchen',
    zoneName: 'Kitchen',
    deviceIds: ['kitchen_light'],
    capabilities: [{ kind: 'light', actions: ['turn_on', 'turn_off'] }],
    responseProfile: {
      latencyMs: 700,
      confidence: 0.25,
      learningEnabled: true,
    },
    policy: {
      requiresApproval: false,
      confirmationRequiredFor: [],
      notes: 'Safe low-risk lighting control.',
    },
    learning: {
      enabled: true,
      objective:
        'Learn occupancy and daylight patterns before proposing scenes.',
      signals: ['voice commands', 'time of day', 'outside darkness'],
      currentConfidence: 0.25,
    },
    state: {
      values: {},
      observedAt: null,
      source: 'starter-registry',
      status: 'unknown',
    },
  },
  {
    id: 'floor_heating',
    ...starterIdentity,
    displayName: 'Floor heating loop',
    kind: 'slow_radiant_heating',
    zoneId: 'home',
    zoneName: 'Home',
    deviceIds: [],
    capabilities: [
      {
        kind: 'slow_radiant_zone',
        actions: ['read', 'set_target_temperature'],
        unit: 'C',
      },
    ],
    responseProfile: {
      thermalLagMinutes: 210,
      minCycleMinutes: 45,
      confidence: 0.2,
      learningEnabled: true,
    },
    policy: {
      requiresApproval: true,
      confirmationRequiredFor: ['set_target_temperature'],
      safeRange: { min: 16, max: 28, unit: 'C' },
    },
    learning: {
      enabled: true,
      objective:
        'Predict when to start radiant heat using forecast, tariffs, room history, and thermal lag.',
      signals: ['inside temperature', 'outside forecast', 'floor loop runtime'],
      currentConfidence: 0.2,
    },
    state: {
      values: {},
      observedAt: null,
      source: 'starter-registry',
      status: 'unknown',
    },
  },
];

const userInitials = computed(() => {
  const name = user.value?.name || user.value?.email || 'EG';
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
});

const displayLogs = computed(() => eventLog.value.slice(-40));
const operationalLogs = computed(() => state.value?.logs || []);
const clientLogEntries = computed<OperationalLogEntry[]>(() =>
  eventLog.value
    .slice(-80)
    .reverse()
    .map((line, index) => ({
      id: `client:${index}:${line}`,
      observedAt: new Date().toISOString(),
      level:
        line.includes('failed') || line.includes('error') ? 'warn' : 'debug',
      source: 'portal',
      event: 'client.log',
      message: line,
    })),
);
const allLogEntries = computed(() =>
  [...operationalLogs.value, ...clientLogEntries.value].sort(
    (left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt),
  ),
);
const visibleLogEntries = computed(() => {
  const search = logSearch.value.trim().toLowerCase();
  return allLogEntries.value.filter((entry) => {
    if (logLevelFilter.value !== 'all' && entry.level !== logLevelFilter.value)
      return false;
    if (
      logSourceFilter.value !== 'all' &&
      entry.source !== logSourceFilter.value
    )
      return false;
    if (!search) return true;
    return `${entry.level} ${entry.source} ${entry.event} ${entry.message} ${entry.deviceId || ''} ${entry.topic || ''}`
      .toLowerCase()
      .includes(search);
  });
});
const logSummary = computed(() => {
  const entries = allLogEntries.value;
  return [
    { label: 'Events', value: `${entries.length}`, detail: 'recent buffer' },
    {
      label: 'Warnings',
      value: `${entries.filter((entry) => entry.level === 'warn').length}`,
      detail: 'needs attention',
    },
    {
      label: 'Errors',
      value: `${entries.filter((entry) => entry.level === 'error').length}`,
      detail: 'failed actions',
    },
    {
      label: 'No ack',
      value: `${entries.filter((entry) => entry.event === 'command.no_ack').length}`,
      detail: 'device command misses',
    },
  ];
});
const logSources = computed(() =>
  [...new Set(allLogEntries.value.map((entry) => entry.source))].sort(),
);
const serverLabel = computed(
  () => import.meta.env.VITE_BACKEND_LABEL || apiBase || 'same-origin',
);
// MQTT profile investigations are separate from LAN identification.


// Discovery inventory owns remembered/live precedence, never reachability inference.


const selectedExecutionTrace = computed(() => {
  const trace =
    state.value?.executionTraces?.find(
      (trace) => trace.id === selectedExecutionTraceId.value,
    ) || null;

  return trace;
});

const executionSearch = ref('');
const executionOutcomeFilter = ref('all');
const executionActionFilter = ref('all');

const visibleExecutions = computed(() => {
  const traces = state.value?.executionTraces || [];

  return traces.filter((trace) => {
    const search = executionSearch.value.trim().toLowerCase();

    const matchesSearch =
      !search ||
      trace.deviceId.toLowerCase().includes(search) ||
      trace.action.toLowerCase().includes(search);

    const matchesOutcome =
      executionOutcomeFilter.value === 'all' ||
      trace.outcome === executionOutcomeFilter.value;

    const matchesAction =
      executionActionFilter.value === 'all' ||
      trace.action === executionActionFilter.value;

    return matchesSearch && matchesOutcome && matchesAction;
  });
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


// Discovery owns scanning, authorization prompts, cancellation and stale-response rejection.
// The shell integrates accepted results into existing snapshot/state projections only.


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

async function login() {
  loginError.value = '';
  const response = await window.fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: email.value, password: password.value }),
  });

  if (!response.ok) {
    loginError.value = response.status === 429
      ? 'Too many sign-in attempts. Wait a little and try again.'
      : response.status === 401
        ? 'Email or password is incorrect.'
        : 'Sign-in is temporarily unavailable.';
    return;
  }

  const data = (await response.json()) as LoginResponse;
  setAuthenticatedSession(data);
  accessToken.value = data.accessToken;
  user.value = data.user;
  if (activePage.value === 'network-intelligence') await refreshNetworkIntelligence();
  else await loadState();
}

async function logout() {
  try { await logoutRequest(); }
  finally {
    disconnectVoice();
    userMenuOpen.value = false;
    notificationsOpen.value = false;
    mobileMenuOpen.value = false;
    clearAuthenticatedSession();
    verifiedHttpControlRoutes.value = {};
    accessToken.value = '';
    user.value = null;
    state.value = null;
  }
}

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light';
  localStorage.setItem(themeKey, theme.value);
}

function toggleNotifications() {
  notificationsOpen.value = !notificationsOpen.value;
  userMenuOpen.value = false;
}

function toggleUserMenu() {
  userMenuOpen.value = !userMenuOpen.value;
  notificationsOpen.value = false;
}

function closeMobileMenu() {
  mobileMenuOpen.value = false;
}

async function handleDeviceRetired() {
  await Promise.all([loadEnrollmentMembership(), loadState()]);
}

async function handleDeviceReenrolled() {
  await Promise.all([loadEnrollmentMembership(), loadState()]);
}

async function loadState() {
  loadingState.value = true;
  stateError.value = '';
  try {
    appendLog(`[portal] loading state from ${serverLabel.value}`);
    const response = await authFetch(`${apiBase}/portal/state`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (response.status === 404) {
      await loadVoiceOnlyState();
      return;
    }
    if (!response.ok) throw new Error('State unavailable');
    state.value = (await response.json()) as PortalState;
    await loadEnrollmentMembership();
    if (activePage.value === 'discovery') {
      await discoveryWorkspace.loadDiscoveryMemory();
    }
  } catch (error) {
    stateError.value =
      error instanceof Error ? error.message : 'State unavailable';
  } finally {
    loadingState.value = false;
  }
}

async function switchPortalSite(event: Event) {
  const siteId = (event.target as HTMLSelectElement | null)?.value;
  if (!siteId || siteId === state.value?.site.id) return;
  siteSwitchBusy.value = true;
  stopDeviceStateStream();
  verifiedHttpControlRoutes.value = {};
  siteSwitchError.value = '';
  try {
    const response = await authFetch(`${apiBase}/portal/site-selection`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ siteId }),
    });
    if (!response.ok) throw new Error('The selected site could not be opened.');
    window.location.reload();
  } catch (error) {
    siteSwitchError.value = error instanceof Error ? error.message : 'The selected site could not be opened.';
    syncDeviceStateStream();
  } finally {
    siteSwitchBusy.value = false;
  }
}

async function loadVoiceOnlyState() {
  appendLog('[portal] /portal/state missing, using /voice/config fallback');
  const response = await authFetch(`${apiBase}/voice/config`);
  if (!response.ok) throw new Error('Voice config unavailable');
  const config = (await response.json()) as VoiceConfig;

  state.value = {
    tenant: { id: 'tenant-live', name: 'Energrid Live' },
    site: { id: 'site-pi', name: 'Home', mode: 'home' },
    sites: [
      {
        id: starterIdentity.siteId,
        name: starterIdentity.siteName,
        gatewayIds: [starterIdentity.gatewayId],
        deviceCount: starterDevices.length,
        systemCount: starterSystems.length,
      },
    ],
    gateways: [
      {
        id: starterIdentity.gatewayId,
        siteId: starterIdentity.siteId,
        transport: 'mqtt',
        topicPrefix: `energrid/${starterIdentity.tenantId}/${starterIdentity.siteId}`,
        status: 'unknown',
      },
    ],
    zones: [
      {
        id: 'kitchen',
        name: 'Kitchen',
        sensors: [
          {
            id: 'kitchen_temperature',
            name: 'Kitchen temperature',
            capability: 'temperature',
            value: 23.7,
            unit: 'C',
            observedAt: new Date().toISOString(),
            source: 'starter-registry',
          },
        ],
      },
    ],
    devices: starterDevices,
    networkZones: [],
    networkDevices: [],
    systems: starterSystems,
    deviceSummary: {
      total: starterDevices.length,
      approved: starterDevices.filter(
        (device) => device.trustStatus === 'approved',
      ).length,
      discovered: starterDevices.filter(
        (device) => device.trustStatus === 'discovered',
      ).length,
      controllable: starterDevices.filter((device) =>
        device.capabilities.some((capability) =>
          capability.actions.some((action) => action !== 'read'),
        ),
      ).length,
      sensors: starterDevices.filter((device) =>
        device.capabilities.some((capability) =>
          capability.actions.includes('read'),
        ),
      ).length,
      systems: starterSystems.length,
      learningEnabled: starterSystems.filter(
        (system) => system.learning.enabled,
      ).length,
    },
    voice: {
      websocketPath: '/voice',
      provider: config.sttProvider,
    },
    bus: {
      mqtt: {
        enabled: false,
        status: 'disabled',
        broker: { host: 'same-origin', port: '1883' },
        prefix: `energrid/${starterIdentity.tenantId}/${starterIdentity.siteId}`,
        subscriptions: [
          `energrid/${starterIdentity.tenantId}/${starterIdentity.siteId}/#`,
        ],
        legacyTemperatureTopics: [],
        recentMessages: [],
      },
    },
  };
}

function appendLog(message: string) {
  const time = new Date().toLocaleTimeString();
  eventLog.value.push(`${time} ${message}`);
  if (eventLog.value.length > 200)
    eventLog.value.splice(0, eventLog.value.length - 200);
}

function formatLogTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function logMeta(entry: OperationalLogEntry) {
  return [entry.deviceId, entry.topic, entry.status]
    .filter(Boolean)
    .join(' · ');
}

function logDetails(entry: OperationalLogEntry) {
  if (!entry.details || Object.keys(entry.details).length === 0) return '';
  return Object.entries(entry.details)
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
}

const unsubscribeAuth = onAuthState((profile) => {
  accessToken.value = getAccessToken();
  user.value = profile;
  if (!profile) {
    state.value = null;
    disconnectVoice();
  }
});

async function restorePortalSession() {
  try {
    const profile = await restoreSession();
    if (profile) {
      accessToken.value = getAccessToken();
      user.value = profile;
      setEndpointMode(endpointMode.value);
      if (activePage.value === 'discovery') void refreshDiscovery();
      else if (activePage.value === 'network-intelligence') void refreshNetworkIntelligence();
      else void loadState();
      loadVoiceRuns();
    }
  } catch {
    clearAuthenticatedSession();
    accessToken.value = '';
    user.value = null;
  } finally { isAuthRestoring.value = false; }
}

function handleAuthExpired() {
  clearAuthenticatedSession();
  verifiedHttpControlRoutes.value = {};
  accessToken.value = '';
  user.value = null;
}
window.addEventListener('energrid:auth-expired', handleAuthExpired);
void restorePortalSession();

if (accessToken.value && user.value) {
  setEndpointMode(endpointMode.value);
  if (activePage.value === 'discovery') void refreshDiscovery();
  else if (activePage.value === 'network-intelligence') void refreshNetworkIntelligence();
  else void loadState();
  loadVoiceRuns();
}

window.addEventListener('popstate', handlePortalRouteChange);

onBeforeUnmount(() => {

  stopDeviceStateStream();
  unsubscribeAuth();
  window.removeEventListener('popstate', handlePortalRouteChange);
  window.removeEventListener('energrid:auth-expired', handleAuthExpired);
});
</script>

<template>
  <main v-if="isAuthRestoring" :class="['login-screen', `theme-${theme}`]">
    <section class="login-panel" aria-live="polite">Restoring secure session…</section>
  </main>

  <main v-else-if="!accessToken" :class="['login-screen', `theme-${theme}`]">
    <section class="login-panel">
      <div class="brand-lockup large">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <h1>Energrid</h1>
          <span>Бъдещето е тук</span>
        </div>
      </div>
      <p class="login-lead">Smart automation command center</p>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" v-model="email" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          v-model="password"
          autocomplete="current-password"
          type="password"
          @keydown.enter="login"
        />
      </div>
      <button class="primary wide" @click="login">Sign in</button>
      <p class="error">{{ loginError }}</p>
    </section>
  </main>

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

  <main
    v-else
    :class="['admin-shell', `theme-${theme}`, { 'menu-open': mobileMenuOpen }]"
  >
    <header class="mobile-appbar">
      <button
        class="menu-button"
        type="button"
        aria-label="Open navigation"
        @click="mobileMenuOpen = true"
      >
        <span></span>
        <span></span>
        <span></span>
      </button>
      <div class="brand-lockup">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <strong>Energrid</strong>
          <span>Бъдещето е тук</span>
        </div>
      </div>
      <div class="mobile-actions">
        <div class="notification-area">
          <button
            class="icon-button"
            type="button"
            aria-label="Notifications"
            @click="toggleNotifications"
          >
            <span aria-hidden="true">●</span>
          </button>
          <div v-if="notificationsOpen" class="popover notification-popover">
            <strong>Notifications</strong>
            <ul>
              <li
                v-for="notification in notifications"
                :key="notification.text"
              >
                <span :class="['dot', notification.tone]"></span>
                {{ notification.text }}
              </li>
            </ul>
          </div>
        </div>
        <button
          class="icon-button"
          type="button"
          :aria-label="theme === 'light' ? 'Use dark theme' : 'Use light theme'"
          @click="toggleTheme"
        >
          <span aria-hidden="true">{{ theme === 'light' ? '☾' : '☼' }}</span>
        </button>
        <button
          class="avatar-button mobile-avatar"
          type="button"
          aria-label="Account menu"
          @click="toggleUserMenu"
        >
          <span>{{ userInitials }}</span>
        </button>
      </div>
    </header>

    <button
      v-if="mobileMenuOpen"
      class="drawer-backdrop"
      type="button"
      aria-label="Close navigation"
      @click="closeMobileMenu"
    ></button>

    <aside class="sidebar">
      <button
        class="drawer-close"
        type="button"
        aria-label="Close navigation"
        @click="closeMobileMenu"
      >
        ×
      </button>
      <div class="brand-lockup">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <strong>Energrid</strong>
          <span>Бъдещето е тук</span>
        </div>
      </div>

      <nav class="side-nav" aria-label="Portal navigation">
        <button
          v-for="item in navItems"
          :key="item.label"
          :class="{ active: item.active }"
          type="button"
          @click="setActivePage(item.id)"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg v-if="item.id === 'assistant'" viewBox="0 0 24 24">
              <path d="M4 11.5 12 5l8 6.5" />
              <path d="M7 10.5V19h10v-8.5" />
            </svg>
            <svg v-else-if="item.id === 'devices'" viewBox="0 0 24 24">
              <path d="M6 6h5v5H6zM13 6h5v5h-5zM6 13h5v5H6zM13 13h5v5h-5z" />
            </svg>
            <svg v-else-if="item.id === 'automations'" viewBox="0 0 24 24">
              <path d="M6 7h5l2 10h5" />
              <path d="M6 17h5l2-10h5" />
              <path d="M4 7h2M18 7h2M4 17h2M18 17h2" />
            </svg>
            <svg v-else-if="item.id === 'discovery'" viewBox="0 0 24 24">
              <path d="M12 4v3M12 17v3M4 12h3M17 12h3" />
              <path
                d="M8.5 8.5 6.4 6.4M15.5 15.5l2.1 2.1M15.5 8.5l2.1-2.1M8.5 15.5l-2.1 2.1"
              />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <svg v-else-if="item.id === 'network-intelligence'" viewBox="0 0 24 24">
              <circle cx="5" cy="7" r="2" />
              <circle cx="18" cy="5" r="2" />
              <circle cx="16" cy="18" r="2" />
              <circle cx="6" cy="17" r="2" />
              <path d="m7 7 9-2M6 9l0 6M8 17l6 1M17 7l-1 9" />
            </svg>
            <svg v-else-if="item.id === 'bus'" viewBox="0 0 24 24">
              <path d="M5 7h14M5 12h14M5 17h14" />
              <path d="M8 5v4M16 10v4M11 15v4" />
            </svg>
            <svg v-else viewBox="0 0 24 24">
              <path d="M7 7h10M7 12h10M7 17h10" />
            </svg>
          </span>
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <section class="side-card">
        <span>Current site</span>
        <label class="site-selector-label">
          <span class="sr-only">Select site</span>
          <select
            :value="state?.site.id || 'site-home'"
            :disabled="siteSwitchBusy"
            aria-label="Select site"
            @change="switchPortalSite"
          >
            <option v-for="site in state?.sites || []" :key="site.id" :value="site.id">
              {{ site.name }}
            </option>
          </select>
        </label>
        <small>{{ state?.tenant.name || 'Energrid Demo' }}</small>
        <small v-if="siteSwitchError" role="alert">{{ siteSwitchError }}</small>
      </section>
    </aside>

    <section class="app-main">
      <header class="topbar">
        <div class="top-actions">
          <div class="notification-area">
            <button
              class="icon-button"
              type="button"
              aria-label="Notifications"
              @click="toggleNotifications"
            >
              <span aria-hidden="true">●</span>
            </button>
            <div v-if="notificationsOpen" class="popover notification-popover">
              <strong>Notifications</strong>
              <ul>
                <li
                  v-for="notification in notifications"
                  :key="notification.text"
                >
                  <span :class="['dot', notification.tone]"></span>
                  {{ notification.text }}
                </li>
              </ul>
            </div>
          </div>
          <button
            class="icon-button"
            type="button"
            :aria-label="
              theme === 'light' ? 'Use dark theme' : 'Use light theme'
            "
            @click="toggleTheme"
          >
            <span aria-hidden="true">{{ theme === 'light' ? '☾' : '☼' }}</span>
          </button>
          <div class="user-menu">
            <button
              class="avatar-button"
              type="button"
              aria-label="Account menu"
              @click="toggleUserMenu"
            >
              <span>{{ userInitials }}</span>
            </button>
            <div v-if="userMenuOpen" class="popover user-popover">
              <strong>{{ user?.name }}</strong>
              <span>{{ user?.email }}</span>
              <button class="secondary wide" type="button" @click="logout">
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <section class="workspace">
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

        <section
          v-else-if="activePage === 'systems'"
          class="panel workspace-panel"
        >
          <div class="page-heading">
            <p class="eyebrow">Site Intelligence</p>
            <h2>Systems</h2>
            <span
              >Higher-level things the assistant can reason about: climate
              layers, inventory vision, forecast learning, and future energy
              behavior.</span
            >
          </div>

          <div class="system-grid">
            <article
              v-for="system in siteSystems"
              :key="system.id"
              class="system-card"
            >
              <div class="system-card-head">
                <div>
                  <span>{{ system.kind.replaceAll('_', ' ') }}</span>
                  <h3>{{ system.displayName }}</h3>
                </div>
                <strong
                  >{{
                    Math.round(system.learning.currentConfidence * 100)
                  }}%</strong
                >
              </div>
              <p>{{ system.learning.objective }}</p>
              <dl class="device-facts">
                <div>
                  <dt>Capabilities</dt>
                  <dd>
                    {{
                      system.capabilities
                        .map((capability) => capability.kind)
                        .join(', ')
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Response</dt>
                  <dd>
                    {{
                      system.responseProfile.thermalLagMinutes
                        ? `${system.responseProfile.thermalLagMinutes} min lag`
                        : system.responseProfile.latencyMs
                          ? `${system.responseProfile.latencyMs}ms`
                          : 'learning'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd>
                    {{
                      system.policy.safeRange
                        ? `${system.policy.safeRange.min}-${system.policy.safeRange.max}${system.policy.safeRange.unit}`
                        : system.policy.notes || 'read-only'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Signals</dt>
                  <dd>{{ system.learning.signals.slice(0, 3).join(', ') }}</dd>
                </div>
              </dl>
            </article>
          </div>
        </section>

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
        <section
          v-else-if="activePage === 'executions'"
          class="panel workspace-panel"
        >
          <div class="page-heading split-heading">
            <div>
              <p class="eyebrow">Operations</p>
              <h2>Executions</h2>
              <span>
                Review device commands from request to telemetry, verification,
                and settlement.
              </span>
            </div>

            <button class="primary" type="button" @click="loadState">
              Refresh executions
            </button>
          </div>

          <div v-if="!state?.executionTraces?.length" class="discovery-empty">
            <strong>No executions yet</strong>
            <span> Run a device command to generate execution history. </span>
          </div>

          <div v-else class="network-table-wrap">
            <table class="network-table execution-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Duration</th>
                  <th>Completed</th>
                </tr>
              </thead>

              <tbody>
                <tr
                  v-for="trace in visibleExecutions"
                  :key="trace.id"
                  class="execution-row"
                  @click="openExecutionTrace(trace.id)"
                >
                  <td>
                    <strong>{{ trace.deviceId }}</strong>
                  </td>

                  <td>
                    <strong>
                      {{ trace.actor?.name || trace.actor?.type || 'unknown' }}
                    </strong>
                  </td>

                  <td>
                    {{ trace.action }}
                  </td>

                  <td>
                    <span :class="['trust-pill', `execution-${trace.outcome}`]">
                      {{ trace.outcome }}
                    </span>
                  </td>

                  <td>{{ trace.durationMs || 0 }}ms</td>

                  <td>
                    {{ trace.completedAt || trace.requestedAt }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section
          v-else-if="activePage === 'logs'"
          class="panel workspace-panel"
        >
          <div class="page-heading split-heading">
            <div>
              <p class="eyebrow">Operations</p>
              <h2>Logs</h2>
              <span
                >Follow device commands, MQTT adapter decisions,
                acknowledgements, and portal-side diagnostics in one
                timeline.</span
              >
            </div>
            <button class="primary" type="button" @click="loadState">
              Refresh logs
            </button>
          </div>

          <div
            style="display: flex; gap: 8px; margin: 18px 0; flex-wrap: wrap"
            role="group"
            aria-label="Log views"
          >
            <button
              type="button"
              :class="logView === 'events' ? 'primary' : ''"
              :aria-pressed="logView === 'events'"
              @click="logView = 'events'"
            >
              Events
            </button>
            <button
              type="button"
              :class="logView === 'interactions' ? 'primary' : ''"
              :aria-pressed="logView === 'interactions'"
              @click="logView = 'interactions'"
            >
              Interactions
            </button>
          </div>

          <template v-if="logView === 'events'">
          <div class="network-stat-grid compact-stats log-summary">
            <div v-for="item in logSummary" :key="item.label">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
              <small>{{ item.detail }}</small>
            </div>
          </div>

          <div class="device-inventory-toolbar log-toolbar">
            <label class="inventory-search">
              <span class="search-icon">⌕</span>
              <input
                v-model="logSearch"
                placeholder="Search logs, topics, devices"
              />
            </label>
            <select v-model="logLevelFilter">
              <option value="all">All levels</option>
              <option value="error">Errors</option>
              <option value="warn">Warnings</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </select>
            <select v-model="logSourceFilter">
              <option value="all">All sources</option>
              <option
                v-for="source in logSources"
                :key="source"
                :value="source"
              >
                {{ source }}
              </option>
            </select>
            <span>{{ visibleLogEntries.length }} shown</span>
          </div>

          <div v-if="visibleLogEntries.length === 0" class="discovery-empty">
            <strong>No logs match this view</strong>
            <span
              >Run a device command, refresh the bus, or clear the
              filters.</span
            >
          </div>
          <div v-else class="network-table-wrap">
            <table class="network-table log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Source</th>
                  <th>Event</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in visibleLogEntries" :key="entry.id">
                  <td data-label="Time">
                    <strong>{{ formatLogTime(entry.observedAt) }}</strong>
                    <span>{{ entry.observedAt }}</span>
                  </td>
                  <td data-label="Level">
                    <span :class="['trust-pill', `log-${entry.level}`]">
                      {{ entry.level }}
                    </span>
                  </td>
                  <td data-label="Source">
                    <strong>{{ entry.source }}</strong>
                    <span>{{ logMeta(entry) || 'site runtime' }}</span>
                  </td>
                  <td data-label="Event">
                    <strong>{{ entry.event }}</strong>
                    <span>{{ entry.status || 'recorded' }}</span>
                  </td>
                  <td data-label="Message">
                    <strong>{{ entry.message }}</strong>
                    <span v-if="logDetails(entry)">{{
                      logDetails(entry)
                    }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          </template>

          <InteractionTraces
            v-else
            :api-base="apiBase"
            :access-token="accessToken"
          />
        </section>

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
      </section>

      <ExecutionTimelineModal
        :trace="selectedExecutionTrace"
        @close="closeExecutionTrace"
        @recommendation="handleExecutionRecommendation"
      />
    </section>
    <EnergridChatWidget
      v-if="accessToken"
      :api-base="apiBase"
      :access-token="accessToken"
      @turn-completed="handleAssistantTurnCompleted"
    />
  </main>
</template>
