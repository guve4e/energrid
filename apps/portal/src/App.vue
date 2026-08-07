import ExecutionFlowVisualization from './components/execution/ExecutionFlowVisualization.vue'
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

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

type PortalState = {
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
    hostname?: string;
    vendor?: string;
    protocol: string;
    confidence: number;
    status: string;
    settingsUrl?: string;
    model?: string;
    app?: string;
    generation?: number;
    discoveredAt: string;
    reason: string;
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

const email = ref('admin@energrid.local');
const password = ref('admin123');
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
const discoveryView = ref<'capable' | 'all'>('capable');
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
const transcript = ref('');
const assistant = ref('');
const plan = ref('');
const eventLog = ref<string[]>([]);
const metrics = ref<VoiceMetrics | null>(null);
const voiceRuns = ref<VoiceRunRecord[]>([]);
const voiceRunsLoading = ref(false);
const voiceRunsError = ref('');
const connected = ref(false);
const recording = ref(false);
const theme = ref(localStorage.getItem(themeKey) || 'dark');
const endpointMode = ref(
  localStorage.getItem(endpointModeKey) || 'same-origin',
);
const userMenuOpen = ref(false);
const notificationsOpen = ref(false);
const mobileMenuOpen = ref(false);
const activePage = ref('assistant');
const selectedDeviceId = ref<string | null>(null);
const selectedExecutionTraceId = ref<string | null>(null);
const deviceActionBusy = ref<Record<string, boolean>>({});
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
  { id: 'bus', label: 'Bus', active: activePage.value === 'bus' },
  { id: 'systems', label: 'Systems', active: activePage.value === 'systems' },
  { id: 'executions', label: 'Executions', active: activePage.value === 'executions' },
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
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
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
  const m = metrics.value;
  if (!m) return 'No completed turn yet.';
  if (m.speechGatePassed && !transcript.value && !m.sttMs) {
    return 'Audio reached the server and passed the speech gate, but STT did not return a transcript before turn end.';
  }
  if (m.sttMs && m.sttMs > 8000) return 'STT is the bottleneck on this turn.';
  if (m.firstAudioMs && m.firstAudioMs > 5000)
    return 'Speech output is the bottleneck on this turn.';
  if (!m.speechGatePassed)
    return 'The speech gate blocked this turn before STT.';
  return 'No obvious bottleneck detected.';
});
const deviceCards = computed(() => state.value?.devices || []);
const approvedDevices = computed(() =>
  deviceCards.value.filter((device) => device.trustStatus === 'approved'),
);
const deviceCapabilityOptions = computed(() => {
  const capabilities = new Set<string>();
  for (const device of approvedDevices.value) {
    for (const capability of device.capabilities)
      capabilities.add(capability.kind);
  }
  return [...capabilities].sort((left, right) => left.localeCompare(right));
});
const deviceZoneOptions = computed(() => {
  const zones = new Map<string, string>();
  for (const device of approvedDevices.value)
    zones.set(device.zoneId, device.zoneName);
  return [...zones.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
});
const filteredApprovedDevices = computed(() => {
  const search = deviceSearch.value.trim().toLowerCase();

  return approvedDevices.value
    .filter((device) => {
      if (
        deviceCapabilityFilter.value !== 'all' &&
        !device.capabilities.some(
          (capability) => capability.kind === deviceCapabilityFilter.value,
        )
      ) {
        return false;
      }
      if (
        deviceZoneFilter.value !== 'all' &&
        device.zoneId !== deviceZoneFilter.value
      )
        return false;
      if (
        deviceStatusFilter.value === 'online' &&
        device.state.status !== 'online'
      )
        return false;
      if (
        deviceStatusFilter.value === 'offline' &&
        device.state.status !== 'offline'
      )
        return false;
      if (
        deviceStatusFilter.value === 'controllable' &&
        !canToggleDevice(device)
      )
        return false;
      if (
        deviceStatusFilter.value === 'needs_setup' &&
        device.adapter.configured
      )
        return false;

      if (!search) return true;
      return [
        device.displayName,
        device.zoneName,
        device.kind,
        device.adapter.driver,
        device.adapter.protocol,
        device.adapter.transport,
        device.adapter.target,
        device.adapter.commandTopic,
        device.adapter.telemetryTopic,
        device.state.status,
        device.memberDeviceIds?.join(' '),
        device.capabilities.map((capability) => capability.kind).join(' '),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search);
    })
    .sort((left, right) => {
      const zone = left.zoneName.localeCompare(right.zoneName);
      if (zone !== 0) return zone;
      return left.displayName.localeCompare(right.displayName);
    });
});
const discoveredDevices = computed(() =>
  deviceCards.value.filter((device) => device.trustStatus === 'discovered'),
);
const deviceSourceStats = computed(() => {
  const busBacked = deviceCards.value.filter((device) =>
    ['mqtt', 'zigbee', 'matter', 'modbus'].includes(
      device.adapter.transport || device.adapter.protocol,
    ),
  ).length;
  const needsSetup = deviceCards.value.filter(
    (device) => !device.adapter.configured,
  ).length;
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
      label: 'Needs setup',
      value: `${needsSetup}`,
      detail: 'adapter not configured',
    },
  ];
});
const networkZones = computed(() => state.value?.networkZones || []);
const networkDevices = computed(() => state.value?.networkDevices || []);
const energridCapableNetworkDevices = computed(() =>
  networkDevices.value.filter((device) =>
    isEnergridCapableNetworkDevice(device),
  ),
);
const visibleNetworkDevices = computed(() =>
  discoveryView.value === 'all'
    ? networkDevices.value
    : energridCapableNetworkDevices.value,
);
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
const selectedDeviceTraces = computed(() =>
  state.value?.executionTraces
    ?.filter(
      (trace) => trace.deviceId === selectedDeviceId.value,
    )
    .slice(0, 5) || [],
);

