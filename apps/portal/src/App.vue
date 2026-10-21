<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import NetworkDiscoveryCard from './components/discovery/NetworkDiscoveryCard.vue';
import NetworkIntelligencePanel from './components/discovery/NetworkIntelligencePanel.vue';
import { cloudEvidenceConsentMessage, networkEndpointInvestigationKey, type NetworkEndpointInvestigationState, type NetworkEndpointInvestigationResult } from './components/discovery/network-endpoint-investigation';
import { resolveNetworkEndpointLifecycle } from './components/discovery/network-endpoint-lifecycle';
import PendingEnrollmentList from './components/discovery/PendingEnrollmentList.vue';
import { buildPendingEnrollmentCards } from './components/discovery/pending-enrollment';
import './discovery.css';
import ExecutionTimelineModal from './components/execution/ExecutionTimelineModal.vue';
import WeatherDashboard from './components/weather/WeatherDashboard.vue';
import EnergyDashboard from './components/energy/EnergyDashboard.vue';
import DeviceControlSetup from './components/devices/DeviceControlSetup.vue';
import DeviceSwitchControl from './components/devices/DeviceSwitchControl.vue';
import DeviceConnectionDiagnostics from './components/devices/DeviceConnectionDiagnostics.vue';
import DeviceNetworkIdentityPanel from './components/devices/DeviceNetworkIdentityPanel.vue';
import DeviceCommissioning from './components/devices/DeviceCommissioning.vue';
import {
  microphoneRequestError,
  microphoneSetupError,
  stopMicrophoneStream,
} from './voice-microphone';
import { closeCompletedTurnSocket } from './voice-turn-socket';
import { diagnoseVoicePerformance } from './voice-performance-diagnosis';
import { filterInventoryDevices, inventoryConnectionStatus, isExampleDevice, needsControlSetup } from './components/devices/device-inventory';
import { matchNetworkDevice, hasVerifiedEnrolledNetworkIdentity } from './components/devices/device-network';
import { canSwitchDevice, controlRouteLabel } from './components/devices/device-control';
import type { DeviceControlState } from '@energrid/domain-devices';
import { pageFromPath, pathForPage } from './portal-route';

type LoginResponse = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
};

type PortalExecutionTrace = {
  id: string;
  commandId: string;
  deviceId: string;
  actor?: {
    type: string;
    name?: string;
  };
  action: string;
  expectedValues: Record<string, unknown>;
  requestedAt: string;
  completedAt: string | null;
  outcome: string;
  durationMs: number | null;
  stages: Array<{
    stage: string;
    status: string;
    observedAt: string;
    message: string;
    evidence?: Record<string, unknown>;
  }>;
};

import type { PendingIdentityInput } from './components/discovery/pending-enrollment';

type PortalState = {
  pendingDeviceIdentities?: Record<string, PendingIdentityInput>;
  executionTraces?: PortalExecutionTrace[];
  tenant: { id: string; name: string };
  site: { id: string; name: string; mode: string };
  sites?: Array<{
    id: string;
    name: string;
    gatewayIds: string[];
    deviceCount: number;
    systemCount: number;
  }>;
  gateways?: Array<{
    id: string;
    siteId: string;
    transport: 'mqtt' | 'http' | 'local';
    broker?: string;
    topicPrefix?: string;
    status: 'online' | 'offline' | 'unknown';
  }>;
  zones: Array<{
    id: string;
    name: string;
    sensors: Array<{
      id: string;
      name: string;
      capability: string;
      value: number | boolean | null;
      unit?: string;
      observedAt: string;
      source: string;
    }>;
  }>;
  devices?: Array<{
    id: string;
    tenantId: string;
    siteId: string;
    siteName: string;
    gatewayId?: string;
    displayName: string;
    kind: 'logical' | 'physical';
    zoneId: string;
    zoneName: string;
    trustStatus: 'discovered' | 'approved' | 'blocked';
    assistantEnabled?: boolean;
    settingsUrl?: string;
    commissioning?: { physicalOutcome: 'not_confirmed' | 'confirmed'; confirmedAt: string | null };
    responseProfile?: { learningEnabled?: boolean };
    capabilities: Array<{
      kind: string;
      actions: string[];
      unit?: string;
    }>;
    adapter: {
      id: string;
      protocol: string;
      transport?: string;
      driver: string;
      configured: boolean;
      target?: string;
      bridge?: string;
      eventTopicPrefix?: string;
      commandTopic?: string;
      stateTopic?: string;
      telemetryTopic?: string;
      statusTopic?: string;
    };
    control?: DeviceControlState;
    state: {
      values: Record<string, number | boolean | string | null>;
      observedAt: string | null;
      source: string;
      status: string;
      command?: {
        id: string;
        action: 'turn_on' | 'turn_off' | string;
        status: 'pending' | 'acked' | 'no_ack' | 'failed';
        requestedAt: string;
        expectedValues: Record<string, number | boolean | string | null>;
        message?: string;
      };
    };
    discovery?: {
      source: string;
      confidence: number;
      suggestedRoom?: string;
      suggestedName?: string;
      reason: string;
    };
    memberDeviceIds?: string[];
    metadata?: Record<string, string | number | boolean>;
  }>;
  networkZones?: Array<{
    id: string;
    name: string;
    cidr?: string;
    interfaceName?: string;
    seedIps: string[];
    role?: string;
  }>;
  networkDevices?: Array<{
    id: string;
    ipAddress: string;
    networkZoneId: string;
    networkZoneName: string;
    macAddress?: string;
    deviceReportedMacAddress?: string;
    identityConflict?: {
      reason: 'multiple_macs_for_endpoint';
      macAddresses: string[];
    };
    hostname?: string;
    vendor?: string;
    protocol: string;
    confidence: number;
    status: string;
    settingsUrl?: string;
    model?: string;
    app?: string;
    generation?: number;
    components?: Array<{ component: string; channel: number }>;
    discoveredAt: string;
    reason: string;
    observations?: Array<{
      source: 'icmp' | 'dns' | 'tcp' | 'http_rpc';
      attribute: string;
      value: string | number | boolean;
      observedAt: string;
    }>;
  }>;
  deviceSummary?: {
    total: number;
    approved: number;
    discovered: number;
    controllable: number;
    sensors: number;
    systems: number;
    learningEnabled: number;
  };

  deviceDiagnostics?: Array<{
    deviceId: string;
    category: string;
    severity: string;
    recommendation?: string;
    explanation: string;
    evidence: {
      network: unknown;
      registry: unknown;
      telemetry: unknown;
    };
    match?: {
      confidence: number;
      reason: string;
    };
  }>;

  bus?: {
    mqtt: {
      enabled: boolean;
      status: 'disabled' | 'running' | 'stopped';
      broker: {
        host: string;
        port: string;
      };
      prefix: string;
      subscriptions: string[];
      legacyTemperatureTopics: string[];
      recentMessages: Array<{
        topic: string;
        payloadPreview: string;
        payloadBytes: number;
        observedAt: string;
        validJson: boolean;
        handled: boolean;
        reason: string;
      }>;
    };
  };
  logs?: Array<{
    id: string;
    observedAt: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    source:
      | 'device-control'
      | 'mqtt-ingest'
      | 'device-registry'
      | 'portal'
      | 'voice';
    event: string;
    message: string;
    deviceId?: string;
    topic?: string;
    status?: string;
    details?: Record<string, string | number | boolean | null>;
  }>;
  systems?: Array<{
    id: string;
    tenantId: string;
    siteId: string;
    siteName: string;
    gatewayId?: string;
    displayName: string;
    kind: string;
    zoneId?: string;
    zoneName?: string;
    deviceIds: string[];
    capabilities: Array<{
      kind: string;
      actions: string[];
      unit?: string;
      description?: string;
    }>;
    responseProfile: {
      latencyMs?: number;
      thermalLagMinutes?: number;
      minCycleMinutes?: number;
      confidence: number;
      learningEnabled: boolean;
      notes?: string;
    };
    policy: {
      requiresApproval: boolean;
      confirmationRequiredFor: string[];
      safeRange?: {
        min?: number;
        max?: number;
        unit?: string;
      };
      notes?: string;
    };
    learning: {
      enabled: boolean;
      objective: string;
      signals: string[];
      currentConfidence: number;
    };
    state: {
      values: Record<string, number | boolean | string | null>;
      observedAt: string | null;
      source: string;
      status: string;
    };
  }>;
  voice: { websocketPath: string; provider: string };
};

type VoiceConfig = {
  sttProvider: string;
  openaiBatchModel: string;
  localWhisperFallbackToOpenAI: boolean;
  localWhisperWorker?: boolean;
  localWhisperModel: string;
  localWhisperLanguage: string;
};

type PortalDevice = NonNullable<PortalState['devices']>[number];
type NetworkDevice = NonNullable<PortalState['networkDevices']>[number];
type NetworkSnapshot = {
  scanId: string; schemaVersion: number; startedAt: string; completedAt: string;
  collector: { id: string; host: string; interfaces: string[] };
  scopes: Array<{ id: string; name: string; cidr?: string; interfaceName?: string; complete: boolean; gatewayIpsObserved: string[] }>;
  methods: string[]; successes: number; failures: string[]; limitations: string[]; endpoints: NetworkDevice[];
  topology: { relationships: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }> };
  runtime?: NetworkRuntime;
};
type NetworkSnapshotDiff = {
  fromScanId: string; toScanId: string; comparableScopes: string[]; incompleteScopes: string[];
  addedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  notDetectedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  verifiedAddressChanges: Array<{ identity: string; from: string; to: string }>;
  ipReuse: Array<{ scopeId: string; ipAddress: string; previousIdentity?: string; currentIdentity?: string }>;
  serviceChanges: Array<{ scopeId: string; ipAddress: string; added: string[]; removed: string[] }>;
  scopeChanges: Array<{ scopeId: string; previousCidr?: string; currentCidr?: string; previousInterface?: string; currentInterface?: string }>;
  macChanges: Array<{ identity: string; previousObservedMac?: string; currentObservedMac?: string; previousDeviceReportedMac?: string; currentDeviceReportedMac?: string }>;
  gatewayChanges: Array<{ scopeId: string; previous: string[]; current: string[] }>;
  identityChanges: Array<{ scopeId: string; ipAddress: string; previous: string; current: string }>;
  topologyChanges: { added: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }>; removed: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }> };
};
type NmapCapability = { available: boolean; enabled: boolean; version?: string; reason?: string };
type NetworkRuntime = {
  observedAt: string;
  observer: { id: string; host: string; platform: string };
  interfaces: Array<{ name: string; internal: boolean; macAddress?: string; addresses: Array<{ family: string; address: string; netmask?: string; prefixLength?: number; cidr?: string }> }>;
  routes: Array<{ destination: string; family: string; gateway?: string; interfaceName?: string; sourceAddress?: string; evidence: string }>;
  localScopes: Array<{ cidr: string; interfaceName: string }>;
  configuredScopes: Array<{ id: string; name: string; cidr?: string; interfaceName?: string; reachability: string; boundedScanEligible: boolean; reason: string }>;
  capabilities: Array<{ id: string; available: boolean; detail: string }>;
  limitations: string[];
};


function deviceHasSsh(device: NetworkDevice): boolean {
  return device.observations?.some(
    observation =>
      observation.source === 'tcp' &&
      observation.attribute === 'port.22.open' &&
      observation.value === true
  ) === true;
}

function sshCommand(device: NetworkDevice): string {
  return `ssh ${device.ipAddress}`;
}

async function copySshCommand(device: NetworkDevice): Promise<void> {
  try {
    await navigator.clipboard.writeText(sshCommand(device));
    appendLog(`[discovery] copied SSH command for ${device.id}`);
  } catch {
    window.prompt('Copy SSH command:', sshCommand(device));
  }
}



type KnownNetworkDevice = {
  schemaVersion: 1;
  identity: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastScanId: string;
  device: NetworkDevice;
};

type DiscoveryMemoryResponse = {
  summary: {
    lastScanId: string | null;
    known: number;
    observedInLatestScan: number;
    notObservedInLatestScan: number;
  };
  devices: KnownNetworkDevice[];
};
type PortalSystem = NonNullable<PortalState['systems']>[number];
type MqttDebugMessage = NonNullable<
  PortalState['bus']
>['mqtt']['recentMessages'][number];
type OperationalLogEntry = NonNullable<PortalState['logs']>[number];
type MqttTreeNode = {
  key: string;
  topic: string;
  label: string;
  depth: number;
  messageCount: number;
  directMessageCount: number;
  childCount: number;
  lastMessage: MqttDebugMessage | null;
  subscription: boolean;
};

type MqttPipelineStep = {
  id: string;
  label: string;
  detail: string;
  status: 'passed' | 'warning' | 'failed' | 'idle';
};

type VoiceMetrics = {
  totalMs?: number | null;
  sttMs?: number | null;
  firstTextMs?: number | null;
  firstAudioMs?: number | null;
  assistantCompleteMs?: number | null;
  speechGatePassed?: boolean | null;
  audioRmsDb?: number | null;
  audioPeakDb?: number | null;
  llmFirstDeltaMs?: number | null;
  firstTtsDurationMs?: number | null;
  ttsTotalMs?: number | null;
  commandFastPath?: boolean | null;
  chunkCount?: number | null;
};

type VoiceRunRecord = {
  id: string;
  completedAt: string;
  transcript: string;
  assistantReply: string;
  intent: string | null;
  plan?: {
    actions?: Array<{ type?: string; deviceId?: string; description?: string }>;
    requiresConfirmation?: boolean;
  } | null;
  executionResults?: Array<{
    status?: string;
    adapter?: string;
    message?: string;
  }>;
  metrics?: VoiceMetrics;
  runtime?: {
    sttProvider?: string;
    localWhisperModel?: string;
  };
  errors?: string[];
};

const tokenKey = 'energrid.portal.token';
const userKey = 'energrid.portal.user';
const themeKey = 'energrid.portal.theme.v2';
const endpointModeKey = 'energrid.portal.endpointMode';

function cleanBaseUrl(url: string) {
  return url.replace(/\/$/, '');
}

