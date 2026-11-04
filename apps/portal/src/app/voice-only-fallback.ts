import type { PortalState, PortalDevice } from '../portal-state';
export type VoiceConfig = {
  sttProvider: string;
  openaiBatchModel: string;
  localWhisperFallbackToOpenAI: boolean;
  localWhisperWorker?: boolean;
  localWhisperModel: string;
  localWhisperLanguage: string;
};


type PortalSystem = NonNullable<PortalState['systems']>[number];
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


/** Legacy Voice-only API compatibility. Never used for normal /portal/state responses. */
export function createVoiceOnlyState(config: VoiceConfig): PortalState {
  return {
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