const selectedExecutionTrace = computed(() =>
  state.value?.executionTraces?.find(
    (trace) => trace.id === selectedExecutionTraceId.value,
  ) || null,
);


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

function setActivePage(pageId: string) {
  activePage.value = pageId;
  selectedDeviceId.value = null;
  selectedExecutionTraceId.value = null;
  closeMobileMenu();
  if (pageId === 'assistant') void loadVoiceRuns();
  if (pageId === 'bus') {
    void loadMqttBus();
    startMqttBusStream();
  } else {
    stopMqttBusStream();
  }
}

function logDiscoveryDecision(deviceId: string, action: string) {
  appendLog(
    `[discovery] ${action} requested for ${deviceId}; server-side approval flow is next`,
  );
}

async function scanNetwork() {
  scanningNetwork.value = true;
  stateError.value = '';
  try {
    appendLog('[discovery] scanning local network');
    const response = await fetch(`${apiBase}/portal/network/scan`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    });
    if (!response.ok) throw new Error('Network scan unavailable');
    const result = (await response.json()) as {
      zones?: NonNullable<PortalState['networkZones']>;
      devices: NetworkDevice[];
    };
    if (state.value) {
      state.value = {
        ...state.value,
        networkZones: result.zones || state.value.networkZones,
        networkDevices: result.devices,
      };
    }
    appendLog(
      `[discovery] scan complete; ${result.devices.length} devices visible`,
    );
  } catch (error) {
    stateError.value =
      error instanceof Error ? error.message : 'Network scan unavailable';
    appendLog(`[discovery] scan failed: ${stateError.value}`);
  } finally {
    scanningNetwork.value = false;
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
  if (device.state.status === 'online') return 'green';
  if (device.state.status === 'offline') return 'amber';
  return 'blue';
}

function selectDevice(device: PortalDevice) {
  selectedDeviceId.value = device.id;
}

function closeDeviceSheet() {
  selectedDeviceId.value = null;
  selectedExecutionTraceId.value = null;
}

function openExecutionTrace(traceId: string) {
  selectedExecutionTraceId.value = traceId;
}

function closeExecutionTrace() {
  selectedExecutionTraceId.value = null;
}

function deviceValuePreview(device: PortalDevice) {
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
  return device.state.status;
}

function deviceStateDetail(device: PortalDevice) {
  const command = device.state.command;
  if (command?.status === 'pending') return 'waiting for device ack';
  if (command?.status === 'acked') return 'confirmed by telemetry';
  if (command?.status === 'no_ack') return 'published, no telemetry ack';
  if (command?.status === 'failed') return 'publish failed';
  return device.adapter.configured ? 'configured' : 'needs setup';
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
    canToggleDevice(device) &&
    device.adapter.configured &&
    device.state.command?.status !== 'pending'
  );
}

function deviceIsOn(device: PortalDevice) {
  const values = device.state.values;
  return Boolean(values.on ?? values.output ?? values.switch ?? values.powered);
}