function voiceUrlFromApiBase(baseUrl: string) {
  if (!baseUrl)
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice`;
  const url = new URL('/voice', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

const apiBase = cleanBaseUrl(import.meta.env.VITE_API_BASE_URL || '');
const defaultWsBase =
  import.meta.env.VITE_VOICE_WS_URL || voiceUrlFromApiBase(apiBase);
const isLocalLivePreview =
  import.meta.env.VITE_BACKEND_LABEL === 'local-live';

const email = ref('');
const password = ref('');
const loginError = ref('');
const accessToken = ref(localStorage.getItem(tokenKey) || '');
const user = ref<LoginResponse['user'] | null>(
  localStorage.getItem(userKey)
    ? JSON.parse(localStorage.getItem(userKey) || 'null')
    : null,
);
const state = ref<PortalState | null>(null);
const loadingState = ref(false);
const stateError = ref('');
const scanningNetwork = ref(false);
const scanStartedAt = ref(0);
const scanElapsedSeconds = ref(0);
const scanFeedback = ref('');
let scanTimer: ReturnType<typeof setInterval> | undefined;
let networkScanAbortController: AbortController | undefined;
const discoveryMemory = ref<DiscoveryMemoryResponse | null>(null);
const discoveryMemoryLoading = ref(false);
const discoveryMemoryError = ref('');
const discoveryMemoryExpanded = ref(false);
const networkSnapshots = ref<NetworkSnapshot[]>([]);
const latestNetworkSnapshot = ref<NetworkSnapshot | null>(null);
const networkSnapshotComparison = ref<NetworkSnapshotDiff | null>(null);
const networkSnapshotsError = ref('');
const networkEndpointInvestigations = ref<Record<string, NetworkEndpointInvestigationState>>({});
const nmapCapability = ref<NmapCapability | null>(null);
const networkRuntime = ref<NetworkRuntime | null>(null);
const discoveryDecisionBusy = ref<Record<string, string>>({});
const findingHttpPageByDeviceId = ref<Record<string, boolean>>({});
const discoveryView = ref<'capable' | 'all'>('all');
const mqttTopicFilter = ref('');
const mqttPublishTopic = ref('');
const mqttPublishPayload = ref('{"type":"debug_ping","source":"portal"}');
const mqttPublishBusy = ref(false);
const mqttPublishError = ref('');
const mqttBusLoading = ref(false);
const mqttBusStreamStatus = ref<
  'idle' | 'connecting' | 'live' | 'error' | 'closed'
>('idle');
const selectedMqttTopic = ref('');
const expandedMqttTopics = ref<Set<string>>(new Set());

const wsUrl = ref(defaultWsBase);
const voiceStatus = ref('idle');
const voiceSetupError = ref('');
const transcript = ref('');
const assistant = ref('');
const plan = ref('');
const pendingVoiceAction = ref<{
  approvalId: string;
  expiresAt: number;
  actions: Array<{
    type: string;
    deviceId: string | null;
    room: string | null;
    value: string | number | null;
    risk: string;
  }>;
} | null>(null);
const voiceActionOutcome = ref('');
const eventLog = ref<string[]>([]);
const metrics = ref<VoiceMetrics | null>(null);
const voiceRuns = ref<VoiceRunRecord[]>([]);
const voiceRunsLoading = ref(false);
const voiceRunsError = ref('');
const connected = ref(false);
const recording = ref(false);
const theme = ref(localStorage.getItem(themeKey) || 'dark');
const endpointMode = ref(
  isLocalLivePreview
    ? 'same-origin'
    : localStorage.getItem(endpointModeKey) || 'same-origin',
);
const userMenuOpen = ref(false);
const notificationsOpen = ref(false);
const mobileMenuOpen = ref(false);
const activePage = ref(pageFromPath(location.pathname));
const selectedDeviceId = ref<string | null>(null);
const selectedExecutionTraceId = ref<string | null>(null);
const deviceActionBusy = ref<Record<string, boolean>>({});
const deviceActionError = ref<Record<string, string>>({});
const deviceSheet = ref<HTMLElement | null>(null);
const deviceTableWrap = ref<HTMLElement | null>(null);
const deviceApprovalFilter = ref<'approved' | 'discovered'>('approved');
const deviceSourceFilter = ref('site');
const deviceSearch = ref('');
const deviceCapabilityFilter = ref('all');
const deviceZoneFilter = ref('all');
const deviceStatusFilter = ref('all');
const logLevelFilter = ref('all');
const logSourceFilter = ref('all');
const logSearch = ref('');
const clientTrace = ref({
  connectStartAt: 0,
  connectedAt: 0,
  recordStartAt: 0,
  releaseAt: 0,
  firstServerEventAt: 0,
  firstTranscriptAt: 0,
  firstAssistantTextAt: 0,
  firstAudioAt: 0,
  audioChunksSent: 0,
  audioBytesSent: 0,
  maxClientPeak: 0,
  sumSquares: 0,
  sampleCount: 0,
});

const navItems = computed(() => [
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

let ws: WebSocket | null = null;
let voiceAuthenticated = false;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let recordingAttempt = 0;
let source: MediaStreamAudioSourceNode | null = null;
let processor: ScriptProcessorNode | null = null;
let pcmQueue: number[] = [];
let mqttBusEvents: EventSource | null = null;

const sampleRate = 16000;
const flushSamples = 4096;
const lanPortalUrl = 'http://192.168.1.60';
const lanWsUrl = 'ws://192.168.1.60/voice';

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
const voiceLinkStatus = computed(() => {
  if (connected.value) return { label: 'connected', tone: 'green' };
  if (['idle', 'turn complete'].includes(voiceStatus.value))
    return { label: 'standby', tone: 'blue' };
  return { label: 'offline', tone: 'amber' };
});
const canUseLanDirect = computed(() => location.protocol === 'http:');
const effectiveRouteLabel = computed(() => {
  if (endpointMode.value === 'lan')
    return canUseLanDirect.value ? 'LAN direct' : 'LAN needs HTTP/local HTTPS';
  return 'Public domain';
});
const effectiveWsUrl = computed(() => {
  if (endpointMode.value === 'lan' && canUseLanDirect.value) return lanWsUrl;
  return defaultWsBase;
});
const compactMetrics = computed(() => {
  const m = metrics.value;
  if (!m) return [];
  return [
    { label: 'Total', value: formatMs(m.totalMs) },
    { label: 'STT', value: formatMs(m.sttMs) },
    {
      label: 'First text',
      value: formatMs(m.llmFirstDeltaMs ?? m.firstTextMs),
    },
    { label: 'First audio', value: formatMs(m.firstAudioMs) },
    { label: 'TTS', value: formatMs(m.ttsTotalMs) },
    { label: 'Gate', value: m.speechGatePassed ? 'passed' : 'blocked' },
    { label: 'RMS', value: formatDb(m.audioRmsDb) },
    { label: 'Peak', value: formatDb(m.audioPeakDb) },
    { label: 'Chunks', value: `${m.chunkCount ?? 0}` },
  ];
});
const clientDiagnostics = computed(() => {
  const trace = clientTrace.value;
  const clientRms = trace.sampleCount
    ? 20 *
      Math.log10(Math.sqrt(trace.sumSquares / trace.sampleCount) || 0.000001)
    : null;
  return [
    {
      label: 'Socket open',
      value: delta(trace.connectStartAt, trace.connectedAt),
    },
    { label: 'Held', value: delta(trace.recordStartAt, trace.releaseAt) },
    {
      label: 'Server wait',
      value: delta(trace.releaseAt, trace.firstServerEventAt),
    },
    {
      label: 'First transcript',
      value: delta(trace.releaseAt, trace.firstTranscriptAt),
    },
    {
      label: 'First assistant',
      value: delta(trace.releaseAt, trace.firstAssistantTextAt),
    },
    { label: 'First audio', value: delta(trace.releaseAt, trace.firstAudioAt) },
    { label: 'Sent chunks', value: `${trace.audioChunksSent}` },
    { label: 'Sent audio', value: formatBytes(trace.audioBytesSent) },
    { label: 'Client RMS', value: formatDb(clientRms) },
    {
      label: 'Client peak',
      value: formatDb(amplitudeToDb(trace.maxClientPeak)),
    },
  ];
});
const bottleneckMessage = computed(() => {
  return diagnoseVoicePerformance(metrics.value, transcript.value, voiceSetupError.value);
});
const deviceCards = computed(() => state.value?.devices || []);

const enrolledDeviceKeys = ref<Set<string>>(new Set());
const enrollmentStatuses = ref<Map<string, 'enrolled' | 'suspended' | 'retired'>>(new Map());
const enrollmentError = ref('');

function deviceEnrollmentStatus(device: PortalDevice): 'enrolled' | 'suspended' | 'retired' | 'not_enrolled' | 'unknown' {
  if (enrollmentError.value) return 'unknown';
  return enrollmentStatuses.value.get(JSON.stringify([device.tenantId, device.siteId, device.id])) || 'not_enrolled';
}

const enrolledInventoryDevices = computed(() =>
  deviceCards.value.filter(device =>
    device.trustStatus === 'approved' &&
    enrolledDeviceKeys.value.has(
      JSON.stringify([device.tenantId, device.siteId, device.id]),
    ),
  ),
);

const retiredInventoryDevices = computed(() =>
  deviceCards.value.filter(device =>
    device.trustStatus === 'approved' &&
    enrollmentStatuses.value.get(JSON.stringify([device.tenantId, device.siteId, device.id])) === 'retired',
  ),
);

const inventoryDeviceSummary = computed(() => {
  const devices = enrolledInventoryDevices.value;
  const ids = new Set(devices.map(device => device.id));

  return {
    total: devices.length,
    approved: devices.length,
    controllable: devices.filter(canSwitchDevice).length,
    sensors: devices.filter(device =>
      device.capabilities.some(capability =>
        capability.actions.includes('read'),
      ),
    ).length,
    systems: (state.value?.systems || []).filter(system =>
      system.deviceIds.some(id => ids.has(id)),
    ).length,
    learningEnabled: devices.filter(device =>
      device.responseProfile?.learningEnabled === true,
    ).length,
  };
});
const approvedDevices = computed(() =>
  deviceCards.value.filter((device) => device.trustStatus === 'approved'),
);
const deviceCapabilityOptions = computed(() => {
  const capabilities = new Set<string>();
  for (const device of enrolledInventoryDevices.value) {
    for (const capability of device.capabilities)
      capabilities.add(capability.kind);
  }
  return [...capabilities].sort((left, right) => left.localeCompare(right));
});
const deviceZoneOptions = computed(() => {
  const zones = new Map<string, string>();
  for (const device of enrolledInventoryDevices.value)
    zones.set(device.zoneId, device.zoneName);
  return [...zones.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
});
const filteredInventoryDevices = computed(() => filterInventoryDevices(enrolledInventoryDevices.value, {
  approval: 'approved',
  source: deviceSourceFilter.value,
  search: deviceSearch.value,
  capability: deviceCapabilityFilter.value,
  zone: deviceZoneFilter.value,
  status: deviceStatusFilter.value,
}));
const hasInventoryFilters = computed(() => !!deviceSearch.value || deviceSourceFilter.value !== 'site' || deviceCapabilityFilter.value !== 'all' || deviceZoneFilter.value !== 'all' || deviceStatusFilter.value !== 'all');

watch([deviceSearch, deviceSourceFilter, deviceCapabilityFilter, deviceZoneFilter, deviceStatusFilter, deviceApprovalFilter], () => {
  if (deviceTableWrap.value) {
    deviceTableWrap.value.scrollTop = 0;
    deviceTableWrap.value.scrollLeft = 0;
  }
}, { flush: 'post' });

function clearInventoryFilters() {
  deviceSearch.value = '';
  deviceSourceFilter.value = 'site';
  deviceCapabilityFilter.value = 'all';
  deviceZoneFilter.value = 'all';
  deviceStatusFilter.value = 'all';
}
const discoveredDevices = computed(() =>
  deviceCards.value.filter((device) => device.trustStatus === 'discovered'),
);
const pendingEnrollmentCards = computed(() => buildPendingEnrollmentCards(
  discoveredDevices.value,
  state.value?.pendingDeviceIdentities ?? {},
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

const networkEndpointLifecycle = computed(() => (latestNetworkSnapshot.value?.endpoints || []).map(endpoint =>
  resolveNetworkEndpointLifecycle(
    endpoint,
    pendingEnrollmentCards.value,
    enrolledInventoryDevices.value,
    approvedDevices.value,
  ),
));

const deviceDiagnostics = computed(() => state.value?.deviceDiagnostics || []);

const diagnosticSummary = computed(() => ({
  total: deviceDiagnostics.value.length,
  errors: deviceDiagnostics.value.filter((item) => item.severity === 'error')
    .length,
  warnings: deviceDiagnostics.value.filter(
    (item) => item.severity === 'warning',
  ).length,
}));
const deviceSourceStats = computed(() => {
  const busBacked = deviceCards.value.filter((device) =>
    ['mqtt', 'zigbee', 'matter', 'modbus'].includes(
      device.adapter.transport || device.adapter.protocol,
    ),
  ).length;
  const needsSetup = deviceCards.value.filter(needsControlSetup).length;
  return [
    {
      label: 'Received',
      value: `${deviceCards.value.length}`,
      detail: 'from portal state',
    },
    {
      label: 'Bus-backed',
      value: `${busBacked}`,
      detail: 'MQTT or bridge adapters',
    },
    {
      label: 'Pending',
      value: `${discoveredDevices.value.length}`,
      detail: 'needs approval',
    },
    {
      label: 'Control setup',
      value: `${needsSetup}`,
      detail: 'approved switches without control',
    },
  ];
});
const networkZones = computed(() => state.value?.networkZones || []);

type AiEvidenceRecord = {
  id: string;
  source: string;
  attribute: string;
  value: string | number | boolean;
  observedAt: string;
  confidence: string;
};

type AiHypothesis = {
  id: string;
  claim: string;
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  missingEvidence: string[];
};

type AiInvestigationProposal = {
  id: string;
  action: string;
  reason: string;
  requiredEvidenceIds: string[];
  requiresApproval: true;
  status: 'proposed';
};

type AiInvestigationResult = {
  investigationId?: string;
  parentInvestigationId?: string;
  actionResult?: { action: string; outcome: string; reasonCode: string; statusCode?: number };
  deviceId: string;
  provider: string;
  model: string;
  assessment?: {
    schemaVersion: 1;
    deviceId: string;
    snapshotId: string;
    hypotheses: AiHypothesis[];
    proposals: AiInvestigationProposal[];
  };
  evidenceSnapshot?: {
    id: string;
    schemaVersion: 1;
    deviceId: string;
    createdAt: string;
    evidence: AiEvidenceRecord[];
  };
  report: {
    summary: string;
    findings: string[];
    unknowns: string[];
    nextSteps: string[];
  };
};

type MqttProfileHistoryRecord = {
  schemaVersion: 1;
  kind: 'mqtt-observation-profile';
  id: string;
  deviceId: string;
  createdAt: string;
  result: {
    provider: string;
    model: string;
    proposal: {
      status: 'proposed';
      requiresApproval: true;
      selector: string;
      fields: Record<
        string,
        { rawKey: string; type: 'number' | 'boolean' | 'string' }
      >;
      supportingEvidenceIds: string[];
    };
    replay: {
      status: 'passed' | 'failed';
      profileStatus: 'proposed';
      installationAuthorized: false;
      testedSamples: number;
      acceptedSamples: number;
      rejectedSamples: number;
      observedFields: Record<string, number | boolean | string>;
      steps: Array<{
        evidenceId: string;
        passed: boolean;
        reason: string;
        updatedKeys: string[];
        ignoredKeys: string[];
        rejectedFields: string[];
      }>;
    };
  };
};

type AiHistoryRecord = {
  schemaVersion: 1;
  id: string;
  deviceId: string;
  createdAt: string;
  result: AiInvestigationResult;
};

const aiHistory = ref<Record<string, AiHistoryRecord[]>>({});
const aiHistoryLoading = ref<Record<string, boolean>>({});
const aiHistoryErrors = ref<Record<string, string>>({});
const selectedAiHistoryId = ref<string | null>(null);

async function loadAiHistory(deviceId: string): Promise<void> {
  if (aiHistoryLoading.value[deviceId]) return;

  aiHistoryLoading.value[deviceId] = true;
  delete aiHistoryErrors.value[deviceId];

  try {
    const response = await fetch(
      `${apiBase}/portal/network/${encodeURIComponent(deviceId)}/investigations`,
      {
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`History request failed (${response.status})`);
    }

    aiHistory.value[deviceId] =
      (await response.json()) as AiHistoryRecord[];
  } catch (error) {
    aiHistoryErrors.value[deviceId] =
      error instanceof Error ? error.message : 'History unavailable';
  } finally {
    aiHistoryLoading.value[deviceId] = false;
  }
}

function openAiHistoryRecord(record: AiHistoryRecord): void {
  selectedAiDeviceId.value = record.deviceId;
  selectedAiHistoryId.value = record.id;
  aiReports.value[record.deviceId] = record.result;
  void loadMqttProfileHistory(record.deviceId);
  void revealDeviceIntelligence();
}

const aiReports = ref<Record<string, AiInvestigationResult>>({});
const aiErrors = ref<Record<string, string>>({});
const aiInvestigating = ref<Record<string, boolean>>({});
const aiActionRunning = ref<Record<string, boolean>>({});
const aiActionErrors = ref<Record<string, string>>({});
const aiActionResults = ref<Record<string, { outcome: string; reasonCode: string; statusCode?: number }>>({});
type LlmProviderAvailability = {
  mode: 'disabled' | 'local-only' | 'cloud-enabled';
  provider: string | null;
  available: boolean;
  cloudDataConsentRequired: boolean;
  reasonCode?: string;
};
const llmProviderAvailability = ref<LlmProviderAvailability | null>(null);

async function loadLlmProviderAvailability(): Promise<LlmProviderAvailability> {
  const response = await fetch(`${apiBase}/portal/investigations/availability`, {
    headers: { Authorization: `Bearer ${accessToken.value}` },
  });
  if (!response.ok) throw new Error(`Provider status unavailable (${response.status})`);
  const status = await response.json() as LlmProviderAvailability;
  llmProviderAvailability.value = status;
  return status;
}

async function confirmCloudEvidence(status: LlmProviderAvailability): Promise<boolean> {
  if (!status.cloudDataConsentRequired) return true;
  return window.confirm(cloudEvidenceConsentMessage(status.provider));
}

async function investigateSnapshotEndpoint(request: {
  scanId: string; scopeId: string; ipAddress: string; endpointId: string;
}): Promise<void> {
  const key = networkEndpointInvestigationKey(request.scanId, request.scopeId, request.ipAddress, request.endpointId);
  if (networkEndpointInvestigations.value[key]?.loading) return;
  networkEndpointInvestigations.value = { ...networkEndpointInvestigations.value, [key]: { loading: true } };
  try {
    const provider = await loadLlmProviderAvailability();
    if (!provider.available) throw new Error(`Investigation provider unavailable (${provider.reasonCode || 'unavailable'}).`);
    if (!(await confirmCloudEvidence(provider))) return;
    const endpointUrl = [request.scanId, request.scopeId, request.ipAddress, request.endpointId]
      .map(encodeURIComponent).join('/');
    const [scanId, scopeId, ipAddress, endpointId] = endpointUrl.split('/');
    const response = await fetch(`${apiBase}/portal/network/snapshots/${scanId}/scopes/${scopeId}/endpoints/${ipAddress}/${endpointId}/investigate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudDataConsent: provider.cloudDataConsentRequired }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.message === 'string' ? body.message : `Investigation failed (${response.status})`);
    }
    const result = await response.json() as NetworkEndpointInvestigationResult;
    networkEndpointInvestigations.value = { ...networkEndpointInvestigations.value, [key]: { loading: false, result } };
  } catch (error) {
    networkEndpointInvestigations.value = {
      ...networkEndpointInvestigations.value,
      [key]: { loading: false, error: error instanceof Error ? error.message : 'Investigation failed' },
    };
  } finally {
    if (networkEndpointInvestigations.value[key]?.loading) {
      networkEndpointInvestigations.value = { ...networkEndpointInvestigations.value, [key]: { loading: false } };
    }
  }
}

const deviceIntelligencePanel = ref<HTMLElement | null>(null);

async function revealDeviceIntelligence(): Promise<void> {
  await nextTick();
  deviceIntelligencePanel.value?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}

function openDeviceIntelligenceOnly(deviceId: string): void {
  selectedAiDeviceId.value = deviceId;
  selectedAiHistoryId.value = null;

  void loadAiHistory(deviceId);
  void loadMqttProfileHistory(deviceId);
  void loadLlmProviderAvailability();
  void revealDeviceIntelligence();
}

async function investigateNetworkDeviceWithAi(device: NetworkDevice) {
  selectedAiDeviceId.value = device.id;
  selectedAiHistoryId.value = null;
  void loadAiHistory(device.id);
  void loadMqttProfileHistory(device.id);
  void revealDeviceIntelligence();

  if (aiInvestigating.value[device.id]) return;

  aiInvestigating.value[device.id] = true;
  delete aiErrors.value[device.id];
  delete aiReports.value[device.id];

  try {
    const provider = await loadLlmProviderAvailability();
    if (!provider.available) throw new Error(`Investigation provider unavailable (${provider.reasonCode || 'unavailable'}).`);
    if (!(await confirmCloudEvidence(provider))) return;
    const response = await fetch(
      `${apiBase}/portal/network/${encodeURIComponent(device.id)}/investigate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cloudDataConsent: provider.cloudDataConsentRequired }),
      },
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body.message;
      throw new Error(
        typeof message === 'string'
          ? message
          : Array.isArray(message)
            ? message.join(', ')
            : `Investigation failed (${response.status})`,
      );
    }

    aiReports.value[device.id] =
      (await response.json()) as AiInvestigationResult;

    void loadAiHistory(device.id);

    if (selectedAiDeviceId.value === device.id) {
      void revealDeviceIntelligence();
    }
  } catch (error) {
    aiErrors.value[device.id] =
      error instanceof Error ? error.message : 'Investigation failed';
  } finally {
    aiInvestigating.value[device.id] = false;
  }
}

async function executeInvestigationProposal(proposal: AiInvestigationProposal): Promise<void> {
  const deviceId = selectedAiDeviceId.value;
  const report = selectedAiReport.value;
  if (!deviceId || !report?.investigationId || aiActionRunning.value[proposal.id]) return;
  const target = selectedAiDevice.value;
  if (!target) return;
  if (proposal.action !== 'inspect_http_headers') {
    aiActionErrors.value[proposal.id] = 'This action has no supported deterministic executor yet.';
    return;
  }
  if (!window.confirm(`Energrid will send one HTTP HEAD request to ${target.ipAddress}:80 using this current LAN observation. Continue?`)) return;
  aiActionRunning.value[proposal.id] = true;
  delete aiActionErrors.value[proposal.id];
  try {
    const provider = await loadLlmProviderAvailability();
    if (!provider.available) throw new Error(`Reassessment provider unavailable (${provider.reasonCode || 'unavailable'}).`);
    if (!(await confirmCloudEvidence(provider))) return;
    const response = await fetch(
      `${apiBase}/portal/network/${encodeURIComponent(deviceId)}/investigations/${encodeURIComponent(report.investigationId)}/actions/${encodeURIComponent(proposal.id)}/execute`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ approved: true, cloudDataConsent: provider.cloudDataConsentRequired }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `Diagnostic action failed (${response.status})`);
    aiActionResults.value[proposal.id] = {
      outcome: body.outcome,
      reasonCode: body.reasonCode || body.action?.reasonCode || 'completed',
      statusCode: body.action?.result?.statusCode,
    };
    if (body.reassessment) {
      aiReports.value[deviceId] = body.reassessment as AiInvestigationResult;
      selectedAiHistoryId.value = body.reassessment.investigationId || null;
      void loadAiHistory(deviceId);
    }
  } catch (error) {
    aiActionErrors.value[proposal.id] = error instanceof Error ? error.message : 'Diagnostic action failed';
  } finally {
    aiActionRunning.value[proposal.id] = false;
  }
}

// MQTT profile investigations are separate from LAN identification.
const mqttProfileHistory =
  ref<Record<string, MqttProfileHistoryRecord[]>>({});
const mqttProfileSelected =
  ref<Record<string, MqttProfileHistoryRecord>>({});
const mqttProfileLoading = ref<Record<string, boolean>>({});
const mqttProfileRunning = ref<Record<string, boolean>>({});
const mqttProfileErrors = ref<Record<string, string>>({});

const selectedMqttProfile = computed(() =>
  selectedAiDeviceId.value
    ? mqttProfileSelected.value[selectedAiDeviceId.value] ?? null
    : null,
);

type MqttCaptureStatus = {
  enabled: boolean;
  deviceId: string;
  topics: string[];
  samplesInWindow: number;
  latestCapturedAt: string | null;
};

const kitchenCaptureStatus = ref<MqttCaptureStatus | null>(null);
const kitchenCaptureError = ref<string | null>(null);
const kitchenCaptureLoading = ref(false);

async function loadKitchenCaptureStatus(): Promise<void> {
  if (kitchenCaptureLoading.value) return;

  kitchenCaptureLoading.value = true;
  kitchenCaptureError.value = null;

  try {
    const response = await fetch(
      `${apiBase}/portal/mqtt/evidence/temp-kitchen/status`,
      {
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Evidence status failed (${response.status})`);
    }

    kitchenCaptureStatus.value =
      (await response.json()) as MqttCaptureStatus;
  } catch (error) {
    kitchenCaptureError.value =
      error instanceof Error ? error.message : 'Status unavailable';
  } finally {
    kitchenCaptureLoading.value = false;
  }
}

async function loadMqttProfileHistory(deviceId: string): Promise<void> {
  if (mqttProfileLoading.value[deviceId]) return;

  mqttProfileLoading.value[deviceId] = true;
  delete mqttProfileErrors.value[deviceId];

  try {
    const response = await fetch(
      `${apiBase}/portal/network/${encodeURIComponent(deviceId)}/profile-investigations`,
      {
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `MQTT profile history unavailable (${response.status})`,
      );
    }

    const records: unknown = await response.json();

    if (!Array.isArray(records)) {
      throw new Error('Invalid MQTT profile history response');
    }

    mqttProfileHistory.value[deviceId] =
      records as MqttProfileHistoryRecord[];
  } catch (error) {
    mqttProfileErrors.value[deviceId] =
      error instanceof Error ? error.message : 'History unavailable';
  } finally {
    mqttProfileLoading.value[deviceId] = false;
  }
}

