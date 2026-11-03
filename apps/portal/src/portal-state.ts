import type { DeviceControlState } from '@energrid/domain-devices';
import type { DiscoveryNetworkZone, NetworkDevice } from './features/discovery/discovery-contracts';
import type { MqttBusState } from './features/bus/mqtt-model';
import type { PendingIdentityInput } from './components/discovery/pending-enrollment';

export type PortalExecutionTrace = {
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

export type PortalState = {
  pendingDeviceIdentities?: Record<string, PendingIdentityInput>;
  executionTraces?: PortalExecutionTrace[];
  tenant: { id: string; name: string };
  site: { id: string; name: string; mode: string };
  sites?: Array<{
    id: string;
    name: string;
    mode?: string;
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
    supportedCapabilities?: Array<{ kind: string; actions: string[]; unit?: string }>;
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
      fieldObservedAt?: Record<string, string>;
      source: string;
      status: string;
      observerReachability?: string;
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
  networkZones?: DiscoveryNetworkZone[];
  networkDevices?: NetworkDevice[];
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

  bus?: { mqtt: MqttBusState };
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

export type PortalDevice = NonNullable<PortalState['devices']>[number];

export type NetworkSnapshot = {
  scanId: string; schemaVersion: number; startedAt: string; completedAt: string;
  ownership?: { tenantId: string; siteId: string };
  collector: { id: string; host: string; interfaces: string[] };
  scopes: Array<{ id: string; name: string; cidr?: string; interfaceName?: string; complete: boolean; gatewayIpsObserved: string[] }>;
  methods: string[]; successes: number; failures: string[]; limitations: string[]; endpoints: NetworkDevice[];
  endpointRecoveryProposals?: Array<{
    deviceId: string; displayName: string; physicalId: string; component: string; physicalInventoryId: string;
    endpoint: string; scopeId: string; scopeCidr: string; identityObservedAt: string | null; componentObservedAt: string | null;
    evidenceFresh: boolean; currentEndpoint: string | null; currentScope: string | null;
    observerStatus: 'authorized' | 'missing' | 'ambiguous' | 'invalid'; observerId: string | null;
    conflictEndpoints: string[]; status: 'verification_required' | 'observer_required' | 'observer_configuration_invalid' | 'conflict' | 'already_current' | 'inventory_conflict' | 'inventory_unavailable';
  }>;
  topology: { relationships: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }> };
  networkRoles?: Array<{ id: string; role: 'default_gateway'; label: 'Observed default gateway'; scopeId: string; scopeName: string; ipAddress: string; observedAt: string; observer: { id: string; host: string; interfaceName: string }; routeDestination: string; routeEvidence: string }>;
  runtime?: NetworkRuntime;
};

export type NetworkSnapshotDiff = {
  fromScanId: string; toScanId: string; comparableScopes: string[]; incompleteScopes: string[];
  addedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  notDetectedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  verifiedAddressChanges: Array<{ scopeId?: string; identity: string; from: string; to: string }>;
  ipReuse: Array<{ scopeId: string; ipAddress: string; previousIdentity?: string; currentIdentity?: string }>;
  serviceChanges: Array<{ scopeId: string; ipAddress: string; added: string[]; removed: string[] }>;
  scopeChanges: Array<{ scopeId: string; previousCidr?: string; currentCidr?: string; previousInterface?: string; currentInterface?: string }>;
  macChanges: Array<{ scopeId?: string; identity: string; previousObservedMac?: string; currentObservedMac?: string; previousDeviceReportedMac?: string; currentDeviceReportedMac?: string }>;
  hostnameChanges: Array<{ scopeId?: string; identity: string; previous: string; current: string }>;
  gatewayChanges: Array<{ scopeId: string; previous: string[]; current: string[] }>;
  identityChanges: Array<{ scopeId: string; ipAddress: string; previous: string; current: string }>;
  topologyChanges: { added: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }>; removed: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }> };
};

export type NmapCapability = { available: boolean; enabled: boolean; version?: string; reason?: string };

export type NetworkRuntime = {
  observedAt: string;
  observer: { id: string; host: string; platform: string };
  interfaces: Array<{ name: string; internal: boolean; macAddress?: string; addresses: Array<{ family: string; address: string; netmask?: string; prefixLength?: number; cidr?: string }> }>;
  routes: Array<{ destination: string; family: string; gateway?: string; interfaceName?: string; sourceAddress?: string; evidence: string }>;
  localScopes: Array<{ cidr: string; interfaceName: string }>;
  configuredScopes: Array<{ id: string; name: string; cidr?: string; interfaceName?: string; reachability: string; boundedScanEligible: boolean; reason: string }>;
  capabilities: Array<{ id: string; available: boolean; detail: string }>;
  limitations: string[];
};