function deviceControlIsOn(device: PortalDevice) {
  if (device.state.command?.status === 'pending') {
    const expected = device.state.command.expectedValues;
    const on =
      expected.on ?? expected.output ?? expected.switch ?? expected.powered;
    if (typeof on === 'boolean') return on;
  }
  return deviceIsOn(device);
}

function deviceCommandIsPending(device: PortalDevice) {
  return device.state.command?.status === 'pending';
}

function deviceToggleLabel(device: PortalDevice) {
  if (!device.adapter.configured) return 'Setup';
  return deviceActionBusy.value[device.id]
    ? 'Sending'
    : deviceIsOn(device)
      ? 'On'
      : 'Off';
}

async function toggleDevice(device: PortalDevice) {
  return sendDeviceAction(device, deviceIsOn(device) ? 'turn_off' : 'turn_on');
}

async function sendDeviceAction(
  device: PortalDevice,
  action: 'turn_on' | 'turn_off',
) {
  if (!canSendToggle(device) || deviceActionBusy.value[device.id]) return;

  deviceActionBusy.value = { ...deviceActionBusy.value, [device.id]: true };
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
    if (!response.ok) {
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

function isEnergridCapableNetworkDevice(device: NetworkDevice) {
  const vendor = (device.vendor || '').toLowerCase();
  const model = (device.model || '').toLowerCase();
  const app = (device.app || '').toLowerCase();
  return (
    vendor.includes('shelly') ||
    model.includes('shelly') ||
    app.includes('shelly') ||
    canProxyDevice(device)
  );
}

function networkDeviceClass(device: NetworkDevice) {
  if (canProxyDevice(device)) return 'approved';
  if (isEnergridCapableNetworkDevice(device)) return 'discovered';
  return 'unknown';
}

function networkDeviceBadge(device: NetworkDevice) {
  if (canProxyDevice(device)) return 'gateway ready';
  if (isEnergridCapableNetworkDevice(device)) return 'capable';
  return 'network only';
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
  await loadState();
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
    const response = await fetch(`${apiBase}/voice/runs?limit=8`);
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
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (ws?.readyState === WebSocket.CONNECTING) {
    return new Promise<void>((resolve, reject) => {
      ws?.addEventListener('open', () => resolve(), { once: true });
      ws?.addEventListener(
        'error',
        () => reject(new Error('Voice socket failed')),
        { once: true },
      );
    });
  }

  wsUrl.value = effectiveWsUrl.value;
  clientTrace.value.connectStartAt = performance.now();
  appendLog(`[voice] connecting ${wsUrl.value}`);
  ws = new WebSocket(wsUrl.value);
  ws.binaryType = 'arraybuffer';
  attachVoiceListeners(ws);
  voiceStatus.value = 'connecting';

  return new Promise<void>((resolve, reject) => {
    ws?.addEventListener(
      'open',
      () => {
        connected.value = true;
        voiceStatus.value = 'connected';
        clientTrace.value.connectedAt = performance.now();
        appendLog(
          `[voice] connected in ${delta(clientTrace.value.connectStartAt, clientTrace.value.connectedAt)}`,
        );
        resolve();
      },
      { once: true },
    );

    ws?.addEventListener(
      'error',
      () => {
        voiceStatus.value = 'socket error';
        appendLog('[voice] socket error');
        reject(new Error('Voice socket failed'));
      },
      { once: true },
    );
  });
}

function attachVoiceListeners(socket: WebSocket) {
  socket.addEventListener('close', () => {
    connected.value = false;
    voiceStatus.value = 'closed';
    ws = null;
    appendLog('[voice] closed');
  });

  socket.addEventListener('error', () => {
    voiceStatus.value = 'socket error';
    appendLog('[voice] socket error');
  });

  socket.addEventListener('message', (message) => {
    const event = JSON.parse(message.data);
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
    }
    if (event.type === 'error') voiceStatus.value = `error: ${event.message}`;
  });
}

function disconnectVoice() {
  appendLog('[voice] disconnect requested');
  ws?.close();
  ws = null;
  connected.value = false;
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
  try {
    await connectVoice();
  } catch {
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  resetTurn();
  pcmQueue = [];
  recording.value = true;
  voiceStatus.value = 'recording';
  clientTrace.value.recordStartAt = performance.now();
  appendLog('[audio] recording started');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext();
  source = audioContext.createMediaStreamSource(mediaStream);
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
  loadState();
  loadVoiceRuns();
}

onBeforeUnmount(() => {
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
              ><span class="dot green"></span
              >{{ connected ? 'connected' : 'offline' }}</span
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
              @pointerdown="startRecording"
              @pointerup="stopRecording"
              @pointercancel="stopRecording"
              @lostpointercapture="stopRecording"
            >
              <span>{{
                recording
                  ? 'Release to send'
                  : voiceStatus === 'connecting'
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
          class="panel workspace-panel"
        >
          <div class="page-heading">
            <p class="eyebrow">Approved Inventory</p>
            <h2>Devices</h2>
            <span
              >Everything the assistant is allowed to understand and operate at
              this site.</span
            >
          </div>

          <div class="summary-strip">
            <div>
              <span>Total</span>
              <strong>{{ deviceSummary.total }}</strong>
            </div>
            <div>
              <span>Approved</span>
              <strong>{{ deviceSummary.approved }}</strong>
            </div>
            <div>
              <span>Controllable</span>
              <strong>{{ deviceSummary.controllable }}</strong>
            </div>
            <div>
              <span>Sensors</span>
              <strong>{{ deviceSummary.sensors }}</strong>
            </div>
            <div>
              <span>Systems</span>
              <strong>{{ deviceSummary.systems }}</strong>
            </div>
            <div>
              <span>Learning</span>
              <strong>{{ deviceSummary.learningEnabled }}</strong>
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
                placeholder="Search devices, topics, zones"
              />
            </label>
            <select
              v-model="deviceCapabilityFilter"
              aria-label="Filter by capability"
            >
              <option value="all">All capabilities</option>
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
            <span>{{ filteredApprovedDevices.length }} shown</span>
          </div>

          <div
            v-if="approvedDevices.length === 0"
            class="discovery-empty compact"
          >
            <strong>No approved devices yet</strong>
            <span
              >Approve devices from Discovery or publish them through the site
              bus.</span
            >
          </div>
          <div
            v-else-if="filteredApprovedDevices.length === 0"
            class="discovery-empty compact"
          >
            <strong>No devices match this filter</strong>
            <span
              >Clear search or loosen the capability, zone, or status
              filters.</span
            >
          </div>
          <div v-else class="network-table-wrap device-table-wrap">
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
                  v-for="device in filteredApprovedDevices"
                  :key="device.id"
                  :class="{ selected: selectedDeviceId === device.id }"
                  @click="selectDevice(device)"
                >
                  <td data-label="Device">
                    <strong>{{ device.displayName }}</strong>
                    <span>{{ device.kind }} · {{ device.id }}</span>
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
                    <div
                      v-if="canToggleDevice(device)"
                      class="device-switch-control"
                      :class="{
                        busy:
                          deviceActionBusy[device.id] ||
                          deviceCommandIsPending(device),
                        noAck: device.state.command?.status === 'no_ack',
                      }"
                      role="group"
                      :aria-label="`Control ${device.displayName}`"
                    >
                      <button
                        type="button"
                        :class="{
                          active: !deviceControlIsOn(device),
                          off: !deviceControlIsOn(device),
                        }"
                        :disabled="
                          !canSendToggle(device) || deviceActionBusy[device.id]
                        "
                        :title="
                          device.adapter.configured
                            ? 'Turn off'
                            : 'Adapter is not configured yet'
                        "
                        @click.stop="sendDeviceAction(device, 'turn_off')"
                      >
                        Off
                      </button>
                      <button
                        type="button"
                        :class="{
                          active: deviceControlIsOn(device),
                          on: deviceControlIsOn(device),
                        }"
                        :disabled="
                          !canSendToggle(device) || deviceActionBusy[device.id]
                        "
                        :title="
                          device.adapter.configured
                            ? 'Turn on'
                            : 'Adapter is not configured yet'
                        "
                        @click.stop="sendDeviceAction(device, 'turn_on')"
                      >
                        On
                      </button>
                    </div>
                    <span v-else class="trust-pill approved">Read only</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div
            v-if="selectedDevice"
            class="device-sheet-backdrop"
            @click="closeDeviceSheet"
          ></div>
          <aside
            v-if="selectedDevice"
            class="device-sheet"
            aria-label="Device details"
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

            <dl class="device-facts detail-facts">
              <div>
                <dt>Status</dt>
                <dd>
                  {{ selectedDevice.state.status }} ·
                  {{
                    selectedDevice.adapter.configured
                      ? 'configured'
                      : 'needs setup'
                  }}
                </dd>
              </div>
              <div>
                <dt>Adapter</dt>
                <dd>{{ adapterLabel(selectedDevice) }}</dd>
              </div>
              <div>
                <dt>Route</dt>
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
              <div v-if="canToggleDevice(selectedDevice)">
                <dt>Control</dt>
                <dd>
                  <div
                    class="device-switch-control detail-switch-control"
                    :class="{
                      busy:
                        deviceActionBusy[selectedDevice.id] ||
                        deviceCommandIsPending(selectedDevice),
                      noAck: selectedDevice.state.command?.status === 'no_ack',
                    }"
                    role="group"
                    :aria-label="`Control ${selectedDevice.displayName}`"
                  >
                    <button
                      type="button"
                      :class="{
                        active: !deviceControlIsOn(selectedDevice),
                        off: !deviceControlIsOn(selectedDevice),
                      }"
                      :disabled="
                        !canSendToggle(selectedDevice) ||
                        deviceActionBusy[selectedDevice.id]
                      "
                      @click="sendDeviceAction(selectedDevice, 'turn_off')"
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      :class="{
                        active: deviceControlIsOn(selectedDevice),
                        on: deviceControlIsOn(selectedDevice),
                      }"
                      :disabled="
                        !canSendToggle(selectedDevice) ||
                        deviceActionBusy[selectedDevice.id]
                      "
                      @click="sendDeviceAction(selectedDevice, 'turn_on')"
                    >
                      On
                    </button>
                  </div>
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
                      : selectedDevice.state.status
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
                    @click="openExecutionTrace(trace.id)"
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
                <dt>Command topic</dt>
                <dd>{{ selectedDevice.adapter.commandTopic }}</dd>
              </div>
              <div v-if="selectedDevice.adapter.telemetryTopic">
                <dt>Telemetry topic</dt>
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
          v-else-if="activePage === 'discovery'"
          class="panel workspace-panel"
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
            <button
              class="primary"
              type="button"
              :disabled="scanningNetwork"
              @click="scanNetwork"
            >
              {{ scanningNetwork ? 'Scanning...' : 'Scan networks' }}
            </button>
          </div>

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
                <span
                  >{{ visibleNetworkDevices.length }} shown ·
                  {{ networkDevices.length }} found</span
                >
                <div class="segmented compact">
                  <button
                    type="button"
                    :class="{ active: discoveryView === 'capable' }"
                    @click="discoveryView = 'capable'"
                  >
                    Energrid capable
                  </button>
                  <button
                    type="button"
                    :class="{ active: discoveryView === 'all' }"
                    @click="discoveryView = 'all'"
                  >
                    All devices
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
              <strong>No Energrid-capable devices in this view</strong>
              <span
                >Switch to all devices to see every host the site brain found on
                the configured networks.</span
              >
            </div>
            <div v-else class="network-table-wrap">
              <table class="network-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Address</th>
                    <th>Model</th>
                    <th>Network</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="device in visibleNetworkDevices" :key="device.id">
                    <td data-label="Device">
                      <strong>{{
                        device.vendor || device.hostname || 'Network device'
                      }}</strong>
                      <span>{{
                        device.hostname ||
                        device.app ||
                        device.protocol ||
                        'unknown'
                      }}</span>
                    </td>
                    <td data-label="Address">
                      <strong>{{ device.ipAddress }}</strong>
                      <span>{{ device.macAddress || 'no mac yet' }}</span>
                    </td>
                    <td data-label="Model">
                      <strong>{{
                        device.model ||
                        device.app ||
                        device.protocol ||
                        'unknown'
                      }}</strong>
                      <span>{{ device.reason }}</span>
                    </td>
                    <td data-label="Network">
                      <strong>{{ device.networkZoneName }}</strong>
                      <span>{{ device.networkZoneId }}</span>
                    </td>
                    <td data-label="Status">
                      <span :class="['trust-pill', networkDeviceClass(device)]">
                        {{ networkDeviceBadge(device) }}
                      </span>
                    </td>
                    <td data-label="Actions">
                      <div class="network-actions">
                        <a
                          v-if="device.settingsUrl"
                          class="ghost-link"
                          :href="device.settingsUrl"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open settings
                        </a>
                        <a
                          v-if="canProxyDevice(device)"
                          class="ghost-link"
                          :href="deviceProxyUrl(device)"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Via gateway
                        </a>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="section-row discovery-section-title">
            <h3>Pending Energrid onboarding</h3>
            <span>{{ discoveredDevices.length }} pending</span>
          </div>

          <div class="discovery-empty" v-if="discoveredDevices.length === 0">
            <strong>No pending devices</strong>
            <span
              >MQTT, mDNS, HTTP, Zigbee, and Modbus candidates wait here only
              after a gateway suggests them for Energrid onboarding.</span
            >
          </div>

          <div v-else class="discovery-list">
            <article
              v-for="device in discoveredDevices"
              :key="device.id"
              class="discovery-card"
            >
              <div>
                <span class="discovery-source">{{
                  device.discovery?.source || device.adapter.protocol
                }}</span>
                <h3>
                  {{ device.discovery?.suggestedName || device.displayName }}
                </h3>
                <p>{{ device.discovery?.reason || 'Discovered locally.' }}</p>
              </div>
              <dl class="device-facts">
                <div>
                  <dt>Suggested room</dt>
                  <dd>
                    {{ device.discovery?.suggestedRoom || device.zoneName }}
                  </dd>
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
                  <dt>Confidence</dt>
                  <dd>
                    {{ Math.round((device.discovery?.confidence || 0) * 100) }}%
                  </dd>
                </div>
              </dl>
              <div class="discovery-actions">
                <button
                  class="primary"
                  type="button"
                  @click="logDiscoveryDecision(device.id, 'approve')"
                >
                  Approve
                </button>
                <button
                  class="ghost"
                  type="button"
                  @click="logDiscoveryDecision(device.id, 'rename')"
                >
                  Rename
                </button>
                <button
                  class="ghost"
                  type="button"
                  @click="logDiscoveryDecision(device.id, 'block')"
                >
                  Block
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
                Review device commands from request to telemetry,
                verification, and settlement.
              </span>
            </div>

            <button class="primary" type="button" @click="loadState">
              Refresh executions
            </button>
          </div>

          <div
            v-if="!state?.executionTraces?.length"
            class="discovery-empty"
          >
            <strong>No executions yet</strong>
            <span>
              Run a device command to generate execution history.
            </span>
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
                    <span class="trust-pill approved">
                      {{ trace.outcome }}
                    </span>
                  </td>

                  <td>
                    {{ trace.durationMs || 0 }}ms
                  </td>

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


          <div
            v-if="selectedExecutionTrace"
            class="trace-modal-backdrop"
            @click="closeExecutionTrace"
          ></div>

          <aside
            v-if="selectedExecutionTrace"
            class="trace-modal"
          >
            <div class="device-sheet-head">
              <div>
                <span class="eyebrow">
                  Execution timeline
                </span>

                <h3>
                  {{ selectedExecutionTrace.action }}
                  ·
                  {{ selectedExecutionTrace.outcome }}
                </h3>

              </div>

              <button
                class="icon-button"
                type="button"
                @click="closeExecutionTrace"
              >
                ×
              </button>
            </div>

                        <div class="execution-summary">

              <div>
                <small>ACTOR</small>
                <strong>
                  {{ selectedExecutionTrace.actor?.name || selectedExecutionTrace.actor?.type || 'Unknown' }}
                </strong>
              </div>

              <div>
                <small>DEVICE</small>
                <strong>
                  {{ selectedExecutionTrace.deviceId }}
                </strong>
              </div>

              <div>
                <small>DURATION</small>
                <strong>
                  {{
                    selectedExecutionTrace.durationMs
                      ? (selectedExecutionTrace.durationMs / 1000).toFixed(3)+'s'
                      : 'running'
                  }}
                </strong>
              </div>

            </div>


            <ExecutionFlowVisualization
              :trace="selectedExecutionTrace"
            />

<ol class="execution-timeline">
              <li
                v-for="stage in selectedExecutionTrace.stages"
                :key="stage.stage"
                :class="[
                  'execution-stage-item',
                  `stage-${stage.status}`
                ]"
              >
                <div>
                  <strong>{{ stage.stage }}</strong>
                  <span>{{ stage.status }}</span>
                </div>

                <p>{{ stage.message }}</p>

                <small>{{ stage.observedAt }}</small>
              </li>
            </ol>

          </aside>


        <p v-if="stateError" class="error">{{ stateError }}</p>
      </section>
    </section>
  </main>
</template>