function previewMqttProfile(deviceId: string): void {
  // Synthetic frontend-only fixture.
  // No MQTT, AI, database writes or installation privileges.
  mqttProfileSelected.value[deviceId] = {
    schemaVersion: 1,
    kind: 'mqtt-observation-profile',
    id: `synthetic-preview-${deviceId}`,
    deviceId,
    createdAt: new Date().toISOString(),
    result: {
      provider: 'offline-preview',
      model: 'synthetic-fixture-no-llm',
      proposal: {
        status: 'proposed',
        requiresApproval: true,
        selector: 'demo/esp8266/temperature',
        fields: {
          temperature: {
            rawKey: 'temperature',
            type: 'number',
          },
          humidity: {
            rawKey: 'humidity',
            type: 'number',
          },
        },
        supportingEvidenceIds: ['demo-sample-1'],
      },
      replay: {
        status: 'passed',
        profileStatus: 'proposed',
        installationAuthorized: false,
        testedSamples: 2,
        acceptedSamples: 2,
        rejectedSamples: 0,
        observedFields: {
          temperature: 25.3,
          humidity: 40.3,
        },
        steps: [
          {
            evidenceId: 'demo-sample-1',
            passed: true,
            reason: 'accepted',
            updatedKeys: ['temperature', 'humidity'],
            ignoredKeys: [],
            rejectedFields: [],
          },
          {
            evidenceId: 'demo-sample-2',
            passed: true,
            reason: 'accepted',
            updatedKeys: ['temperature'],
            ignoredKeys: [],
            rejectedFields: [],
          },
        ],
      },
    },
  };
}

async function investigateMqttProfile(deviceId: string): Promise<void> {
  if (mqttProfileRunning.value[deviceId]) return;

  mqttProfileRunning.value[deviceId] = true;
  delete mqttProfileErrors.value[deviceId];

  try {
    const provider = await loadLlmProviderAvailability();
    if (!provider.available) throw new Error(`Investigation provider unavailable (${provider.reasonCode || 'unavailable'}).`);
    if (!(await confirmCloudEvidence(provider))) return;
    const response = await fetch(
      `${apiBase}/portal/network/${encodeURIComponent(deviceId)}/profile-investigations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cloudDataConsent: provider.cloudDataConsentRequired }),
      },
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body.message;

      throw new Error(
        typeof message === 'string'
          ? message
          : Array.isArray(message)
            ? message.join(', ')
            : `Profile investigation failed (${response.status})`,
      );
    }

    const record =
      (await response.json()) as MqttProfileHistoryRecord;

    mqttProfileSelected.value[deviceId] = record;
    await loadMqttProfileHistory(deviceId);
  } catch (error) {
    mqttProfileErrors.value[deviceId] =
      error instanceof Error
        ? error.message
        : 'MQTT profile investigation failed';
  } finally {
    mqttProfileRunning.value[deviceId] = false;
  }
}

const deviceIntelligenceSearch = ref('');
const selectedAiDeviceId = ref<string | null>(null);

const selectedAiDevice = computed(() =>
  networkDevices.value.find(
    (device) => device.id === selectedAiDeviceId.value,
  ) || null,
);

const selectedAiReport = computed(() =>
  selectedAiDeviceId.value
    ? aiReports.value[selectedAiDeviceId.value]
    : null,
);

function aiEvidenceLabel(
  result: AiInvestigationResult,
  evidenceId: string,
): string {
  const evidence = result.evidenceSnapshot?.evidence.find(
    (item) => item.id === evidenceId,
  );

  if (!evidence) return `Unresolved evidence: ${evidenceId}`;

  return `${evidence.attribute} = ${String(evidence.value)} (${evidence.source})`;
}

function aiConfidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}% model estimate`;
}

const selectedAiError = computed(() =>
  selectedAiDeviceId.value
    ? aiErrors.value[selectedAiDeviceId.value]
    : null,
);

// Live scan evidence and remembered discovery history are different.
// Only live evidence may establish current reachability.
const liveNetworkDevices = computed(
  () => state.value?.networkDevices || [],
);

function networkDiscoveryIdentity(device: NetworkDevice): string {
  const mac = device.macAddress?.trim().toLowerCase();

  if (mac && mac !== 'ff:ff:ff:ff:ff:ff')
    return `mac:${mac}`;

  if (
    device.vendor === 'Shelly' &&
    device.id.toLowerCase().startsWith('shelly')
  )
    return `shelly:${device.id.toLowerCase()}`;

  return `endpoint:${device.networkZoneId}:${device.ipAddress}`;
}

// Discovery displays remembered devices immediately.
// Live observations take precedence when the same identity is encountered.
const networkDevices = computed<NetworkDevice[]>(() => {
  const live = liveNetworkDevices.value;
  const remembered = discoveryMemory.value?.devices || [];

  const liveIdentities = new Set(live.map(networkDiscoveryIdentity));
  const liveEndpoints = new Set(
    live.map(device => `${device.networkZoneId}:${device.ipAddress}`),
  );

  const historical = remembered
    .filter(record =>
      !liveIdentities.has(record.identity) &&
      !liveEndpoints.has(
        `${record.device.networkZoneId}:${record.device.ipAddress}`,
      ),
    )
    .map(record => ({
      ...record.device,
      // A historical observation never proves current connectivity.
      status: 'unknown' as NetworkDevice['status'],
    }));

  return [...live, ...historical];
});

const historicalNetworkDevices = computed(() => {
  const memory = discoveryMemory.value;
  if (!memory) return [];

  return memory.devices.map((record) => ({
    ...record,
    observedInLatestScan:
      memory.summary.lastScanId !== null &&
      record.lastScanId === memory.summary.lastScanId,
  }));
});

function discoveryMemoryDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString();
}

async function loadDiscoveryMemory() {
  if (!accessToken.value) {
    discoveryMemory.value = null;
    return;
  }

  discoveryMemoryLoading.value = true;
  discoveryMemoryError.value = '';

  try {
    const response = await fetch(`${apiBase}/portal/network/memory`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });

    if (!response.ok) {
      throw new Error(`Discovery Memory unavailable (${response.status})`);
    }

    discoveryMemory.value =
      (await response.json()) as DiscoveryMemoryResponse;
  } catch (error) {
    discoveryMemoryError.value =
      error instanceof Error ? error.message : 'Discovery Memory unavailable';
  } finally {
    discoveryMemoryLoading.value = false;
  }
}

async function loadNetworkSnapshots() {
  if (!accessToken.value) {
    networkSnapshots.value = [];
    latestNetworkSnapshot.value = null;
    networkSnapshotComparison.value = null;
    networkRuntime.value = null;
    return;
  }
  networkSnapshotsError.value = '';
  try {
    const response = await fetch(`${apiBase}/portal/network/snapshots`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (!response.ok) throw new Error(`Network snapshots unavailable (${response.status})`);
    const result = await response.json() as { snapshots: NetworkSnapshot[] };
    const capabilityResponse = await fetch(`${apiBase}/portal/network/capabilities`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (capabilityResponse.ok) {
      const capability = await capabilityResponse.json() as { nmap: NmapCapability; observer?: NetworkRuntime };
      nmapCapability.value = capability.nmap;
      networkRuntime.value = capability.observer || null;
    }
    networkSnapshots.value = result.snapshots;
    latestNetworkSnapshot.value = result.snapshots[0] || null;
    networkSnapshotComparison.value = null;
    if (result.snapshots.length > 1 && latestNetworkSnapshot.value) {
      const latest = latestNetworkSnapshot.value;
      const previous = result.snapshots.find(snapshot => snapshot.scanId !== latest.scanId &&
        snapshot.scopes.some(oldScope => latest.scopes.some(scope => scope.id === oldScope.id && scope.cidr === oldScope.cidr)));
      if (previous) {
        const comparisonResponse = await fetch(`${apiBase}/portal/network/snapshots/${encodeURIComponent(previous.scanId)}/compare/${encodeURIComponent(latest.scanId)}`, {
          headers: { Authorization: `Bearer ${accessToken.value}` },
        });
        if (comparisonResponse.ok) networkSnapshotComparison.value = await comparisonResponse.json() as NetworkSnapshotDiff;
      }
    }
  } catch (error) {
    networkSnapshotsError.value = error instanceof Error ? error.message : 'Network snapshots unavailable';
  }
}

const energridCapableNetworkDevices = computed(() =>
  networkDevices.value.filter((device) =>
    isEnergridCapableNetworkDevice(device),
  ),
);
const visibleNetworkDevices = computed(() => {
  const query = deviceIntelligenceSearch.value.trim().toLowerCase();

  // Search the complete scan, even when the Shelly filter is active.
  // This makes it possible to find an unknown host immediately.
  const base = query
    ? networkDevices.value
    : discoveryView.value === 'all'
      ? networkDevices.value
      : energridCapableNetworkDevices.value;

  if (!query) return base;

  return base.filter((device) =>
    [
      device.id,
      device.ipAddress,
      device.hostname,
      device.macAddress,
      device.vendor,
      device.model,
      device.protocol,
      device.app,
      device.reason,
      device.networkZoneName,
    ]
      .filter(Boolean)
      .some((value) =>
        String(value).toLowerCase().includes(query),
      ),
  );
});
const networkDeviceSummary = computed(() => ({
  total: networkDevices.value.length,
  capable: energridCapableNetworkDevices.value.length,
  proxyable: networkDevices.value.filter((device) => canProxyDevice(device))
    .length,
  unknown: networkDevices.value.filter(
    (device) => !isEnergridCapableNetworkDevice(device),
  ).length,
}));
const networkStats = computed(() => {
  const devices = networkDevices.value;
  const vendors = new Set(devices.map((device) => device.vendor || 'Unknown'));
  const online = devices.filter((device) => device.status === 'online').length;
  const shelly = devices.filter(
    (device) => device.vendor?.toLowerCase() === 'shelly',
  ).length;
  const capable = energridCapableNetworkDevices.value.length;

  return [
    {
      label: 'Live reachable',
      value: `${devices.length}`,
      detail: 'from site brain',
    },
    {
      label: 'Gateway ready',
      value: `${networkDeviceSummary.value.proxyable}`,
      detail: `${formatPercent(networkDeviceSummary.value.proxyable, devices.length)} proxyable`,
    },
    {
      label: 'Energrid capable',
      value: `${capable}`,
      detail: `${formatPercent(capable, devices.length)} of scan`,
    },
    {
      label: 'Shelly devices',
      value: `${shelly}`,
      detail: `${online} online responses`,
    },
    {
      label: 'Zones',
      value: `${networkZones.value.length}`,
      detail:
        networkZones.value.map((zone) => zone.cidr || zone.name).join(', ') ||
        'none',
    },
    {
      label: 'Vendors',
      value: `${vendors.size}`,
      detail: [...vendors].slice(0, 3).join(', '),
    },
  ];
});
const selectedDevice = computed(() =>
  selectedDeviceId.value
    ? deviceCards.value.find(
        (device) => device.id === selectedDeviceId.value,
      ) || null
    : null,
);
const selectedDeviceTraces = computed(
  () =>
    state.value?.executionTraces
      ?.filter((trace) => trace.deviceId === selectedDeviceId.value)
      .slice(0, 5) || [],
);

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

const siteSystems = computed(() => state.value?.systems || []);
const mqttBus = computed(() => state.value?.bus?.mqtt || null);
const mqttMessages = computed(() => {
  const filter = mqttTopicFilter.value.trim().toLowerCase();
  const messages = mqttBus.value?.recentMessages || [];
  if (!filter) return messages;

  return messages.filter((message) =>
    `${message.topic} ${message.reason} ${message.payloadPreview}`
      .toLowerCase()
      .includes(filter),
  );
});
const mqttTreeNodes = computed(() => {
  const bus = mqttBus.value;
  if (!bus) return [];

  const nodeMap = new Map<string, MqttTreeNode>();
  const ensureNode = (topic: string, subscription = false) => {
    const parts = topic.split('/').filter(Boolean);
    let path = '';
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      if (!nodeMap.has(path)) {
        nodeMap.set(path, {
          key: path,
          topic: path,
          label: part,
          depth: index,
          messageCount: 0,
          directMessageCount: 0,
          childCount: 0,
          lastMessage: null,
          subscription: false,
        });
      }
    });

    const node = nodeMap.get(topic);
    if (node) node.subscription = node.subscription || subscription;
  };

  for (const subscription of bus.subscriptions) ensureNode(subscription, true);
  for (const message of bus.recentMessages) {
    const parts = message.topic.split('/').filter(Boolean);
    let path = '';
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      let node = nodeMap.get(path);
      if (!node) {
        node = {
          key: path,
          topic: path,
          label: part,
          depth: index,
          messageCount: 0,
          directMessageCount: 0,
          childCount: 0,
          lastMessage: null,
          subscription: false,
        };
        nodeMap.set(path, node);
      }
      node.messageCount += 1;
      if (
        !node.lastMessage ||
        Date.parse(message.observedAt) > Date.parse(node.lastMessage.observedAt)
      ) {
        node.lastMessage = message;
      }
    });

    const leaf = nodeMap.get(message.topic);
    if (leaf) leaf.directMessageCount += 1;
  }

  for (const node of nodeMap.values()) {
    node.childCount = [...nodeMap.values()].filter((candidate) => {
      if (candidate.depth !== node.depth + 1) return false;
      return candidate.topic.startsWith(`${node.topic}/`);
    }).length;
  }

  return [...nodeMap.values()].sort((left, right) => {
    if (
      left.depth !== right.depth &&
      !left.topic.startsWith(`${right.topic}/`) &&
      !right.topic.startsWith(`${left.topic}/`)
    ) {
      return left.topic.localeCompare(right.topic);
    }
    return left.topic.localeCompare(right.topic);
  });
});
const visibleMqttTreeNodes = computed(() => {
  const filter = mqttTopicFilter.value.trim().toLowerCase();
  return mqttTreeNodes.value.filter((node) => {
    if (filter) {
      return `${node.topic} ${node.lastMessage?.payloadPreview || ''}`
        .toLowerCase()
        .includes(filter);
    }
    if (node.depth === 0) return true;
    const parentPath = node.topic.split('/').slice(0, -1).join('/');
    return expandedMqttTopics.value.has(parentPath);
  });
});
const selectedMqttTopicMessages = computed(() => {
  const topic = selectedMqttTopic.value;
  const messages = mqttBus.value?.recentMessages || [];
  if (!topic) return mqttMessages.value;
  return messages.filter(
    (message) =>
      message.topic === topic || message.topic.startsWith(`${topic}/`),
  );
});
const selectedMqttNode = computed(() =>
  selectedMqttTopic.value
    ? mqttTreeNodes.value.find(
        (node) => node.topic === selectedMqttTopic.value,
      ) || null
    : null,
);
const selectedMqttLastMessage = computed(
  () => selectedMqttNode.value?.lastMessage || null,
);
const selectedMqttPrettyPayload = computed(() =>
  formatMqttPayload(selectedMqttLastMessage.value?.payloadPreview),
);
const selectedMqttPipeline = computed<MqttPipelineStep[]>(() =>
  mqttPipelineFor(selectedMqttLastMessage.value),
);
const selectedMqttMessageMeta = computed(() => {
  const message = selectedMqttLastMessage.value;
  if (!message) return null;

  return {
    topic: message.topic,
    observedAt: message.observedAt,
    bytes: formatBytes(message.payloadBytes),
    format: message.validJson ? 'JSON' : 'Raw payload',
    outcome: message.handled ? 'Handled' : message.reason,
  };
});

const mqttPublishTopicValue = computed(() => {
  const topic = mqttPublishTopic.value.trim();
  if (topic) return topic;
  if (selectedMqttTopic.value && !selectedMqttTopic.value.endsWith('/#'))
    return selectedMqttTopic.value;
  return `${mqttBus.value?.prefix || 'energrid/tenant-demo/site-home'}/debug/manual`;
});
const mqttStats = computed(() => {
  const messages = mqttBus.value?.recentMessages || [];
  return [
    { label: 'Messages', value: `${messages.length}`, detail: 'recent buffer' },
    {
      label: 'Handled',
      value: `${messages.filter((message) => message.handled).length}`,
      detail: 'accepted by adapters',
    },
    {
      label: 'Invalid',
      value: `${messages.filter((message) => !message.validJson).length}`,
      detail: 'not JSON',
    },
    {
      label: 'Subscriptions',
      value: `${mqttBus.value?.subscriptions.length || 0}`,
      detail: mqttBus.value?.status || 'unknown',
    },
  ];
});
const deviceSummary = computed(() => {
  if (state.value?.deviceSummary) return state.value.deviceSummary;

  const devices = deviceCards.value;
  const systems = siteSystems.value;

  return {
    total: devices.length,
    approved: approvedDevices.value.length,
    discovered: discoveredDevices.value.length,
    controllable: devices.filter((device) =>
      device.capabilities.some((capability) =>
        capability.actions.some((action) => action !== 'read'),
      ),
    ).length,
    sensors: devices.filter((device) =>
      device.capabilities.some((capability) =>
        capability.actions.includes('read'),
      ),
    ).length,
    systems: systems.length,
    learningEnabled: systems.filter((system) => system.learning.enabled).length,
  };
});

function setActivePage(pageId: string, syncUrl = true) {
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
  if (pageId === 'bus') {
    void loadMqttBus();
    startMqttBusStream();
  } else {
    stopMqttBusStream();
  }
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

async function applyDiscoveryDecision(
  device: PortalDevice,
  action: 'approve' | 'block',
) {
  if (discoveryDecisionBusy.value[device.id]) return;

  discoveryDecisionBusy.value = {
    ...discoveryDecisionBusy.value,
    [device.id]: action,
  };
  appendLog(`[discovery] ${action} requested for ${device.displayName}`);

  try {
    const response = await fetch(
      `${apiBase}/portal/discovery/${encodeURIComponent(device.id)}/${action}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken.value}` },
      },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(result?.message || `Discovery ${action} failed`);
    }

    appendLog(`[discovery] ${device.displayName} ${result.status}`);
    await loadState();
    if (action === 'approve' && activePage.value === 'devices') {
      deviceApprovalFilter.value = 'approved';
    }
  } catch (error) {
    appendLog(
      `[discovery] ${action} failed for ${device.displayName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    stateError.value =
      error instanceof Error ? error.message : `Discovery ${action} failed`;
  } finally {
    const next = { ...discoveryDecisionBusy.value };
    delete next[device.id];
    discoveryDecisionBusy.value = next;
  }
}

function logDiscoveryDecision(device: PortalDevice, action: string) {
  appendLog(`[discovery] ${action} requested for ${device.displayName}`);
}

function applyPendingDecision(candidateId: string, action: 'approve' | 'block') {
  const device = discoveredDevices.value.find(candidate => candidate.id === candidateId);
  if (device) void applyDiscoveryDecision(device, action);
}

function renamePendingCandidate(candidateId: string) {
  const device = discoveredDevices.value.find(candidate => candidate.id === candidateId);
  if (device) logDiscoveryDecision(device, 'rename');
}

async function scanNetwork(scopeIds?: string[]) {
  if (scanningNetwork.value) return;
  const availableScopes = state.value?.networkZones || [];
  const selectedScopeIds = scopeIds?.length ? scopeIds : availableScopes.map(scope => scope.id);
  const selectedScopes = availableScopes.filter(scope => selectedScopeIds.includes(scope.id));
  if (!selectedScopeIds.length || selectedScopes.length !== new Set(selectedScopeIds).size) {
    stateError.value = 'Choose one or more configured network scopes before scanning.';
    return;
  }
  const fullSubnetConfirmed = selectedScopes.some(scope => !!scope.cidr);
  if (fullSubnetConfirmed && !window.confirm(`This will scan the selected subnet(s): ${selectedScopes.filter(scope => scope.cidr).map(scope => `${scope.name} ${scope.cidr}`).join(', ')}. Each subnet is limited to 254 addresses; when enabled, Nmap checks a fixed set of TCP service ports with bounded concurrency and timeouts. Continue?`)) return;
  scanningNetwork.value = true;
  scanStartedAt.value = Date.now();
  scanElapsedSeconds.value = 0;
  scanFeedback.value = '';
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(() => {
    scanElapsedSeconds.value = Math.floor((Date.now() - scanStartedAt.value) / 1000);
  }, 1000);
  stateError.value = '';
  try {
    appendLog('[discovery] scanning selected networks');
    networkScanAbortController = new AbortController();
    const response = await fetch(`${apiBase}/portal/network/scan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeIds: selectedScopeIds, fullSubnetConfirmed }),
      signal: networkScanAbortController.signal,
    });
    if (!response.ok) throw new Error('Network scan unavailable');
    const result = await response.json() as {
      zones?: NonNullable<PortalState['networkZones']>; devices: NetworkDevice[];
      snapshot: NetworkSnapshot; comparison: NetworkSnapshotDiff | null;
    };
    if (state.value) state.value = { ...state.value, networkZones: result.zones || state.value.networkZones, networkDevices: result.devices };
    latestNetworkSnapshot.value = result.snapshot;
    networkSnapshotComparison.value = result.comparison;
    networkSnapshots.value = [result.snapshot, ...networkSnapshots.value.filter(snapshot => snapshot.scanId !== result.snapshot.scanId)];
    scanFeedback.value = `Scan complete · ${result.devices.length} endpoints found · ${result.zones?.length ?? networkZones.value.length} networks`;
    appendLog(`[discovery] snapshot ${result.snapshot.scanId} saved; ${result.devices.length} endpoints visible`);
    await loadState();
    await loadDiscoveryMemory();
  } catch (error) {
    stateError.value = networkScanAbortController?.signal.aborted
      ? 'The scan was cancelled. Any completed observations remain available in the saved snapshot.'
      : error instanceof Error ? error.message : 'Network scan unavailable';
    scanFeedback.value = `Scan failed: ${stateError.value}`;
    appendLog(`[discovery] scan failed: ${stateError.value}`);
  } finally {
    scanElapsedSeconds.value = Math.floor((Date.now() - scanStartedAt.value) / 1000);
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = undefined;
    networkScanAbortController = undefined;
    scanningNetwork.value = false;
  }
}

function cancelNetworkScan() {
  networkScanAbortController?.abort();
}

async function refreshDiscovery() {
  await loadState();
  await loadDiscoveryMemory();
  await loadNetworkSnapshots();
}

async function refreshNetworkIntelligence() {
  await Promise.all([loadState(), loadNetworkSnapshots()]);
}

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

async function findApprovedDeviceHttpPage(device: PortalDevice) {
  if (findingHttpPageByDeviceId.value[device.id]) return;

  findingHttpPageByDeviceId.value = {
    ...findingHttpPageByDeviceId.value,
    [device.id]: true,
  };
  stateError.value = '';
  appendLog(`[discovery] finding HTTP page for ${device.displayName}`);

  try {
    await scanNetwork();
    const refreshed =
      deviceCards.value.find((candidate) => candidate.id === device.id) ||
      device;
    const url =
      approvedDeviceSettingsUrl(refreshed) || approvedDeviceProxyUrl(refreshed);

    if (url) {
      appendLog(`[discovery] HTTP page matched for ${device.displayName}`);
      window.open(url, '_blank', 'noreferrer');
      return;
    }

    const message = `No HTTP page found for ${device.displayName}. It may be MQTT-only, offline, or not reachable from the site brain scan.`;
    stateError.value = message;
    appendLog(`[discovery] ${message}`);
  } finally {
    const next = { ...findingHttpPageByDeviceId.value };
    delete next[device.id];
    findingHttpPageByDeviceId.value = next;
  }
}

async function loadMqttBus(options: { silent?: boolean } = {}) {
  if (mqttBusLoading.value) return;
  mqttBusLoading.value = true;
  stateError.value = '';
  try {
    const response = await fetch(`${apiBase}/portal/bus/mqtt`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (!response.ok) throw new Error('MQTT debug state unavailable');
    const mqtt = (await response.json()) as NonNullable<
      PortalState['bus']
    >['mqtt'];
    if (state.value) {
      state.value = {
        ...state.value,
        bus: { mqtt },
      };
    }
    if (!options.silent) {
      appendLog(`[bus] loaded ${mqtt.recentMessages.length} MQTT messages`);
    }
    if (activePage.value === 'bus') {
      startMqttBusStream();
    }
  } catch (error) {
    stateError.value =
      error instanceof Error ? error.message : 'MQTT debug state unavailable';
    if (!options.silent) {
      appendLog(`[bus] load failed: ${stateError.value}`);
    }
  } finally {
    mqttBusLoading.value = false;
  }
}

function startMqttBusStream() {
  if (mqttBusEvents) return;

  mqttBusStreamStatus.value = 'connecting';
  const url = new URL(
    `${apiBase}/portal/bus/mqtt/events`,
    window.location.href,
  );
  url.searchParams.set('token', accessToken.value);

  mqttBusEvents = new EventSource(url.toString());
  mqttBusEvents.onopen = () => {
    mqttBusStreamStatus.value = 'live';
    appendLog('[bus] live MQTT stream connected');
  };
  mqttBusEvents.onerror = () => {
    mqttBusStreamStatus.value = 'error';
    appendLog('[bus] live MQTT stream interrupted');
  };
  mqttBusEvents.addEventListener('mqtt_message', (event) => {
    try {
      mergeMqttDebugMessage(
        JSON.parse((event as MessageEvent).data) as MqttDebugMessage,
      );
    } catch {
      appendLog('[bus] ignored malformed MQTT stream event');
    }
  });
}

function stopMqttBusStream() {
  if (!mqttBusEvents) return;
  mqttBusEvents.close();
  mqttBusEvents = null;
  mqttBusStreamStatus.value = 'closed';
}

function mergeMqttDebugMessage(message: MqttDebugMessage) {
  const currentState = state.value;
  const mqtt = currentState?.bus?.mqtt;
  if (!currentState || !mqtt) return;

  const messageKey = `${message.observedAt}:${message.topic}:${message.payloadBytes}`;
  const existing = mqtt.recentMessages.some(
    (candidate) =>
      `${candidate.observedAt}:${candidate.topic}:${candidate.payloadBytes}` ===
      messageKey,
  );
  if (existing) return;

  state.value = {
    ...currentState,
    bus: {
      mqtt: {
        ...mqtt,
        recentMessages: [message, ...mqtt.recentMessages].slice(0, 200),
      },
    },
  };
}

async function publishMqttDebugMessage() {
  mqttPublishBusy.value = true;
  mqttPublishError.value = '';
  try {
    const payload = parseMqttPayload(mqttPublishPayload.value);
    const response = await fetch(`${apiBase}/portal/bus/mqtt/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic: mqttPublishTopicValue.value,
        payload,
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.message || 'MQTT publish failed');
    appendLog(
      `[bus] published ${formatBytes(result.payloadBytes || 0)} to ${result.topic}`,
    );
    await loadMqttBus({ silent: true });
  } catch (error) {
    mqttPublishError.value =
      error instanceof Error ? error.message : String(error);
    appendLog(`[bus] publish failed: ${mqttPublishError.value}`);
  } finally {
    mqttPublishBusy.value = false;
  }
}

function toggleMqttTopic(topic: string) {
  const next = new Set(expandedMqttTopics.value);
  if (next.has(topic)) {
    next.delete(topic);
  } else {
    next.add(topic);
  }
  expandedMqttTopics.value = next;
}

function selectMqttTopic(topic: string) {
  selectedMqttTopic.value = topic;
  mqttPublishTopic.value = topic.endsWith('/#') ? '' : topic;
}

function mqttPipelineFor(message: MqttDebugMessage | null): MqttPipelineStep[] {
  if (!message) {
    return [
      {
        id: 'received',
        label: 'MQTT received',
        detail: 'Select a topic containing at least one message.',
        status: 'idle',
      },
      {
        id: 'parsed',
        label: 'Payload parsed',
        detail: 'Waiting for a selected MQTT message.',
        status: 'idle',
      },
      {
        id: 'handler',
        label: 'Handler selected',
        detail: 'Waiting for parser classification.',
        status: 'idle',
      },
      {
        id: 'registry',
        label: 'Registry outcome',
        detail: 'No adapter result is available yet.',
        status: 'idle',
      },
      {
        id: 'portal',
        label: 'Portal visibility',
        detail: 'No normalized result is available yet.',
        status: 'idle',
      },
    ];
  }

  const reason = message.reason.toLowerCase();
  const registryUpdated =
    message.handled &&
    [
      'telemetry',
      'status',
      'registry',
      'legacy framework device',
      'legacy temperature',
      'shelly',
    ].some((token) => reason.includes(token));

  const adapterOnly = message.handled && !registryUpdated;

  return [
    {
      id: 'received',
      label: 'MQTT received',
      detail: `${formatBytes(message.payloadBytes)} received on ${message.topic}.`,
      status: 'passed',
    },
    {
      id: 'parsed',
      label: 'Payload parsed',
      detail: message.validJson
        ? 'Payload decoded as valid JSON.'
        : 'Payload could not be decoded as JSON.',
      status: message.validJson ? 'passed' : 'failed',
    },
    {
      id: 'handler',
      label: 'Handler selected',
      detail: message.handled
        ? `Accepted as ${message.reason}.`
        : message.validJson
          ? `No known adapter accepted this JSON message: ${message.reason}.`
          : 'No adapter processing was attempted for invalid JSON.',
      status: message.handled
        ? 'passed'
        : message.validJson
          ? 'warning'
          : 'failed',
    },
    {
      id: 'registry',
      label: 'Registry outcome',
      detail: registryUpdated
        ? 'Normalized device information was passed into the device registry.'
        : adapterOnly
          ? 'Handled by an adapter, but no registry update is inferred.'
          : 'No device registry update was produced.',
      status: registryUpdated ? 'passed' : adapterOnly ? 'warning' : 'failed',
    },
    {
      id: 'portal',
      label: 'Portal visibility',
      detail: registryUpdated
        ? 'The normalized state can be exposed through the portal snapshot.'
        : message.handled
          ? 'The event is visible in diagnostics, but may not represent device state.'
          : 'The event remains visible only as raw MQTT diagnostic traffic.',
      status: registryUpdated
        ? 'passed'
        : message.handled
          ? 'warning'
          : 'failed',
    },
  ];
}

function adapterLabel(device: PortalDevice) {
  const protocol = device.adapter.protocol;
  const transport = device.adapter.transport;
  const route =
    transport && transport !== protocol
      ? `${protocol} via ${transport}`
      : protocol;
  return `${route} · ${device.adapter.driver}`;
}

function capabilityLabel(device: PortalDevice) {
  return (
    device.capabilities.map((capability) => capability.kind).join(', ') ||
    'unknown'
  );
}

function deviceCommandLabel(device: PortalDevice) {
  const actions = device.capabilities
    .flatMap((capability) => capability.actions)
    .filter((action) => action !== 'read');
  if (actions.length === 0) return 'read only';
  return [...new Set(actions)].join(', ');
}

function deviceStatusClass(device: PortalDevice) {
  if (!device.adapter.configured) return 'amber';
  if (inventoryConnectionStatus(device) === 'online') return 'green';
  if (inventoryConnectionStatus(device) === 'offline') return 'amber';
  return 'blue';
}

function selectDevice(device: PortalDevice) {
  selectedDeviceId.value = device.id;
  void nextTick(() => { deviceSheet.value?.scrollTo?.({ top: 0 }); });
}

function closeDeviceSheet() {
  selectedDeviceId.value = null;
  selectedExecutionTraceId.value = null;
}

function selectMemberDevice(id: string) {
  const member = deviceCards.value.find(device => device.id === id);
  if (member) selectDevice(member);
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

function deviceValuePreview(device: PortalDevice) {
  if (device.trustStatus !== 'approved') return 'Awaiting approval';
  const command = device.state.command;
  if (command?.status === 'pending') {
    return `Pending ${expectedOnLabel(command.expectedValues)}`;
  }
  if (command?.status === 'no_ack') {
    return `No ack · expected ${expectedOnLabel(command.expectedValues)}`;
  }
  if (command?.status === 'failed') return 'Command failed';

  const values = device.state.values;
  const parts: string[] = [];

  if (typeof values.temperature === 'number')
    parts.push(`${formatNumber(values.temperature)} C`);
  if (typeof values.humidity === 'number')
    parts.push(`${formatNumber(values.humidity)}%`);
  if (typeof values.power === 'number')
    parts.push(`${formatNumber(values.power)} W`);
  if (typeof values.current === 'number')
    parts.push(`${formatNumber(values.current)} A`);
  if (typeof values.energy === 'number')
    parts.push(`${formatNumber(values.energy)} kWh`);
  if (typeof values.on === 'boolean') parts.unshift(values.on ? 'On' : 'Off');
  if (typeof values.output === 'boolean')
    parts.unshift(values.output ? 'On' : 'Off');

  if (parts.length > 0) return [...new Set(parts)].join(' · ');
  if (Object.keys(values).length > 0) return JSON.stringify(values);
  if (device.memberDeviceIds?.length)
    return `${device.memberDeviceIds.length} members`;
  return device.state.observedAt === null ? 'No readings yet' : device.state.status;
}

function deviceStateDetail(device: PortalDevice) {
  const command = device.state.command;
  if (command?.status === 'pending') return 'waiting for device ack';
  if (command?.status === 'acked') return 'confirmed by telemetry';
  if (command?.status === 'no_ack') return 'published, no telemetry ack';
  if (command?.status === 'failed') return 'publish failed';
  return device.state.observedAt === null ? 'connectivity not checked' : device.adapter.configured ? 'configured' : 'needs setup';
}

function expectedOnLabel(
  values: Record<string, number | boolean | string | null>,
) {
  const on = values.on ?? values.output ?? values.switch ?? values.powered;
  if (typeof on === 'boolean') return on ? 'On' : 'Off';
  return 'state';
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function deviceHasAction(device: PortalDevice, action: string) {
  return device.capabilities.some((capability) =>
    capability.actions.includes(action),
  );
}

function canToggleDevice(device: PortalDevice) {
  return (
    deviceHasAction(device, 'turn_on') && deviceHasAction(device, 'turn_off')
  );
}

function canSendToggle(device: PortalDevice) {
  return (
    canSwitchDevice(device) &&
    device.state.command?.status !== 'pending'
  );
}

async function sendDeviceAction(
  device: PortalDevice,
  action: 'turn_on' | 'turn_off',
) {
  if (!canSendToggle(device) || deviceActionBusy.value[device.id]) return;

  deviceActionBusy.value = { ...deviceActionBusy.value, [device.id]: true };
  deviceActionError.value = { ...deviceActionError.value, [device.id]: '' };
  appendLog(`[device] ${action} requested for ${device.displayName}`);

  try {
    const response = await fetch(
      `${apiBase}/portal/devices/${encodeURIComponent(device.id)}/actions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action }),
      },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.status === 'failed') {
      throw new Error(result?.message || 'Device action failed');
    }

    appendLog(
      `[device] ${action} ${result.status}; affected=${result.affectedDeviceIds?.join(',') || device.id}`,
    );
    await loadState();
    if (result?.command?.status === 'pending') {
      await waitForDeviceCommand(device.id, result.command.id);
    }
  } catch (error) {
    deviceActionError.value = {
      ...deviceActionError.value,
      [device.id]: error instanceof Error ? error.message : 'Device action failed',
    };
    appendLog(
      `[device] ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    const next = { ...deviceActionBusy.value };
    delete next[device.id];
    deviceActionBusy.value = next;
  }
}

async function waitForDeviceCommand(deviceId: string, commandId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(800);
    await loadState();
    const device = deviceCards.value.find(
      (candidate) => candidate.id === deviceId,
    );
    const command = device?.state.command;
    if (!command || command.id !== commandId || command.status !== 'pending') {
      return;
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deviceProxyUrl(device: NetworkDevice) {
  return `${apiBase}/portal/device-proxy/${encodeURIComponent(device.id)}`;
}

function canProxyDevice(device: NetworkDevice) {
  return device.status === 'online' && device.protocol === 'http';
}

function openApprovedDevice(device: PortalDevice) {
  setActivePage('devices');
  selectDevice(device);
}

function openApprovedOnboardingTarget(device: PortalDevice) {
  const url = approvedDeviceProxyUrl(device) || approvedDeviceSettingsUrl(device);
  if (url) {
    window.open(url, '_blank', 'noreferrer');
    return;
  }
  openApprovedDevice(device);
}

function approvedDeviceNetworkMatch(device: PortalDevice) {
  return matchNetworkDevice(device, liveNetworkDevices.value);
}

function approvedDeviceSettingsUrl(device: PortalDevice) {
  if (device.settingsUrl) return device.settingsUrl;
  const scanned = approvedDeviceNetworkMatch(device)?.settingsUrl;
  if (scanned) return scanned;
  if (typeof device.metadata?.httpBaseUrl === 'string') return device.metadata.httpBaseUrl;
  if (device.adapter.protocol === 'http' && device.adapter.target?.startsWith('http')) {
    return device.adapter.target;
  }
  return approvedDeviceNetworkMatch(device)?.settingsUrl || '';
}

function approvedDeviceProxyUrl(device: PortalDevice) {
  const networkDevice = approvedDeviceNetworkMatch(device);
  return networkDevice && canProxyDevice(networkDevice)
    ? deviceProxyUrl(networkDevice)
    : '';
}

function isEnergridCapableNetworkDevice(device: NetworkDevice) {
  const vendor = (device.vendor || '').toLowerCase();
  const model = (device.model || '').toLowerCase();
  const app = (device.app || '').toLowerCase();
  return (
    vendor.includes('shelly') ||
    model.includes('shelly') ||
    app.includes('shelly')
  );
}

function networkDeviceClass(device: NetworkDevice) {
  if (canProxyDevice(device)) return 'approved';
  if (isEnergridCapableNetworkDevice(device)) return 'discovered';
  return 'unknown';
}

function networkDeviceBadge(device: NetworkDevice) {
  const integration = canProxyDevice(device)
    ? 'gateway ready'
    : isEnergridCapableNetworkDevice(device)
      ? 'capable'
      : 'network only';

  const enrolledDevices = approvedDevices.value.filter(candidate =>
    enrolledDeviceKeys.value.has(
      JSON.stringify([
        candidate.tenantId,
        candidate.siteId,
        candidate.id,
      ]),
    ),
  );

  return hasVerifiedEnrolledNetworkIdentity(
    device,
    enrolledDevices,
  )
    ? `enrolled · ${integration}`
    : integration;
}

function parseMqttPayload(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function formatMqttPayload(value?: string) {
  if (!value) return 'No selected topic value yet.';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function compactMqttPayload(value?: string) {
  if (!value) return 'No selected topic value yet.';
  if (value.length <= 140) return value;
  return `${value.slice(0, 140)}...`;
}

function formatMqttTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

async function login() {
  loginError.value = '';
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.value, password: password.value }),
  });

  if (!response.ok) {
    loginError.value = 'Invalid credentials';
    return;
  }

  const data = (await response.json()) as LoginResponse;
  accessToken.value = data.accessToken;
  user.value = data.user;
  localStorage.setItem(tokenKey, data.accessToken);
  localStorage.setItem(userKey, JSON.stringify(data.user));
  if (activePage.value === 'network-intelligence') await refreshNetworkIntelligence();
  else await loadState();
}

function logout() {
  disconnectVoice();
  userMenuOpen.value = false;
  notificationsOpen.value = false;
  mobileMenuOpen.value = false;
  accessToken.value = '';
  user.value = null;
  state.value = null;
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(userKey);
}

function setEndpointMode(mode: string) {
  endpointMode.value = mode;
  localStorage.setItem(endpointModeKey, mode);
  wsUrl.value =
    mode === 'lan' && canUseLanDirect.value ? lanWsUrl : defaultWsBase;
  disconnectVoice();
  appendLog(`[portal] route=${effectiveRouteLabel.value} ws=${wsUrl.value}`);
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

async function loadEnrollmentMembership() {
  enrolledDeviceKeys.value = new Set();
  enrollmentStatuses.value = new Map();
  enrollmentError.value = '';

  try {
    const response = await fetch(
      `${apiBase}/portal/devices/enrollments`,
      {
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Enrollment API returned ${response.status}`);
    }

    const payload: unknown = await response.json();

    if (
      !payload ||
      typeof payload !== 'object' ||
      !('enrollments' in payload) ||
      !Array.isArray(payload.enrollments)
    ) {
      throw new Error('Invalid enrollment response');
    }

    const keys = new Set<string>();
    const statuses = new Map<string, 'enrolled' | 'suspended' | 'retired'>();

    for (const item of payload.enrollments) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.tenantId !== 'string' ||
        typeof item.siteId !== 'string' ||
        typeof item.deviceId !== 'string' ||
        !['enrolled', 'suspended', 'retired'].includes(item.status)
      ) {
        throw new Error('Invalid enrollment record');
      }

      if (item.status === 'enrolled') {
        const key = JSON.stringify([
          item.tenantId,
          item.siteId,
          item.deviceId,
        ]);
        keys.add(key);
        statuses.set(key, 'enrolled');
      } else {
        statuses.set(JSON.stringify([item.tenantId, item.siteId, item.deviceId]), item.status);
      }
    }

    enrolledDeviceKeys.value = keys;
    enrollmentStatuses.value = statuses;
  } catch (error) {
    enrolledDeviceKeys.value = new Set();
    enrollmentStatuses.value = new Map();
    enrollmentError.value =
      error instanceof Error
        ? error.message
        : 'Device enrollment unavailable';
  }
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
    const response = await fetch(`${apiBase}/portal/state`, {
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
      await loadDiscoveryMemory();
    }
    if (activePage.value === 'bus') {
      await loadMqttBus();
      startMqttBusStream();
    }
  } catch (error) {
    stateError.value =
      error instanceof Error ? error.message : 'State unavailable';
  } finally {
    loadingState.value = false;
  }
}

async function loadVoiceOnlyState() {
  appendLog('[portal] /portal/state missing, using /voice/config fallback');
  const response = await fetch(`${apiBase}/voice/config`);
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

async function loadVoiceRuns() {
  voiceRunsLoading.value = true;
  voiceRunsError.value = '';

  try {
    const response = await fetch(`${apiBase}/voice/runs?limit=8`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (!response.ok) throw new Error('Voice runs unavailable');
    const body = (await response.json()) as { runs?: VoiceRunRecord[] };
    voiceRuns.value = body.runs || [];
  } catch (error) {
    voiceRunsError.value =
      error instanceof Error ? error.message : 'Voice runs unavailable';
  } finally {
    voiceRunsLoading.value = false;
  }
}

function resetTurn() {
  transcript.value = '';
  assistant.value = '';
  plan.value = '';
  metrics.value = null;
  clientTrace.value = {
    connectStartAt: 0,
    connectedAt: 0,
    recordStartAt: 0,
    releaseAt: 0,
    firstServerEventAt: 0,
    firstTranscriptAt: 0,
    firstAssistantTextAt: 0,
    firstAudioAt: 0,
    audioChunksSent: 0,
    audioBytesSent: 0,
    maxClientPeak: 0,
    sumSquares: 0,
    sampleCount: 0,
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

function connectVoice() {
  if (ws?.readyState === WebSocket.OPEN && voiceAuthenticated)
    return Promise.resolve();
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING)
    return waitForVoiceAuthentication(ws);

  wsUrl.value = effectiveWsUrl.value;
  clientTrace.value.connectStartAt = performance.now();
  appendLog(`[voice] connecting ${wsUrl.value}`);
  const socket = new WebSocket(wsUrl.value);
  ws = socket;
  voiceAuthenticated = false;
  socket.binaryType = 'arraybuffer';
  attachVoiceListeners(socket);
  voiceStatus.value = 'connecting';

  socket.addEventListener(
    'open',
    () => {
      voiceStatus.value = 'authenticating';
      socket.send(
        JSON.stringify({ type: 'authenticate', token: accessToken.value }),
      );
    },
    { once: true },
  );
  socket.addEventListener(
    'error',
    () => {
      voiceStatus.value = 'socket error';
      appendLog('[voice] socket error');
    },
    { once: true },
  );
  return waitForVoiceAuthentication(socket);
}

function waitForVoiceAuthentication(socket: WebSocket): Promise<void> {
  if (voiceAuthenticated) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
    };
    const onMessage = (message: MessageEvent) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === 'authenticated') {
          cleanup();
          resolve();
        } else if (event.type === 'error') {
          cleanup();
          reject(new Error(event.message || 'Voice authorization failed'));
        }
      } catch {
        cleanup();
        reject(new Error('Invalid voice server message'));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Voice authorization failed'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error('Voice authorization timed out'));
    }, 15000);

    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose, { once: true });
  });
}

function attachVoiceListeners(socket: WebSocket) {
  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    connected.value = false;
    voiceAuthenticated = false;
    if (voiceStatus.value !== 'turn complete') voiceStatus.value = 'closed';
    pendingVoiceAction.value = null;
    ws = null;
    appendLog('[voice] closed');
  });

  socket.addEventListener('error', () => {
    voiceStatus.value = 'socket error';
    appendLog('[voice] socket error');
  });

  socket.addEventListener('message', (message) => {
    let event: Record<string, any>;
    try {
      event = JSON.parse(message.data);
    } catch {
      appendLog('[voice] ignored malformed server message');
      return;
    }
    if (event.type === 'authenticated') {
      voiceAuthenticated = true;
      connected.value = true;
      voiceStatus.value = 'connected';
      clientTrace.value.connectedAt = performance.now();
      appendLog(
        `[voice] authenticated in ${delta(clientTrace.value.connectStartAt, clientTrace.value.connectedAt)}`,
      );
      return;
    }
    const now = performance.now();
    if (clientTrace.value.releaseAt && !clientTrace.value.firstServerEventAt) {
      clientTrace.value.firstServerEventAt = now;
    }
    appendLog(formatEvent(event));

    if (event.type === 'stt_final') {
      clientTrace.value.firstTranscriptAt ||= now;
      transcript.value = event.full || event.text || '';
    }
    if (event.type === 'assistant_text_delta') {
      clientTrace.value.firstAssistantTextAt ||= now;
      assistant.value = event.full || '';
    }
    if (event.type === 'assistant_final') assistant.value = event.text || '';
    if (event.type === 'action_confirmation_required') {
      pendingVoiceAction.value = {
        approvalId: event.approvalId,
        expiresAt: event.expiresAt,
        actions: Array.isArray(event.actions) ? event.actions : [],
      };
      voiceActionOutcome.value = '';
      voiceStatus.value = 'awaiting action confirmation';
    }
    if (event.type === 'action_confirmation_result') {
      pendingVoiceAction.value = null;
      voiceActionOutcome.value = confirmationOutcome(event.status, event.results);
      voiceStatus.value = event.status === 'completed' ? 'action resolved' : event.status;
    }
    if (event.type === 'home_action_plan')
      plan.value = JSON.stringify(event.plan, null, 2);
    if (event.type === 'assistant_audio_chunk') {
      clientTrace.value.firstAudioAt ||= now;
      playAudioBase64(event.audioBase64, event.format);
    }
    if (event.type === 'turn_end') {
      metrics.value = event.metrics || null;
      voiceStatus.value = 'turn complete';
      appendLog(`[diagnostic] ${bottleneckMessage.value}`);
      setTimeout(() => void loadVoiceRuns(), 250);
      if (closeCompletedTurnSocket(socket, ws)) {
        ws = null;
        connected.value = false;
        voiceAuthenticated = false;
        appendLog('[voice] turn session closed; ready for the next request');
      }
    }
    if (event.type === 'error') voiceStatus.value = `error: ${event.message}`;
  });
}

function disconnectVoice() {
  appendLog('[voice] disconnect requested');
  ws?.close();
  ws = null;
  connected.value = false;
  voiceAuthenticated = false;
  pendingVoiceAction.value = null;
}

function confirmVoiceAction() {
  const pending = pendingVoiceAction.value;
  if (!pending || pending.expiresAt <= Date.now() || !voiceAuthenticated) return;
  ws?.send(JSON.stringify({ type: 'confirm_action', approvalId: pending.approvalId }));
  voiceStatus.value = 'executing confirmed action';
}

function cancelVoiceAction() {
  const pending = pendingVoiceAction.value;
  if (!pending || !voiceAuthenticated) return;
  ws?.send(JSON.stringify({ type: 'cancel_action', approvalId: pending.approvalId }));
}

function voiceActionLabel(action: NonNullable<typeof pendingVoiceAction.value>['actions'][number]) {
  const names: Record<string, string> = {
    'light.turn_on': 'Turn on light',
    'light.turn_off': 'Turn off light',
    'thermostat.set_target': 'Set thermostat target',
    'mode.set': 'Change home mode',
    'alarm.disarm': 'Disarm alarm',
  };
  const target = action.deviceId || action.room;
  const value = action.value == null ? '' : ` to ${action.value}`;
  return `${names[action.type] || action.type}${target ? `: ${target}` : ''}${value}`;
}

function confirmationOutcome(status: string, results: Array<{ status: string; message: string }> = []) {
  if (status === 'completed') {
    const failed = results.find((result) => result.status === 'failed');
    if (failed) return `Action failed: ${failed.message}`;
    const skipped = results.find((result) => result.status === 'skipped');
    if (skipped) return `Not completed: ${skipped.message}`;
    if (results.some((result) => result.status === 'pending')) return 'Command sent; waiting for device acknowledgement.';
    if (results.length && results.every((result) => result.status === 'success')) return 'Device confirmed the action.';
    return 'The plan completed without a device action.';
  }
  const messages: Record<string, string> = {
    cancelled: 'Action cancelled.',
    expired: 'Confirmation expired. Nothing was switched.',
    unavailable: 'This confirmation is no longer available. Nothing was switched.',
    failed: 'The action could not be completed. Check device diagnostics.',
  };
  return messages[status] || 'Action status unavailable.';
}

function redactAudio(event: Record<string, any>) {
  if (event.type !== 'assistant_audio_chunk') return event;
  return {
    ...event,
    audioBase64: `<${Math.round((event.audioBase64 || '').length / 1024)}KB base64>`,
  };
}

function formatEvent(event: Record<string, any>) {
  if (event.type === 'turn_end') {
    const m = event.metrics || {};
    return [
      '[server] turn_end',
      `total=${formatMs(m.totalMs)}`,
      `stt=${formatMs(m.sttMs)}`,
      `firstAudio=${formatMs(m.firstAudioMs)}`,
      `gate=${m.speechGatePassed ? 'passed' : 'blocked'}`,
      `rms=${formatDb(m.audioRmsDb)}`,
      `peak=${formatDb(m.audioPeakDb)}`,
      `chunks=${m.chunkCount ?? 0}`,
    ].join(' ');
  }
  if (event.type === 'assistant_audio_chunk') {
    return `[server] audio chunk index=${event.chunkIndex ?? '?'} bytes=${formatBytes(Math.round((event.audioBase64 || '').length * 0.75))}`;
  }
  if (event.type === 'home_action_plan') {
    return `[server] plan intent=${event.plan?.intent || '?'} actions=${event.plan?.actions?.length ?? 0} confirmation=${event.plan?.requiresConfirmation ? 'yes' : 'no'}`;
  }
  if (event.type === 'home_action_execution') {
    const results = Array.isArray(event.results) ? event.results : [];
    return `[server] execution ${results.map((result) => `${result.action?.deviceId || result.action?.type}:${result.status}:${result.adapter}`).join(', ')}`;
  }
  if (event.type === 'assistant_text_delta')
    return `[server] text delta "${event.delta || ''}" full=${(event.full || '').length} chars`;
  if (event.type === 'stt_final')
    return `[server] stt_final "${event.full || event.text || ''}"`;
  if (event.type === 'session_start')
    return `[server] session_start ${event.sessionId}`;
  return JSON.stringify(redactAudio(event));
}

async function startRecording(event?: PointerEvent) {
  event?.preventDefault();
  if (event?.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  const attempt = ++recordingAttempt;
  voiceSetupError.value = microphoneSetupError(
    window.isSecureContext,
    typeof navigator.mediaDevices?.getUserMedia === 'function',
  ) || '';
  if (voiceSetupError.value) {
    voiceStatus.value = 'microphone unavailable';
    appendLog(`[audio] ${voiceSetupError.value}`);
    return;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    mediaStream = stream;
  } catch (error) {
    voiceSetupError.value = microphoneRequestError(error);
    voiceStatus.value = 'microphone unavailable';
    appendLog(`[audio] ${voiceSetupError.value}`);
    return;
  }
  if (attempt !== recordingAttempt) {
    stopMicrophoneStream(stream);
    if (mediaStream === stream) mediaStream = null;
    return;
  }

  try {
    await connectVoice();
  } catch {
    stopMicrophoneStream(stream);
    if (mediaStream === stream) mediaStream = null;
    voiceSetupError.value =
      'The voice service could not be reached. Check that the API is running and that Domain is routed to it, then try again.';
    voiceStatus.value = 'connection unavailable';
    appendLog('[voice] connection failed; microphone released');
    return;
  }
  if (attempt !== recordingAttempt) {
    stopMicrophoneStream(stream);
    if (mediaStream === stream) mediaStream = null;
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    stopMicrophoneStream(stream);
    if (mediaStream === stream) mediaStream = null;
    voiceSetupError.value =
      'The voice connection closed before recording could start. Check the API route and try again.';
    voiceStatus.value = 'connection unavailable';
    appendLog('[voice] connection closed before recording; microphone released');
    return;
  }
  resetTurn();
  pcmQueue = [];
  recording.value = true;
  voiceStatus.value = 'recording';
  clientTrace.value.recordStartAt = performance.now();
  appendLog('[audio] recording started');

  audioContext = new AudioContext();
  source = audioContext.createMediaStreamSource(stream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    if (
      !recording.value ||
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      !audioContext
    )
      return;
    const input = event.inputBuffer.getChannelData(0);
    trackClientAudio(input);
    const pcm16 = resampleToPcm16(input, audioContext.sampleRate, sampleRate);
    enqueueAndFlush(pcm16);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
}

async function stopRecording(event?: PointerEvent) {
  event?.preventDefault();
  if (
    event?.currentTarget instanceof HTMLElement &&
    event.currentTarget.hasPointerCapture(event.pointerId)
  ) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  recordingAttempt += 1;
  if (!recording.value) return;
  recording.value = false;
  voiceStatus.value = 'sending';
  clientTrace.value.releaseAt = performance.now();
  flushPcm(true);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'end_of_turn' }));
    appendLog(
      `[audio] released, turn sent chunks=${clientTrace.value.audioChunksSent} bytes=${formatBytes(clientTrace.value.audioBytesSent)} held=${delta(clientTrace.value.recordStartAt, clientTrace.value.releaseAt)}`,
    );
  }
  await cleanupAudio();
}

function trackClientAudio(input: Float32Array) {
  let max = clientTrace.value.maxClientPeak;
  let sumSquares = clientTrace.value.sumSquares;
  for (let i = 0; i < input.length; i += 1) {
    const value = Math.abs(input[i]);
    if (value > max) max = value;
    sumSquares += input[i] * input[i];
  }
  clientTrace.value.maxClientPeak = max;
  clientTrace.value.sumSquares = sumSquares;
  clientTrace.value.sampleCount += input.length;
}

function enqueueAndFlush(pcm16: Int16Array) {
  for (const sample of pcm16) pcmQueue.push(sample);
  flushPcm(false);
}

function flushPcm(force: boolean) {
  while (
    ws &&
    (pcmQueue.length >= flushSamples || (force && pcmQueue.length > 0))
  ) {
    const size = force ? pcmQueue.length : flushSamples;
    const chunk = new Int16Array(pcmQueue.splice(0, size));
    ws.send(chunk.buffer);
    clientTrace.value.audioChunksSent += 1;
    clientTrace.value.audioBytesSent += chunk.byteLength;
  }
}

function resampleToPcm16(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
) {
  if (inputRate === outputRate) return floatToPcm16(input);
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    output[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))];
  }
  return floatToPcm16(output);
}

function floatToPcm16(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

async function cleanupAudio() {
  processor?.disconnect();
  source?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  await audioContext?.close();
  processor = null;
  source = null;
  mediaStream = null;
  audioContext = null;
}

function playAudioBase64(base64: string, format = 'wav') {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: `audio/${format}` });
  const audio = new Audio(URL.createObjectURL(blob));
  audio.play().catch(() => undefined);
}

function formatMs(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value)}ms`
    : '--';
}

function formatDb(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)} dB`
    : '--';
}

function amplitudeToDb(value: number) {
  return value > 0 ? 20 * Math.log10(value) : null;
}

function formatBytes(value: number) {
  if (!value) return '0 B';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function formatRunMetric(run: VoiceRunRecord, key: keyof VoiceMetrics) {
  return formatMs(run.metrics?.[key] as number | null | undefined);
}

function formatRunTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function summarizeRunExecution(run: VoiceRunRecord) {
  if (run.errors?.length) return run.errors[0];
  const firstResult = run.executionResults?.[0];
  if (firstResult)
    return `${firstResult.status || 'unknown'} via ${firstResult.adapter || 'adapter'}`;
  if (run.plan?.requiresConfirmation) return 'waiting for confirmation';
  return run.intent || 'no intent';
}

function formatVoiceRunJson(run: VoiceRunRecord) {
  return JSON.stringify(run, null, 2);
}

function formatPercent(value: number, total: number) {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : '0%';
}

function delta(start: number, end: number) {
  return start && end ? `${Math.round(end - start)}ms` : '--';
}

if (accessToken.value && user.value) {
  setEndpointMode(endpointMode.value);
  if (activePage.value === 'discovery') void refreshDiscovery();
  else if (activePage.value === 'network-intelligence') void refreshNetworkIntelligence();
  else void loadState();
  loadVoiceRuns();
}

window.addEventListener('popstate', handlePortalRouteChange);

onBeforeUnmount(() => {
  window.removeEventListener('popstate', handlePortalRouteChange);
  stopMqttBusStream();
  disconnectVoice();
  cleanupAudio();
});
</script>

<template>
  <main v-if="!accessToken" :class="['login-screen', `theme-${theme}`]">
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
        <strong>{{ state?.site.name || 'Home' }}</strong>
        <small>{{ state?.tenant.name || 'Energrid Demo' }}</small>
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
        <section
          v-if="activePage === 'assistant'"
          class="panel assistant-panel premium-panel"
        >
          <div class="assistant-heading">
            <div>
              <p class="eyebrow">Energrid Assistant</p>
              <h2>Ask once. Let the site respond safely.</h2>
              <span
                >Hold the button, speak naturally, release to send the
                turn.</span
              >
            </div>
            <div class="voice-orb" :class="{ listening: recording }">
              <span>{{ recording ? 'REC' : 'AI' }}</span>
            </div>
          </div>

          <div class="assistant-status-row">
            <span
              ><span :class="['dot', voiceLinkStatus.tone]"></span
              >{{ voiceLinkStatus.label }}</span
            >
            <span>API {{ serverLabel }}</span>
            <span>Route {{ effectiveRouteLabel }}</span>
            <span>STT {{ state?.voice.provider || '--' }}</span>
            <span>{{ voiceStatus }}</span>
          </div>

          <div class="route-controls">
            <div>
              <span>Network route</span>
              <strong>{{
                endpointMode === 'lan' ? 'LAN direct' : 'Public domain'
              }}</strong>
            </div>
            <div class="segmented">
              <button
                :class="{ active: endpointMode === 'same-origin' }"
                type="button"
                @click="setEndpointMode('same-origin')"
              >
                Domain
              </button>
              <button
                :class="{ active: endpointMode === 'lan' }"
                type="button"
                @click="setEndpointMode('lan')"
              >
                LAN
              </button>
            </div>
            <a
              v-if="endpointMode === 'lan' && !canUseLanDirect"
              :href="lanPortalUrl"
              >Open LAN portal</a
            >
          </div>
          <p v-if="voiceSetupError" class="route-note" role="alert">
            {{ voiceSetupError }}
          </p>
          <p
            v-if="endpointMode === 'lan' && !canUseLanDirect"
            class="route-note"
          >
            This HTTPS page cannot use ws://192.168.1.60 directly. Open the LAN
            portal, or later use split DNS/local HTTPS for the fast path.
          </p>

          <div class="talk-stage">
            <button
              class="primary talk-button"
              :class="{ recording }"
              :disabled="Boolean(pendingVoiceAction)"
              @pointerdown="startRecording"
              @pointerup="stopRecording"
              @pointercancel="stopRecording"
              @lostpointercapture="stopRecording"
            >
              <span>{{
                recording
                  ? 'Release to send'
                  : pendingVoiceAction
                    ? 'Confirm or cancel first'
                    : ['connecting', 'authenticating'].includes(voiceStatus)
                    ? 'Connecting'
                    : 'Hold to talk'
              }}</span>
              <small>{{
                recording ? 'Listening now' : 'Press and hold'
              }}</small>
            </button>
          </div>

          <div class="conversation">
            <div>
              <span>Transcript</span>
              <p>{{ transcript || 'Waiting for your command' }}</p>
            </div>
            <div>
              <span>Assistant</span>
              <p>
                {{ assistant || 'Ready to translate intent into a safe plan' }}
              </p>
            </div>
          </div>

          <section v-if="pendingVoiceAction" class="voice-action-approval" aria-live="assertive">
            <div>
              <p class="eyebrow">Confirmation required</p>
              <h3>Review before anything changes</h3>
              <ul>
                <li v-for="(action, index) in pendingVoiceAction.actions" :key="`${action.type}:${action.deviceId}:${index}`">
                  {{ voiceActionLabel(action) }}
                </li>
              </ul>
              <p class="approval-expiry">Expires {{ new Date(pendingVoiceAction.expiresAt).toLocaleTimeString() }}. No change happens unless you confirm.</p>
            </div>
            <div class="approval-actions">
              <button class="secondary" type="button" @click="cancelVoiceAction">Cancel</button>
              <button class="primary" type="button" @click="confirmVoiceAction">Confirm action</button>
            </div>
          </section>
          <p v-if="voiceActionOutcome" class="voice-action-outcome" role="status">{{ voiceActionOutcome }}</p>

          <div class="diagnostics">
            <section>
              <div class="section-row compact">
                <h2>Bottleneck</h2>
              </div>
              <p>{{ bottleneckMessage }}</p>
            </section>
            <section>
              <div class="section-row compact">
                <h2>Server metrics</h2>
              </div>
              <dl class="metric-grid">
                <div v-for="item in compactMetrics" :key="item.label">
                  <dt>{{ item.label }}</dt>
                  <dd>{{ item.value }}</dd>
                </div>
              </dl>
            </section>
            <section>
              <div class="section-row compact">
                <h2>Browser trace</h2>
              </div>
              <dl class="metric-grid">
                <div v-for="item in clientDiagnostics" :key="item.label">
                  <dt>{{ item.label }}</dt>
                  <dd>{{ item.value }}</dd>
                </div>
              </dl>
            </section>
          </div>

          <div class="voice-log">
            <div class="section-row">
              <h2>Live log</h2>
              <span>{{ displayLogs.length }} entries</span>
            </div>
            <pre>{{
              displayLogs.join('\n') || 'Hold the button to start a voice turn.'
            }}</pre>
          </div>

          <div class="voice-runs">
            <div class="section-row">
              <h2>Recent voice runs</h2>
              <button
                class="secondary compact-button"
                type="button"
                @click="loadVoiceRuns"
              >
                {{ voiceRunsLoading ? 'Loading' : 'Refresh' }}
              </button>
            </div>
            <p v-if="voiceRunsError" class="inline-error">
              {{ voiceRunsError }}
            </p>
            <div v-if="voiceRuns.length === 0" class="run-empty">
              No saved turns yet. Complete one voice command and it will appear
              here.
            </div>
            <details
              v-for="run in voiceRuns"
              :key="run.id"
              class="voice-run-card"
            >
              <summary>
                <span>
                  <strong>{{ formatRunTimestamp(run.completedAt) }}</strong>
                  <em>{{ run.intent || 'unknown' }}</em>
                </span>
                <span>{{ summarizeRunExecution(run) }}</span>
              </summary>
              <div class="run-body">
                <div>
                  <span>Transcript</span>
                  <p>{{ run.transcript || 'No transcript' }}</p>
                </div>
                <div>
                  <span>Assistant</span>
                  <p>{{ run.assistantReply || 'No assistant reply' }}</p>
                </div>
                <dl class="metric-grid mini">
                  <div>
                    <dt>Total</dt>
                    <dd>{{ formatRunMetric(run, 'totalMs') }}</dd>
                  </div>
                  <div>
                    <dt>STT</dt>
                    <dd>{{ formatRunMetric(run, 'sttMs') }}</dd>
                  </div>
                  <div>
                    <dt>Audio</dt>
                    <dd>{{ formatRunMetric(run, 'firstAudioMs') }}</dd>
                  </div>
                  <div>
                    <dt>Runtime</dt>
                    <dd>{{ run.runtime?.sttProvider || '--' }}</dd>
                  </div>
                </dl>
                <details class="payload-details compact">
                  <summary>Full run JSON</summary>
                  <pre>{{ formatVoiceRunJson(run) }}</pre>
                </details>
              </div>
            </details>
          </div>
        </section>

        <section
          v-else-if="activePage === 'devices'"
          class="panel workspace-panel devices-workspace"
        >
          <div class="page-heading">
            <p class="eyebrow">Site Inventory</p>
            <h2>Devices</h2>
            <button type="button" class="ghost" :disabled="loadingState" @click="loadState">{{ loadingState ? 'Refreshing...' : 'Refresh' }}</button>
          </div>

          <div class="device-inventory-content">
          <div class="summary-strip">
            <div>
              <span>Total</span>
              <strong>{{ inventoryDeviceSummary.total }}</strong>
            </div>
            <div>
              <span>Approved</span>
              <strong>{{ inventoryDeviceSummary.approved }}</strong>
            </div>
            <div>
              <span>Controllable</span>
              <strong>{{ inventoryDeviceSummary.controllable }}</strong>
            </div>
            <div>
              <span>Sensors</span>
              <strong>{{ inventoryDeviceSummary.sensors }}</strong>
            </div>
            <div>
              <span>Systems</span>
              <strong>{{ inventoryDeviceSummary.systems }}</strong>
            </div>
            <div>
              <span>Learning</span>
              <strong>{{ inventoryDeviceSummary.learningEnabled }}</strong>
            </div>
          </div>

          <div class="device-source-strip">
            <div v-for="item in deviceSourceStats" :key="item.label">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
              <small>{{ item.detail }}</small>
            </div>
          </div>



          <div class="device-inventory-toolbar">
            <label class="search-field inventory-search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M10.5 17a6.5 6.5 0 1 1 5.1-2.48l3.44 3.44-1.08 1.08-3.44-3.44A6.47 6.47 0 0 1 10.5 17Zm0-1.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"
                />
              </svg>
              <input
                v-model="deviceSearch"
                type="search"
                aria-label="Search devices"
                placeholder="Search devices, topics, zones"
              />
            </label>
            <select v-model="deviceSourceFilter" aria-label="Filter by source">
              <option value="site">Site devices</option>
              <option value="examples">Examples</option>
              <option value="all">All sources</option>
            </select>
            <select
              v-model="deviceCapabilityFilter"
              aria-label="Filter by capability"
            >
              <option value="all">All types</option>
              <option
                v-for="capability in deviceCapabilityOptions"
                :key="capability"
                :value="capability"
              >
                {{ capability }}
              </option>
            </select>
            <select v-model="deviceZoneFilter" aria-label="Filter by zone">
              <option value="all">All zones</option>
              <option
                v-for="zone in deviceZoneOptions"
                :key="zone.id"
                :value="zone.id"
              >
                {{ zone.name }}
              </option>
            </select>
            <select v-model="deviceStatusFilter" aria-label="Filter by status">
              <option value="all">All statuses</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="controllable">Controllable</option>
              <option value="needs_setup">Needs setup</option>
            </select>
            <div class="inventory-filter-summary">
              <span role="status" aria-live="polite" aria-atomic="true">{{ filteredInventoryDevices.length }} shown</span>
              <button type="button" class="ghost" :disabled="!hasInventoryFilters" @click="clearInventoryFilters">Clear filters</button>
            </div>
          </div>

          <div v-if="retiredInventoryDevices.length" class="retired-device-list">
            <h4>Retired devices</h4>
            <button v-for="device in retiredInventoryDevices" :key="device.id" type="button" class="ghost" @click="selectDevice(device)">
              {{ device.displayName }} · {{ device.id }}
            </button>
          </div>

          <div
            v-if="enrollmentError"
            class="discovery-empty compact"
            role="alert"
          >
            <strong>Device inventory unavailable</strong>
            <span>{{ enrollmentError }}</span>
          </div>
          <div
            v-else-if="enrolledInventoryDevices.length === 0"
            class="discovery-empty compact"
          >
            <strong>No enrolled devices yet</strong>
            <span
              >Approve devices from Discovery or publish them through the site
              bus.</span
            >
          </div>
          <div
            v-else-if="filteredInventoryDevices.length === 0"
            class="discovery-empty compact"
          >
            <strong>No devices match this filter</strong>
            <span
              >Clear search or loosen the capability, zone, or status
              filters.</span
            >
          </div>
          <div v-else ref="deviceTableWrap" class="network-table-wrap device-table-wrap">
            <table class="network-table device-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Zone</th>
                  <th>Capability</th>
                  <th>Adapter</th>
                  <th>State</th>
                  <th>Control</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="device in filteredInventoryDevices"
                  :key="device.id"
                  :id="`device-record-${encodeURIComponent(device.id)}`"
                  :class="{ selected: selectedDeviceId === device.id }"
                  @click="selectDevice(device)"
                >
                  <td data-label="Device">
                    <button type="button" class="device-name-button" @click.stop="selectDevice(device)">{{ device.displayName }}</button>
                    <span>{{ device.kind }} · {{ device.id }}</span>
                    <span v-if="isExampleDevice(device)" class="device-example-label">Example / simulation</span>
                    <span v-else-if="device.trustStatus !== 'approved'" class="device-approval-label">Approval required</span>
                  </td>
                  <td data-label="Zone">
                    <strong>{{ device.zoneName }}</strong>
                    <span>{{
                      device.memberDeviceIds?.length
                        ? `${device.memberDeviceIds.length} members`
                        : device.siteName
                    }}</span>
                  </td>
                  <td data-label="Capability">
                    <strong>{{ capabilityLabel(device) }}</strong>
                    <span>{{ deviceCommandLabel(device) }}</span>
                  </td>
                  <td data-label="Adapter">
                    <strong>{{ device.adapter.driver }}</strong>
                    <span>{{ adapterLabel(device) }}</span>
                  </td>
                  <td data-label="State">
                    <span class="inventory-status">
                      <span :class="['dot', deviceStatusClass(device)]"></span>
                      <strong>{{ deviceValuePreview(device) }}</strong>
                    </span>
                    <span>{{ deviceStateDetail(device) }}</span>
                  </td>
                  <td data-label="Control">
                    <DeviceSwitchControl
                      v-if="canSwitchDevice(device)"
                      :device="device"
                      :busy="deviceActionBusy[device.id]"
                      :error="deviceActionError[device.id]"
                      @action="sendDeviceAction(device, $event)"
                    />
                    <button v-else-if="device.trustStatus !== 'approved'" type="button" class="ghost" @click.stop="selectDevice(device)">Review device</button>
                    <button v-else-if="canToggleDevice(device)" type="button" class="secondary" @click.stop="selectDevice(device)">{{ device.memberDeviceIds?.length ? 'Set up members' : 'Configure control' }}</button>
                    <span v-else class="trust-pill approved">Read only</span>
                    <span v-if="canToggleDevice(device)">{{ controlRouteLabel(device) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          </div>
          <div
            v-if="selectedDevice"
            class="device-sheet-backdrop"
            @click="closeDeviceSheet"
          ></div>
          <aside
            v-if="selectedDevice"
            ref="deviceSheet"
            class="device-sheet"
            aria-label="Device details"
            @keydown.esc="closeDeviceSheet"
          >
            <div class="device-sheet-handle"></div>
            <div class="device-sheet-head">
              <div>
                <span class="eyebrow"
                  >{{ selectedDevice.zoneName }} ·
                  {{ selectedDevice.kind }}</span
                >
                <h3>{{ selectedDevice.displayName }}</h3>
              </div>
              <button
                class="icon-button"
                type="button"
                aria-label="Close device details"
                @click="closeDeviceSheet"
              >
                ×
              </button>
            </div>


            <section
              class="device-observation-overview"
              aria-label="Device measurements"
            >
              <div class="device-observation-heading">
                <div>
                  <span class="device-observation-eyebrow">
                    Device overview
                  </span>
                  <h4>Measurements</h4>
                </div>
                <span class="device-observation-protocol">
                  {{ selectedDevice.adapter.protocol.toUpperCase() }}
                  · {{ canToggleDevice(selectedDevice) ? 'Controls available' : 'Read only' }}
                </span>
              </div>

              <div
                v-if="
                  typeof selectedDevice.state.values.temperature === 'number' ||
                  typeof selectedDevice.state.values.humidity === 'number'
                "
                class="device-observation-grid"
              >
                <div
                  v-if="typeof selectedDevice.state.values.temperature === 'number'"
                  class="device-observation-metric"
                >
                  <span>Temperature</span>
                  <strong>
                    {{ formatNumber(selectedDevice.state.values.temperature) }}°C
                  </strong>
                </div>

                <div
                  v-if="typeof selectedDevice.state.values.humidity === 'number'"
                  class="device-observation-metric"
                >
                  <span>Humidity</span>
                  <strong>
                    {{ formatNumber(selectedDevice.state.values.humidity) }}%
                  </strong>
                </div>
              </div>

              <p v-else class="device-observation-empty">
                No temperature or humidity readings available yet.
              </p>

              <div class="device-observation-footer">
                <span>
                  {{
                    selectedDevice.state.observedAt
                      ? `Last observation: ${new Date(selectedDevice.state.observedAt).toLocaleString()}`
                      : 'No observation timestamp'
                  }}
                </span>

                <span>
                  {{
                    selectedDevice.state.source === 'approved-observation'
                      ? 'Approved observation source'
                      : `Reported source: ${selectedDevice.state.source || 'unknown'}`
                  }}
                </span>
              </div>

              <p
                v-if="selectedDevice.adapter.protocol === 'mqtt'"
                class="device-observation-route"
              >
                MQTT topic:
                <code>{{ selectedDevice.adapter.target }}</code>
              </p>
            </section>

            <div class="device-setup-actions">
              <div v-if="selectedDevice.trustStatus !== 'approved'" class="device-approval-actions">
                <strong>Approval required</strong>
                <button type="button" class="primary" :disabled="!!discoveryDecisionBusy[selectedDevice.id]" @click="applyDiscoveryDecision(selectedDevice, 'approve')">{{ discoveryDecisionBusy[selectedDevice.id] ? 'Approving...' : 'Approve device' }}</button>
                <p v-if="stateError" role="alert">{{ stateError }}</p>
              </div>
              <div v-if="selectedDevice.memberDeviceIds?.length" class="device-member-links">
                <h4>Member devices</h4>
                <button v-for="id in selectedDevice.memberDeviceIds" :key="id" type="button" class="ghost" :disabled="!deviceCards.some(device => device.id === id)" @click="selectMemberDevice(id)">{{ deviceCards.find(device => device.id === id)?.displayName || id }}</button>
              </div>
              <DeviceSwitchControl v-if="canSwitchDevice(selectedDevice)" :device="selectedDevice" :busy="deviceActionBusy[selectedDevice.id]" :error="deviceActionError[selectedDevice.id]" @action="sendDeviceAction(selectedDevice, $event)" />
              <div class="network-actions">
                <a v-if="approvedDeviceProxyUrl(selectedDevice)" class="ghost-link" :href="approvedDeviceProxyUrl(selectedDevice)">Via gateway</a>
                <a v-if="approvedDeviceSettingsUrl(selectedDevice)" class="ghost-link" :href="approvedDeviceSettingsUrl(selectedDevice)" target="_blank" rel="noreferrer">Open settings</a>
              </div>

              <details class="device-detail-disclosure">
                <summary>Connection & diagnostics</summary>
                <div class="device-detail-disclosure-content">
                  <DeviceNetworkIdentityPanel
                    :key="selectedDevice.id"
                    :device-id="selectedDevice.id"
                    :device-name="selectedDevice.displayName"
                    :enrollment-status="deviceEnrollmentStatus(selectedDevice)"
                    :protocol="selectedDevice.adapter.protocol"
                    :protocol-endpoint="selectedDevice.adapter.target || selectedDevice.adapter.telemetryTopic || selectedDevice.adapter.eventTopicPrefix"
                    :api-base="apiBase"
                    :access-token="accessToken"
                    @retired="handleDeviceRetired"
                    @reenrolled="handleDeviceReenrolled"
                  />
                  <DeviceConnectionDiagnostics v-if="canToggleDevice(selectedDevice)" :key="selectedDevice.id" :device="selectedDevice" :api-base="apiBase" :access-token="accessToken" />
                  <DeviceControlSetup :device="selectedDevice" :api-base="apiBase" :access-token="accessToken" :network-devices="networkDevices" :finding-address="scanningNetwork" :address-search-error="stateError" @find-address="scanNetwork" @saved="loadState" />
                </div>
              </details>

              <details class="device-detail-disclosure">
                <summary>Installation, settings & history</summary>
                <div class="device-detail-disclosure-content">
                  <DeviceCommissioning
                v-if="selectedDevice.trustStatus === 'approved'"
                :device="selectedDevice"
                :api-base="apiBase"
                :access-token="accessToken"
                :settings-url-suggestion="approvedDeviceNetworkMatch(selectedDevice)?.settingsUrl"
                @saved="loadState"
              />
                </div>
              </details>

            </div>

            <dl class="device-facts detail-facts">
              <div>
                <dt>Status</dt>
                <dd>
                  {{ selectedDevice.trustStatus === 'approved' ? (selectedDevice.state.observedAt === null ? 'no readings yet' : selectedDevice.state.status) : 'awaiting approval' }} ·
                  {{
                    selectedDevice.adapter.configured
                      ? 'readings configured'
                      : 'readings need setup'
                  }}
                </dd>
              </div>
              <div>
                <dt>Readings adapter</dt>
                <dd>{{ adapterLabel(selectedDevice) }}</dd>
              </div>
              <div>
                <dt>Readings source</dt>
                <dd>
                  {{
                    selectedDevice.adapter.target ||
                    selectedDevice.adapter.eventTopicPrefix ||
                    'local registry'
                  }}
                </dd>
              </div>
              <div v-if="selectedDevice.adapter.bridge">
                <dt>Bridge</dt>
                <dd>{{ selectedDevice.adapter.bridge }}</dd>
              </div>
              <div>
                <dt>Capabilities</dt>
                <dd>
                  {{
                    selectedDevice.capabilities
                      .map(
                        (capability) =>
                          `${capability.kind}:${capability.actions.join('/')}`,
                      )
                      .join(', ')
                  }}
                </dd>
              </div>
              <div v-if="selectedDevice.memberDeviceIds?.length">
                <dt>Members</dt>
                <dd>{{ selectedDevice.memberDeviceIds.join(', ') }}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  {{
                    Object.keys(selectedDevice.state.values).length
                      ? JSON.stringify(selectedDevice.state.values)
                      : (selectedDevice.state.observedAt === null ? 'unknown - no readings yet' : selectedDevice.state.status)
                  }}
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{{ selectedDevice.state.observedAt || 'unknown' }}</dd>
              </div>

              <div v-if="selectedDeviceTraces.length">
                <dt>Execution history</dt>
                <dd>
                  <div
                    v-for="trace in selectedDeviceTraces"
                    :key="trace.id"
                    class="execution-trace clickable"
                    @click.stop="openExecutionTrace(trace.id)"
                  >
                    <strong>
                      {{ trace.action }}
                      ·
                      {{ trace.outcome }}
                      <span v-if="trace.durationMs">
                        ({{ trace.durationMs }}ms)
                      </span>
                    </strong>

                    <ol>
                      <li
                        v-for="stage in trace.stages"
                        :key="`${trace.id}-${stage.stage}`"
                      >
                        <b>{{ stage.stage }}</b>
                        —
                        {{ stage.message }}
                      </li>
                    </ol>
                  </div>
                </dd>
              </div>

              <div v-if="selectedDevice.adapter.commandTopic">
                <dt>Site-bus command topic</dt>
                <dd>{{ selectedDevice.adapter.commandTopic }}</dd>
              </div>
              <div v-if="selectedDevice.adapter.telemetryTopic">
                <dt>Site-bus telemetry topic</dt>
                <dd>{{ selectedDevice.adapter.telemetryTopic }}</dd>
              </div>
            </dl>
          </aside>
        </section>

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

        <section
          v-else-if="activePage === 'network-intelligence'"
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
            :busy="scanningNetwork"
            :error="networkSnapshotsError || stateError"
            @scan="scanNetwork"
            @cancel="cancelNetworkScan"
            @open-pending="openPendingEnrollment"
            @open-device="openEnrolledDevice"
            @investigate-endpoint="investigateSnapshotEndpoint"
          />
        </section>

        <section
          v-else-if="activePage === 'discovery'"
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

          <div class="network-scan">
            <div class="scan-origin">
              <div>
                <span>Scan origin</span>
                <strong>{{ serverLabel || 'same-origin API' }}</strong>
              </div>
              <div>
                <span>Source of truth</span>
                <strong>site brain network view</strong>
              </div>
              <div>
                <span>Gateway proxy</span>
                <strong>{{ networkDeviceSummary.proxyable }} ready</strong>
              </div>
            </div>
            <div class="section-row">
              <div>
                <h3>Visible from the local brain</h3>
                <span class="section-help"
                  >The browser is not scanning. The API/site brain scans the
                  networks it can reach.</span
                >
              </div>
              <div class="discovery-toolbar">
                <input
                  v-model="deviceIntelligenceSearch"
                  type="search"
                  aria-label="Search network devices"
                  placeholder="Search IP, hostname, MAC, vendor..."
                />
                <button
                  v-if="deviceIntelligenceSearch"
                  type="button"
                  class="secondary"
                  @click="deviceIntelligenceSearch = ''"
                >
                  Clear
                </button>

                <span
                  >{{ visibleNetworkDevices.length }} shown ·
                  {{ networkDevices.length }} found</span
                >
                <div class="segmented compact">
                  <button
                    type="button"
                    :class="{ active: discoveryView === 'all' }"
                    :aria-pressed="discoveryView === 'all'"
                    @click="discoveryView = 'all'"
                  >
                    All devices
                  </button>
                  <button
                    type="button"
                    :class="{ active: discoveryView === 'capable' }"
                    :aria-pressed="discoveryView === 'capable'"
                    @click="discoveryView = 'capable'"
                  >
                    Shelly devices
                  </button>
                </div>
              </div>
            </div>
            <div class="network-stat-grid">
              <div v-for="item in networkStats" :key="item.label">
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
                <small>{{ item.detail }}</small>
              </div>
            </div>
            <div class="zone-strip" v-if="networkZones.length > 0">
              <span v-for="zone in networkZones" :key="zone.id">
                <strong>{{ zone.name }}</strong>
                {{
                  zone.cidr ||
                  zone.interfaceName ||
                  `${zone.seedIps.length} seeds`
                }}
              </span>
            </div>
            <div
              class="discovery-empty compact"
              v-if="networkDevices.length === 0"
            >
              <strong>No scan yet</strong>
              <span
                >Run a scan to list devices visible from the local brain,
                including Shelly settings pages when they respond.</span
              >
            </div>
            <div
              class="discovery-empty compact"
              v-else-if="visibleNetworkDevices.length === 0"
            >
              <strong>
                {{ deviceIntelligenceSearch
                  ? 'No devices match your search'
                  : 'No Energrid-capable devices in this view' }}
              </strong>
              <span
                >Switch to all devices to see every host the site brain found on
                the configured networks.</span
              >
            </div>
            <div v-else class="discovery-zone-groups">
              <details
                v-for="zone in networkZones.filter(z => visibleNetworkDevices.some(d => d.networkZoneId === z.id))"
                :key="zone.id"
                class="discovery-accordion"
                open
              >
                <summary>
                  <strong>{{ zone.name }}</strong>
                  <span>{{ visibleNetworkDevices.filter(d => d.networkZoneId === zone.id).length }} devices · {{ zone.cidr }}</span>
                </summary>
                <div class="network-device-list">
                  <NetworkDiscoveryCard
                    v-for="device in visibleNetworkDevices.filter(d => d.networkZoneId === zone.id)"
                    :key="device.networkZoneId + ':' + device.ipAddress"
                    :device="device"
                    :badge="networkDeviceBadge(device)"
                    :badge-class="networkDeviceClass(device)"
                    :investigating="aiInvestigating[device.id]"
                    :has-ssh="deviceHasSsh(device)"
                    :has-channels="!!device.components?.length || deviceCards.some(candidate => candidate.metadata?.physicalId === device.id)"
                    :identity-conflict="device.identityConflict"
                    :proxy-url="canProxyDevice(device) ? deviceProxyUrl(device) : undefined"
                    @review="openDeviceIntelligenceOnly(device.id)"
                    @investigate="investigateNetworkDeviceWithAi(device)"
                    @channels="reviewNetworkDevice(device)"
                    @copy-ssh="copySshCommand(device)"
                  />
                </div>
              </details>
            </div>

            <section id="discovery-memory" class="discovery-memory-section">
              <div class="section-row">
                <div>
                  <h3>Discovery Memory</h3>
                  <span class="section-help">
                    Persistent network history. Not observed does not mean offline.
                  </span>
                </div>
                <button
                  type="button"
                  class="secondary"
                  :disabled="discoveryMemoryLoading"
                  @click="loadDiscoveryMemory"
                >
                  {{ discoveryMemoryLoading ? 'Loading...' : 'Refresh memory' }}
                </button>
              </div>

              <p v-if="discoveryMemoryError" role="alert">
                {{ discoveryMemoryError }}
              </p>

              <div v-if="discoveryMemory" class="network-stat-grid">
                <div>
                  <span>Known</span>
                  <strong>{{ discoveryMemory.summary.known }}</strong>
                  <small>Remembered across scans</small>
                </div>
                <div>
                  <span>Observed this scan</span>
                  <strong>{{ discoveryMemory.summary.observedInLatestScan }}</strong>
                  <small>Latest completed scan</small>
                </div>
                <div>
                  <span>Not observed</span>
                  <strong>{{ discoveryMemory.summary.notObservedInLatestScan }}</strong>
                  <small>Not necessarily offline</small>
                </div>
              </div>

              <div v-if="discoveryMemory" class="section-row">
                <span class="section-help">
                  {{ historicalNetworkDevices.length }} historical records
                </span>
                <button
                  type="button"
                  class="secondary"
                  :aria-expanded="discoveryMemoryExpanded"
                  @click="discoveryMemoryExpanded = !discoveryMemoryExpanded"
                >
                  {{ discoveryMemoryExpanded ? 'Hide history' : 'Show history' }}
                </button>
              </div>

              <div
                v-if="discoveryMemory && discoveryMemoryExpanded"
                class="network-table-wrap"
              >
                <table class="network-table">
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Last known address</th>
                      <th>Model</th>
                      <th>First seen</th>
                      <th>Last seen</th>
                      <th>Observation</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="record in historicalNetworkDevices"
                      :key="record.identity"
                    >
                      <td data-label="Device">
                        <strong>
                          {{ record.device.vendor || record.device.hostname || 'Network device' }}
                        </strong>
                        <span>{{ record.device.id }}</span>
                      </td>
                      <td data-label="Last known address">
                        <strong>{{ record.device.ipAddress }}</strong>
                        <span>{{ record.device.macAddress || 'MAC unknown' }}</span>
                        <span v-if="record.device.identityConflict" role="status">
                          Conflicting MAC evidence: {{ record.device.identityConflict.macAddresses.join(', ') }}
                        </span>
                      </td>
                      <td data-label="Model">
                        {{ record.device.model || record.device.protocol || 'Unknown' }}
                      </td>
                      <td data-label="First seen">
                        {{ discoveryMemoryDate(record.firstSeenAt) }}
                      </td>
                      <td data-label="Last seen">
                        {{ discoveryMemoryDate(record.lastSeenAt) }}
                      </td>
                      <td data-label="Observation">
                        <span>
                          {{
                            record.observedInLatestScan
                              ? 'Observed in latest scan'
                              : 'Not observed in latest scan'
                          }}
                        </span>
                      </td>
                    </tr>
                    <tr v-if="historicalNetworkDevices.length === 0">
                      <td colspan="6">
                        No devices remembered yet. Run a network scan.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section
            v-if="selectedAiDeviceId"
            class="panel discovery-intelligence-panel"
            ref="deviceIntelligencePanel"
            aria-label="Device Intelligence investigation"
          >
            <div class="section-row">
              <div>
                <p class="eyebrow">Device Intelligence</p>
                <h3>
                  {{ selectedAiDevice?.hostname ||
                     selectedAiDevice?.ipAddress ||
                     selectedAiDeviceId }}
                </h3>
                <span class="section-help">
                  {{ selectedAiDevice?.ipAddress || selectedAiDeviceId }}
                  · Evidence-based AI investigation
                </span>
              </div>

              <button
                type="button"
                class="secondary"
                @click="selectedAiDeviceId = null"
              >
                Close
              </button>
            </div>

            <p
              v-if="llmProviderAvailability && !llmProviderAvailability.available"
              class="section-help"
              role="status"
            >
              AI investigation unavailable: {{ llmProviderAvailability.provider || 'provider' }}
              · {{ llmProviderAvailability.reasonCode }}. Discovery and device operation remain available.
            </p>
            <p
              v-else-if="llmProviderAvailability?.cloudDataConsentRequired"
              class="section-help"
            >
              Cloud AI is enabled. The Portal asks before sending network identifiers or captured evidence.
            </p>
            <p
              v-if="aiInvestigating[selectedAiDeviceId]"
              role="status"
            >
              Investigating device evidence...
            </p>

            <p
              v-if="selectedAiError"
              role="alert"
              class="error"
            >
              {{ selectedAiError }}
            </p>

            <section class="device-ai-history">
              <div class="section-row">
                <div>
                  <h4>Investigation history</h4>
                  <p class="section-help">
                    Saved locally · Reopen without AI inference
                  </p>
                </div>

                <button
                  type="button"
                  class="secondary"
                  :disabled="!!aiHistoryLoading[selectedAiDeviceId]"
                  @click="loadAiHistory(selectedAiDeviceId)"
                >
                  Refresh history
                </button>
              </div>

              <p
                v-if="aiHistoryLoading[selectedAiDeviceId]"
                role="status"
                class="section-help"
              >
                Loading saved investigations...
              </p>

              <p
                v-if="aiHistoryErrors[selectedAiDeviceId]"
                role="alert"
                class="error"
              >
                {{ aiHistoryErrors[selectedAiDeviceId] }}
              </p>

              <p
                v-if="
                  !aiHistoryLoading[selectedAiDeviceId] &&
                  !aiHistoryErrors[selectedAiDeviceId] &&
                  !(aiHistory[selectedAiDeviceId]?.length)
                "
                class="section-help"
              >
                No saved investigations yet.
              </p>

              <div
                v-if="aiHistory[selectedAiDeviceId]?.length"
                class="device-ai-history-list"
              >
                <button
                  v-for="record in aiHistory[selectedAiDeviceId]"
                  :key="record.id"
                  type="button"
                  class="device-ai-history-item"
                  :class="{ 'is-selected': selectedAiHistoryId === record.id }"
                  @click="openAiHistoryRecord(record)"
                >
                  <strong>
                    {{ new Date(record.createdAt).toLocaleString() }}
                  </strong>

                  <span>
                    {{ record.result.provider }} /
                    {{ record.result.model }}
                  </span>

                  <small>
                    {{ record.result.evidenceSnapshot?.evidence.length ?? 0 }}
                    evidence records
                    ·
                    {{ record.result.assessment?.hypotheses.length ?? 0 }}
                    hypotheses
                  </small>
                </button>
              </div>
            </section>


            <!-- Read-only MQTT profile investigation review -->
            <section
              class="device-ai-history"
              style="margin-top: 20px"
              aria-label="MQTT profile investigations"
            >
              <div class="section-row">
                <div>
                  <h4>MQTT profile investigations</h4>
                  <p class="section-help">
                    MQTT evidence has its own source identity; a LAN match is not assumed.
                    Captured evidence · AI proposal · Deterministic replay
                  </p>
                </div>

                <div style="display: flex; gap: 8px; flex-wrap: wrap">
                  <button
                    type="button"
                    class="secondary"
                    :disabled="!!mqttProfileLoading[selectedAiDeviceId]"
                    @click="loadMqttProfileHistory(selectedAiDeviceId)"
                  >
                    Refresh
                  </button>

                                    <button
                    type="button"
                    class="secondary"
                    @click="previewMqttProfile(selectedAiDeviceId)"
                  >
                    Preview replay
                  </button>

<button
                    type="button"
                    :disabled="!!mqttProfileRunning[selectedAiDeviceId]"
                    @click="investigateMqttProfile(selectedAiDeviceId)"
                  >
                    {{
                      mqttProfileRunning[selectedAiDeviceId]
                        ? 'Investigating...'
                        : 'Investigate MQTT evidence'
                    }}
                  </button>
                </div>
              </div>

              <p class="section-help">
                Read-only investigation. Captured MQTT evidence must
                already exist. No device commands or installations.
              </p>

              <div class="device-ai-card-detail evidence-source-note" style="margin: 12px 0">
                <strong>Kitchen ESP8266 — real MQTT evidence</strong>
                <p class="section-help">
                  Independent MQTT source; association with the selected LAN
                  device is unverified. Topic: <code>devices/temp-kitchen/data</code>
                </p>
                <button
                  type="button"
                  class="secondary"
                  :disabled="kitchenCaptureLoading"
                  @click="loadKitchenCaptureStatus()"
                >
                  {{ kitchenCaptureLoading ? 'Checking...' : 'Check kitchen evidence' }}
                </button>
                <p v-if="kitchenCaptureError" role="alert" class="error">
                  {{ kitchenCaptureError }}
                </p>
                <p v-if="kitchenCaptureStatus" class="section-help">
                  Capture:
                  {{ kitchenCaptureStatus.enabled ? 'Enabled' : 'Disabled' }}
                  · Stored samples returned:
                  {{ kitchenCaptureStatus.samplesInWindow }} (maximum 8)
                  · Latest capture:
                  {{ kitchenCaptureStatus.latestCapturedAt || 'None' }}
                </p>
              </div>

              <p
                v-if="mqttProfileLoading[selectedAiDeviceId]"
                class="section-help"
                role="status"
              >
                Loading saved MQTT profiles...
              </p>

              <p
                v-if="mqttProfileErrors[selectedAiDeviceId]"
                class="error"
                role="alert"
              >
                {{ mqttProfileErrors[selectedAiDeviceId] }}
              </p>

              <p
                v-if="
                  !mqttProfileLoading[selectedAiDeviceId] &&
                  !mqttProfileErrors[selectedAiDeviceId] &&
                  !mqttProfileHistory[selectedAiDeviceId]?.length
                "
                class="section-help"
              >
                No saved MQTT profile investigations yet.
              </p>

              <div
                v-if="mqttProfileHistory[selectedAiDeviceId]?.length"
                class="device-ai-history-list"
              >
                <button
                  v-for="record in mqttProfileHistory[selectedAiDeviceId]"
                  :key="record.id"
                  type="button"
                  class="device-ai-history-item"
                  :class="{
                    'is-selected': selectedMqttProfile?.id === record.id,
                  }"
                  @click="mqttProfileSelected[selectedAiDeviceId] = record"
                >
                  <strong>
                    {{ new Date(record.createdAt).toLocaleString() }}
                  </strong>
                  <span>
                    {{ record.result.provider }} /
                    {{ record.result.model }}
                  </span>
                  <small>
                    Replay: {{ record.result.replay.status }}
                    · {{ record.result.replay.testedSamples }} samples
                    · Not installed
                  </small>
                </button>
              </div>

              <article
                v-if="selectedMqttProfile"
                class="device-ai-card"
                style="margin-top: 16px"
              >
                <p
                  v-if="selectedMqttProfile.result.provider === 'offline-preview'"
                  class="section-help synthetic-preview-note"
                  role="status"
                >
                  SYNTHETIC PREVIEW — Not captured, not AI-generated,
                  not saved to investigation history.
                </p>


                <div class="device-ai-card-heading">
                  <strong>Observation profile proposal</strong>
                  <span class="device-ai-approval">
                    Proposed · Not installed
                  </span>
                </div>

                <p>
                  <strong>MQTT topic:</strong>
                  <code>
                    {{ selectedMqttProfile.result.proposal.selector }}
                  </code>
                </p>

                <div class="device-ai-card-detail">
                  <strong>Proposed field mappings</strong>
                  <ul>
                    <li
                      v-for="(mapping, field) in selectedMqttProfile.result.proposal.fields"
                      :key="field"
                    >
                      <code>{{ field }}</code>
                      ←
                      <code>{{ mapping.rawKey }}</code>
                      ({{ mapping.type }})
                    </li>
                  </ul>
                </div>

                <div class="device-ai-card-detail">
                  <strong>Deterministic replay</strong>
                  <p>
                    Result:
                    <strong>
                      {{ selectedMqttProfile.result.replay.status }}
                    </strong>
                    ·
                    {{ selectedMqttProfile.result.replay.acceptedSamples }}
                    accepted /
                    {{ selectedMqttProfile.result.replay.testedSamples }}
                    tested
                    ·
                    {{ selectedMqttProfile.result.replay.rejectedSamples }}
                    rejected
                  </p>

                  <strong>Replayed field values</strong>
                  <ul>
                    <li
                      v-for="(value, field) in selectedMqttProfile.result.replay.observedFields"
                      :key="field"
                    >
                      <code>{{ field }}</code>: {{ value }}
                    </li>
                  </ul>
                </div>

                <details>
                  <summary>Replay decisions and evidence</summary>
                  <ul>
                    <li
                      v-for="step in selectedMqttProfile.result.replay.steps"
                      :key="step.evidenceId"
                    >
                      <code>{{ step.evidenceId }}</code>
                      · {{ step.passed ? 'Passed' : 'Failed' }}
                      · {{ step.reason }}
                      <span v-if="step.rejectedFields.length">
                        · Rejected fields:
                        {{ step.rejectedFields.join(', ') }}
                      </span>
                    </li>
                  </ul>

                  <p class="section-help">
                    Supporting evidence references:
                    {{
                      selectedMqttProfile.result.proposal
                        .supportingEvidenceIds.join(', ')
                    }}
                  </p>
                </details>

                <p class="section-help">
                  Replay validates behavior against captured samples,
                  not physical sensor identity or measurement accuracy.
                  This profile has not been approved or installed.
                </p>
              </article>
            </section>

            <div
              v-if="selectedAiReport"
              class="device-ai-report"
            >
              <p>{{ selectedAiReport.report.summary }}</p>
              <p v-if="selectedAiReport.actionResult" class="section-help" role="status">
                {{ selectedAiReport.actionResult.action.replaceAll('_', ' ') }}:
                {{ selectedAiReport.actionResult.outcome }}
                · {{ selectedAiReport.actionResult.reasonCode }}
                <span v-if="selectedAiReport.actionResult.statusCode"> · HTTP {{ selectedAiReport.actionResult.statusCode }}</span>
              </p>

              <div class="device-ai-report-grid">
                <section>
                  <h4>Observed findings</h4>
                  <ul>
                    <li
                      v-for="(finding, index) in selectedAiReport.report.findings"
                      :key="index"
                    >
                      {{ finding }}
                    </li>
                  </ul>
                </section>

                <section>
                  <h4>Unknowns and evidence gaps</h4>
                  <ul>
                    <li
                      v-for="(unknown, index) in selectedAiReport.report.unknowns"
                      :key="index"
                    >
                      {{ unknown }}
                    </li>
                  </ul>
                </section>

                <section>
                  <h4>Suggested investigations</h4>
                  <ul>
                    <li
                      v-for="(step, index) in selectedAiReport.report.nextSteps"
                      :key="index"
                    >
                      {{ step }}
                    </li>
                  </ul>
                </section>
              </div>

              <!-- Evidence snapshot -->
              <section
                v-if="selectedAiReport.evidenceSnapshot"
                class="device-ai-evidence"
              >
                <div class="section-row">
                  <div>
                    <h4>Evidence snapshot</h4>
                    <p class="section-help">
                      {{ selectedAiReport.evidenceSnapshot.id }}
                      · {{ selectedAiReport.evidenceSnapshot.evidence.length }} records
                    </p>
                  </div>
                </div>

                <p
                  v-if="!selectedAiReport.evidenceSnapshot.evidence.length"
                  class="section-help"
                >
                  No structured observations available.
                </p>

                <div v-else class="device-ai-evidence-list">
                  <article
                    v-for="item in selectedAiReport.evidenceSnapshot.evidence"
                    :key="item.id"
                    class="device-ai-evidence-item"
                  >
                    <div class="device-ai-evidence-heading">
                      <strong>{{ item.attribute }}</strong>
                      <span>{{ item.source }}</span>
                    </div>

                    <div class="device-ai-evidence-value">
                      {{ String(item.value) }}
                    </div>

                    <div class="device-ai-evidence-meta">
                      <code>{{ item.id }}</code>
                      <span>{{ item.confidence }}</span>
                      <time :datetime="item.observedAt">
                        {{ new Date(item.observedAt).toLocaleString() }}
                      </time>
                    </div>
                  </article>
                </div>
              </section>

              <!-- Evidence-backed hypotheses -->
              <section
                v-if="selectedAiReport.assessment"
                class="device-ai-hypotheses"
              >
                <h4>
                  Hypotheses
                  ({{ selectedAiReport.assessment.hypotheses.length }})
                </h4>

                <p
                  v-if="!selectedAiReport.assessment.hypotheses.length"
                  class="section-help"
                >
                  No hypotheses were generated from the available evidence.
                </p>

                <div v-else class="device-ai-card-list">
                  <article
                    v-for="hypothesis in selectedAiReport.assessment.hypotheses"
                    :key="hypothesis.id"
                    class="device-ai-card"
                  >
                    <div class="device-ai-card-heading">
                      <strong>{{ hypothesis.claim }}</strong>
                      <span class="device-ai-confidence">
                        {{ aiConfidenceLabel(hypothesis.confidence) }}
                      </span>
                    </div>

                    <div class="device-ai-card-detail">
                      <strong>Supporting evidence</strong>
                      <ul v-if="hypothesis.supportingEvidenceIds.length">
                        <li
                          v-for="id in hypothesis.supportingEvidenceIds"
                          :key="id"
                        >
                          {{ aiEvidenceLabel(selectedAiReport, id) }}
                          <code>{{ id }}</code>
                        </li>
                      </ul>
                      <p v-else class="section-help">
                        No supporting evidence referenced.
                      </p>
                    </div>

                    <div
                      v-if="hypothesis.contradictingEvidenceIds.length"
                      class="device-ai-card-detail"
                    >
                      <strong>Contradicting evidence</strong>
                      <ul>
                        <li
                          v-for="id in hypothesis.contradictingEvidenceIds"
                          :key="id"
                        >
                          {{ aiEvidenceLabel(selectedAiReport, id) }}
                          <code>{{ id }}</code>
                        </li>
                      </ul>
                    </div>

                    <div
                      v-if="hypothesis.missingEvidence.length"
                      class="device-ai-card-detail"
                    >
                      <strong>Missing evidence</strong>
                      <ul>
                        <li
                          v-for="(gap, index) in hypothesis.missingEvidence"
                          :key="index"
                        >
                          {{ gap }}
                        </li>
                      </ul>
                    </div>
                  </article>
                </div>
              </section>

              <!-- Human-approval-required proposals -->
              <section
                v-if="selectedAiReport.assessment"
                class="device-ai-proposals"
              >
                <h4>
                  Investigation proposals
                  ({{ selectedAiReport.assessment.proposals.length }})
                </h4>

                <p
                  v-if="!selectedAiReport.assessment.proposals.length"
                  class="section-help"
                >
                  No additional investigations proposed.
                </p>

                <div v-else class="device-ai-card-list">
                  <article
                    v-for="proposal in selectedAiReport.assessment.proposals"
                    :key="proposal.id"
                    class="device-ai-card"
                  >
                    <div class="device-ai-card-heading">
                      <strong>
                        {{ proposal.action.replaceAll('_', ' ') }}
                      </strong>
                      <span class="device-ai-approval">
                        Requires approval
                      </span>
                    </div>

                    <p>{{ proposal.reason }}</p>

                    <div
                      v-if="proposal.requiredEvidenceIds.length"
                      class="device-ai-card-detail"
                    >
                      <strong>Evidence references</strong>
                      <ul>
                        <li
                          v-for="id in proposal.requiredEvidenceIds"
                          :key="id"
                        >
                          {{ aiEvidenceLabel(selectedAiReport, id) }}
                          <code>{{ id }}</code>
                        </li>
                      </ul>
                    </div>

                    <button
                      v-if="proposal.action === 'inspect_http_headers' && selectedAiReport.investigationId"
                      type="button"
                      class="secondary"
                      :disabled="!!aiActionRunning[proposal.id]"
                      @click="executeInvestigationProposal(proposal)"
                    >
                      {{ aiActionRunning[proposal.id] ? 'Running diagnostic...' : 'Approve and run HTTP identity check' }}
                    </button>
                    <p v-else class="section-help">
                      Proposed only · No supported executor for this action
                    </p>
                    <p v-if="aiActionErrors[proposal.id]" class="error" role="alert">
                      {{ aiActionErrors[proposal.id] }}
                    </p>
                    <p v-if="aiActionResults[proposal.id]" class="section-help" role="status">
                      Action {{ aiActionResults[proposal.id].outcome }} · {{ aiActionResults[proposal.id].reasonCode }}
                      <span v-if="aiActionResults[proposal.id].statusCode"> · HTTP {{ aiActionResults[proposal.id].statusCode }}</span>
                    </p>
                  </article>
                </div>
              </section>

              <p
                v-if="!selectedAiReport.assessment"
                class="section-help"
              >
                Structured assessment unavailable for this investigation.
              </p>

              <p class="section-help">
                {{ selectedAiReport.provider }} /
                {{ selectedAiReport.model }}
                · AI suggestions are not verified device facts.
                No device commands were executed.
              </p>
            </div>
          </section>

          <details id="pending-onboarding" class="discovery-accordion discovery-onboarding-accordion">
            <summary>
              <strong>Pending Energrid onboarding</strong>
              <span>{{ discoveredDevices.length }} pending</span>
            </summary>

          <div class="discovery-empty" v-if="discoveredDevices.length === 0">
            <strong>No pending devices</strong>
            <span
              >MQTT, mDNS, HTTP, Zigbee, and Modbus candidates wait here only
              after a gateway suggests them for Energrid onboarding.</span
            >
          </div>

          <PendingEnrollmentList
            v-else
            :cards="pendingEnrollmentCards"
            :busy-by-candidate-id="discoveryDecisionBusy"
            @decide="applyPendingDecision"
            @rename="renamePendingCandidate"
          />

          </details>

          <div id="approved-onboarding" class="section-row discovery-section-title">
            <h3>Approved from onboarding</h3>
            <span>{{ approvedOnboardingDevices.length }} approved</span>
          </div>

          <div
            class="discovery-empty compact"
            v-if="approvedOnboardingDevices.length === 0"
          >
            <strong>No approved onboarding devices yet</strong>
            <span
              >Approved devices will stay visible here and also appear on the
              Devices page.</span
            >
          </div>

          <div v-else class="discovery-list">
            <article
              v-for="device in approvedOnboardingDevices"
              :key="`approved-${device.id}`"
              class="discovery-card approved-discovery-card"
              role="button"
              tabindex="0"
              @click="openApprovedOnboardingTarget(device)"
              @keydown.enter="openApprovedOnboardingTarget(device)"
            >
              <div>
                <span class="discovery-source approved">approved</span>
                <h3>{{ device.displayName }}</h3>
                <p>
                  {{ device.adapter.driver }} ·
                  {{ device.adapter.target || device.adapter.protocol }}
                </p>
              </div>
              <dl class="device-facts">
                <div>
                  <dt>Room</dt>
                  <dd>{{ device.zoneName }}</dd>
                </div>
                <div>
                  <dt>Capabilities</dt>
                  <dd>
                    {{
                      device.capabilities
                        .map((capability) => capability.kind)
                        .join(', ')
                    }}
                  </dd>
                </div>
                <div>
                  <dt>HTTP page</dt>
                  <dd>
                    {{
                      approvedDeviceSettingsUrl(device)
                        ? 'available'
                        : 'run scan to match'
                    }}
                  </dd>
                </div>
              </dl>
              <div class="discovery-actions">
                <button
                  class="primary"
                  type="button"
                  @click.stop="openApprovedDevice(device)"
                >
                  Open in Devices
                </button>
                <a
                  v-if="approvedDeviceSettingsUrl(device)"
                  class="ghost-link"
                  :href="approvedDeviceSettingsUrl(device)"
                  target="_blank"
                  rel="noreferrer"
                  @click.stop
                >
                  Open settings
                </a>
                <a
                  v-if="approvedDeviceProxyUrl(device)"
                  class="ghost-link"
                  :href="approvedDeviceProxyUrl(device)"
                  @click.stop
                >
                  Via gateway
                </a>
                <button
                  v-if="!approvedDeviceSettingsUrl(device)"
                  class="ghost"
                  type="button"
                  :disabled="!!findingHttpPageByDeviceId[device.id]"
                  @click.stop="findApprovedDeviceHttpPage(device)"
                >
                  {{
                    findingHttpPageByDeviceId[device.id]
                      ? 'Finding...'
                      : 'Find HTTP page'
                  }}
                </button>
              </div>
            </article>
          </div>
        </section>

        <section v-else-if="activePage === 'bus'" class="panel workspace-panel">
          <div class="page-heading split-heading">
            <div>
              <p class="eyebrow">Site Bus</p>
              <h2>MQTT debug</h2>
              <span
                >Inspect broker traffic, trace adapter decisions, and confirm
                how MQTT messages reach the Energrid device registry.</span
              >
            </div>
            <div class="bus-actions">
              <span :class="['live-indicator', mqttBusStreamStatus]">
                <span
                  :class="[
                    'dot',
                    mqttBusStreamStatus === 'live'
                      ? 'green'
                      : mqttBusStreamStatus === 'error'
                        ? 'amber'
                        : 'blue',
                  ]"
                ></span>
                {{
                  mqttBusStreamStatus === 'live'
                    ? 'Live stream'
                    : mqttBusStreamStatus === 'connecting'
                      ? 'Connecting stream'
                      : mqttBusStreamStatus === 'error'
                        ? 'Stream retrying'
                        : 'Stream idle'
                }}
              </span>
              <button
                class="primary"
                type="button"
                :disabled="mqttBusLoading"
                @click="loadMqttBus()"
              >
                {{ mqttBusLoading ? 'Refreshing...' : 'Refresh bus' }}
              </button>
            </div>
          </div>

          <div v-if="mqttBus" class="bus-page">
            <div class="scan-origin bus-status-grid">
              <div>
                <span>Status</span>
                <strong>{{ mqttBus.status }}</strong>
              </div>
              <div>
                <span>Broker</span>
                <strong
                  >{{ mqttBus.broker.host }}:{{ mqttBus.broker.port }}</strong
                >
              </div>
              <div>
                <span>Prefix</span>
                <strong>{{ mqttBus.prefix }}</strong>
              </div>
            </div>

            <section class="mqtt-explorer">
              <aside class="mqtt-tree-panel">
                <div class="mqtt-toolbar">
                  <strong>{{ mqttBus.broker.host }}</strong>
                  <input
                    v-model="mqttTopicFilter"
                    class="compact-input"
                    placeholder="Search topics"
                  />
                </div>

                <div class="topic-chip-row compact-row">
                  <span v-for="topic in mqttBus.subscriptions" :key="topic">{{
                    topic
                  }}</span>
                </div>

                <div
                  v-if="visibleMqttTreeNodes.length === 0"
                  class="discovery-empty compact"
                >
                  <strong>No topic tree yet</strong>
                  <span
                    >Wait for retained or live MQTT messages to arrive from the
                    stream.</span
                  >
                </div>
                <div v-else class="mqtt-tree">
                  <button
                    v-for="node in visibleMqttTreeNodes"
                    :key="node.key"
                    :class="[
                      'mqtt-tree-row',
                      { selected: selectedMqttTopic === node.topic },
                    ]"
                    :style="{ '--topic-depth': node.depth }"
                    type="button"
                    @click="selectMqttTopic(node.topic)"
                  >
                    <span
                      class="mqtt-tree-toggle"
                      @click.stop="
                        node.childCount
                          ? toggleMqttTopic(node.topic)
                          : selectMqttTopic(node.topic)
                      "
                    >
                      {{
                        node.childCount
                          ? expandedMqttTopics.has(node.topic)
                            ? '▾'
                            : '▸'
                          : '•'
                      }}
                    </span>
                    <span class="mqtt-tree-label">{{ node.label }}</span>
                    <span
                      v-if="node.directMessageCount || node.messageCount"
                      class="mqtt-tree-count"
                    >
                      {{ node.directMessageCount || node.messageCount }}
                    </span>
                    <span
                      v-else-if="node.subscription"
                      class="mqtt-tree-count muted"
                      >sub</span
                    >
                  </button>
                </div>
              </aside>

              <section class="mqtt-detail-panel">
                <div class="section-row">
                  <div>
                    <h3>{{ selectedMqttTopic || 'Select a topic' }}</h3>
                    <span class="section-help">
                      {{
                        selectedMqttNode
                          ? `${selectedMqttNode.messageCount} messages in this branch`
                          : `${mqttBus.recentMessages.length} retained in recent buffer`
                      }}
                    </span>
                  </div>
                  <span
                    v-if="selectedMqttNode?.lastMessage"
                    :class="[
                      'trust-pill',
                      selectedMqttNode.lastMessage.handled
                        ? 'approved'
                        : selectedMqttNode.lastMessage.validJson
                          ? 'unknown'
                          : 'discovered',
                    ]"
                  >
                    {{
                      selectedMqttNode.lastMessage.handled
                        ? 'handled'
                        : selectedMqttNode.lastMessage.reason
                    }}
                  </span>
                </div>

                <div class="mqtt-value-card">
                  <span>Last value</span>
                  <code>{{
                    compactMqttPayload(selectedMqttLastMessage?.payloadPreview)
                  }}</code>
                  <details
                    v-if="selectedMqttLastMessage"
                    class="payload-details"
                  >
                    <summary>Formatted JSON</summary>
                    <pre>{{ selectedMqttPrettyPayload }}</pre>
                  </details>
                </div>

                <details class="mqtt-publish-drawer" open>
                  <summary>Publish</summary>
                  <label>
                    Topic
                    <input
                      v-model="mqttPublishTopic"
                      :placeholder="`${mqttBus.prefix}/debug/manual`"
                      autocomplete="off"
                    />
                  </label>
                  <label>
                    Payload
                    <textarea v-model="mqttPublishPayload" rows="5"></textarea>
                  </label>
                  <button
                    class="primary"
                    type="button"
                    :disabled="mqttPublishBusy"
                    @click="publishMqttDebugMessage"
                  >
                    {{ mqttPublishBusy ? 'Publishing...' : 'Publish message' }}
                  </button>
                  <p v-if="mqttPublishError" class="error">
                    {{ mqttPublishError }}
                  </p>
                </details>
              </section>

              <aside class="mqtt-pipeline-panel">
                <div class="mqtt-pipeline-heading">
                  <div>
                    <span>Processing trace</span>
                    <h3>Message pipeline</h3>
                  </div>
                  <span
                    v-if="selectedMqttLastMessage"
                    :class="[
                      'trust-pill',
                      selectedMqttLastMessage.handled
                        ? 'approved'
                        : selectedMqttLastMessage.validJson
                          ? 'unknown'
                          : 'discovered',
                    ]"
                  >
                    {{
                      selectedMqttLastMessage.handled
                        ? 'accepted'
                        : 'not handled'
                    }}
                  </span>
                </div>

                <div v-if="selectedMqttMessageMeta" class="mqtt-message-meta">
                  <div>
                    <span>Topic</span>
                    <strong>{{ selectedMqttMessageMeta.topic }}</strong>
                  </div>
                  <div>
                    <span>Observed</span>
                    <strong>{{
                      formatMqttTime(selectedMqttMessageMeta.observedAt)
                    }}</strong>
                  </div>
                  <div>
                    <span>Format</span>
                    <strong>{{ selectedMqttMessageMeta.format }}</strong>
                  </div>
                  <div>
                    <span>Size</span>
                    <strong>{{ selectedMqttMessageMeta.bytes }}</strong>
                  </div>
                </div>

                <div class="mqtt-pipeline">
                  <article
                    v-for="(step, index) in selectedMqttPipeline"
                    :key="step.id"
                    :class="['mqtt-pipeline-step', step.status]"
                  >
                    <div class="mqtt-pipeline-rail">
                      <span class="mqtt-pipeline-marker">
                        {{
                          step.status === 'passed'
                            ? '✓'
                            : step.status === 'failed'
                              ? '×'
                              : step.status === 'warning'
                                ? '!'
                                : '·'
                        }}
                      </span>
                      <span
                        v-if="index < selectedMqttPipeline.length - 1"
                        class="mqtt-pipeline-line"
                      ></span>
                    </div>
                    <div>
                      <strong>{{ step.label }}</strong>
                      <span>{{ step.detail }}</span>
                    </div>
                  </article>
                </div>

                <div class="mqtt-pipeline-outcome">
                  <span>Adapter decision</span>
                  <strong>
                    {{
                      selectedMqttMessageMeta?.outcome ||
                      'Select a topic to inspect its latest message'
                    }}
                  </strong>
                </div>

                <div class="network-stat-grid compact-stats">
                  <div v-for="item in mqttStats" :key="item.label">
                    <span>{{ item.label }}</span>
                    <strong>{{ item.value }}</strong>
                    <small>{{ item.detail }}</small>
                  </div>
                </div>
              </aside>
            </section>

            <section class="bus-stream">
              <div class="section-row">
                <div>
                  <h3>History</h3>
                  <span class="section-help">
                    {{ selectedMqttTopicMessages.length }} shown ·
                    {{ mqttBus.recentMessages.length }} retained
                  </span>
                </div>
              </div>
              <div
                v-if="selectedMqttTopicMessages.length === 0"
                class="discovery-empty compact"
              >
                <strong>No MQTT messages yet</strong>
                <span
                  >Publish a test message, or wait for devices and adapters to
                  emit telemetry on the site bus.</span
                >
              </div>
              <div v-else class="network-table-wrap">
                <table class="network-table bus-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Topic</th>
                      <th>Result</th>
                      <th>Bytes</th>
                      <th>Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="message in selectedMqttTopicMessages"
                      :key="`${message.observedAt}-${message.topic}`"
                    >
                      <td data-label="Time">
                        <strong>{{
                          formatMqttTime(message.observedAt)
                        }}</strong>
                        <span>{{ message.observedAt }}</span>
                      </td>
                      <td data-label="Topic">
                        <strong>{{ message.topic }}</strong>
                        <span>{{ message.validJson ? 'json' : 'raw' }}</span>
                      </td>
                      <td data-label="Result">
                        <span
                          :class="[
                            'trust-pill',
                            message.handled
                              ? 'approved'
                              : message.validJson
                                ? 'unknown'
                                : 'discovered',
                          ]"
                        >
                          {{ message.handled ? 'handled' : message.reason }}
                        </span>
                      </td>
                      <td data-label="Bytes">
                        <strong>{{ formatBytes(message.payloadBytes) }}</strong>
                      </td>
                      <td data-label="Payload">
                        <code>{{
                          compactMqttPayload(message.payloadPreview)
                        }}</code>
                        <details class="payload-details compact">
                          <summary>
                            {{
                              message.validJson
                                ? 'Formatted JSON'
                                : 'Raw payload'
                            }}
                          </summary>
                          <pre>{{
                            formatMqttPayload(message.payloadPreview)
                          }}</pre>
                        </details>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div v-else class="discovery-empty">
            <strong>MQTT debug state unavailable</strong>
            <span>Load the bus state after the API is online.</span>
          </div>
        </section>

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
        </section>

        <WeatherDashboard v-else-if="activePage === 'weather'" :api-base="apiBase" :access-token="accessToken" />
        <EnergyDashboard v-else-if="activePage === 'energy'" :api-base="apiBase" :access-token="accessToken" />
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
  </main>
</template>
