import { Inject, Injectable, Optional, OnModuleInit } from '@nestjs/common';
import {
  deviceControlState,
  parseDeviceControlBinding,
  type DeviceControlBinding,
} from '@energrid/domain-devices';
import type {
  DeviceCapabilityKind,
  DeviceExecutionTrace,
  DeviceExecutionTraceStage,
  DeviceProtocol,
  DeviceTransport,
  DeviceRegistrySnapshot,
  RegisteredDevice,
  RegisteredDeviceState,
  SiteSystem,
  ShellyRpcDeviceConfig,
} from './device-registry.types';
import { OperationalLogService } from './operational-log.service';
import { DeviceExecutionInvestigator } from './investigation/device-execution-investigator';
import { DeviceInstallationStore } from './device-installation.store';
import type { DeviceInstallationRecord } from './device-installation.store';
import type { DeviceEnrollmentStatus } from '@energrid/domain-devices';
import { DEVICE_ENROLLMENT_SERVICE } from './enrollment/device-enrollment.module';
import type { DeviceEnrollmentService } from './enrollment/device-enrollment.service';

export interface DiscoveredDeviceConfig {
  id?: string;
  displayName?: string;
  suggestedName?: string;
  tenantId?: string;
  siteId?: string;
  siteName?: string;
  gatewayId?: string;
  zoneId?: string;
  zoneName?: string;
  suggestedRoom?: string;
  protocol?: DeviceProtocol;
  transport?: DeviceTransport;
  driver?: string;
  target?: string;
  bridge?: string;
  capabilities?: DeviceCapabilityKind[];
  source?:
    | 'mqtt'
    | 'mdns'
    | 'http'
    | 'zigbee'
    | 'matter'
    | 'modbus'
    | 'manual'
    | 'simulated';
  confidence?: number;
  reason?: string;
  metadata?: Record<string, string | number | boolean>;
}

interface ApprovedDeviceConfig {
  id?: string;
  deviceId?: string;
  key?: string;
  displayName?: string;
  name?: string;
  tenantId?: string;
  siteId?: string;
  siteName?: string;
  gatewayId?: string;
  type?: string;
  kind?: 'logical' | 'physical';
  zoneId?: string;
  zoneName?: string;
  location?: string;
  origin?: string;
  physicalId?: string;
  dst?: string;
  channel?: number;
  channelName?: string;
  component?: string;
  hardwareId?: string;
  switchId?: number;
  model?: string;
  protocol?: DeviceProtocol;
  transport?: DeviceTransport;
  driver?: string;
  target?: string;
  bridge?: string;
  configured?: boolean;
  assistantEnabled?: boolean;
  settingsUrl?: string;
  status?: string;
  capabilities?: DeviceCapabilityKind[];
  groups?: string[];
  aliases?: string[];
  metadata?: Record<string, string | number | boolean>;
  values?: Record<string, number | boolean | string | null>;
  state?: {
    values?: Record<string, number | boolean | string | null>;
    observedAt?: string | null;
    source?: string;
    status?: string;
  };
  config?: {
    readings?: Record<string, { enabled?: boolean; unit?: string }>;
  };
  lastSeen?: string;
}

@Injectable()
export class DeviceRegistryService implements OnModuleInit {

  /**
   * Accepted observations projected from the durable Observation Engine.
   * This is a runtime projection, not the authoritative persistent store.
   */
  private readonly authoritativeObservationByDeviceId = new Map<
    string,
    {
      values: Record<string, number | boolean | string | null>;
      observedAt: string;
    }
  >();

  private readonly authoritativeFieldOwnershipByDeviceId =
    new Map<string, Set<string>>();

  private readonly controlBindings = new Map<
    string,
    DeviceControlBinding | null
  >();
  private readonly liveApprovedDeviceConfigs = new Map<
    string,
    ApprovedDeviceConfig
  >();
  private readonly liveDiscoveredDeviceConfigs = new Map<
    string,
    DiscoveredDeviceConfig
  >();
  private readonly blockedDiscoveredDeviceIds = new Set<string>();
  private readonly liveStateByDeviceId = new Map<
    string,
    RegisteredDeviceState
  >();
  private readonly commandByDeviceId = new Map<
    string,
    NonNullable<RegisteredDeviceState['command']> & {
      expiresAt: number;
      displayUntil: number;
    }
  >();

  private readonly executionInvestigator = new DeviceExecutionInvestigator();

  private readonly executionTraceByCommandId = new Map<
    string,
    DeviceExecutionTrace & {
      expiresAt: number;
      settlingUntil: number | null;
      lastVerifiedValues: Record<
        string,
        number | boolean | string | null
      > | null;
    }
  >();

  private readonly latestCommandIdByDeviceId = new Map<string, string>();
  private readonly persistedInstallations = new Map<string, DeviceInstallationRecord>();
  private readonly enrollmentStatusByDeviceId = new Map<string, DeviceEnrollmentStatus>();

  constructor(
    private readonly operationalLog?: OperationalLogService,
    @Optional() private readonly installationStore?: DeviceInstallationStore,
    @Optional()
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment?: DeviceEnrollmentService,
  ) {
    const configured: unknown = JSON.parse(
      process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON || '{}',
    );
    if (
      !configured ||
      typeof configured !== 'object' ||
      Array.isArray(configured)
    )
      throw new Error('HOME_DEVICE_CONTROL_BINDINGS_JSON must be an object.');
    for (const [id, binding] of Object.entries(configured))
      this.controlBindings.set(id, parseDeviceControlBinding(binding));
  }

  private installationsReady?: Promise<void>;

  async onModuleInit(): Promise<void> {
    await this.ensureInstallationsLoaded();
  }

  ensureInstallationsLoaded(): Promise<void> {
    if (!this.installationStore) return Promise.resolve();

    if (!this.installationsReady) {
      this.installationsReady = this.loadInstallations().catch((error) => {
        this.installationsReady = undefined;
        throw error;
      });
    }

    return this.installationsReady;
  }

  private async loadInstallations(): Promise<void> {
    const siteId = configuredSite().siteId;
    if (this.enrollment) {
      const { tenantId } = configuredSite();
      const enrollments = await this.enrollment.list({ tenantId, siteId });
      for (const enrollment of enrollments) {
        this.enrollmentStatusByDeviceId.set(enrollment.deviceId, enrollment.status);
      }
    }
    if (!this.installationStore) return;
    for (const record of await this.installationStore.list(siteId)) {
      const device = record.device;
      this.persistedInstallations.set(device.id, record);
      if (this.enrollment && this.enrollmentStatusByDeviceId.get(device.id) !== 'enrolled') {
        continue;
      }
      this.liveApprovedDeviceConfigs.set(device.id, {
        id: device.id,
        displayName: device.displayName,
        tenantId: device.tenantId,
        siteId: device.siteId,
        siteName: device.siteName,
        gatewayId: device.gatewayId,
        kind: device.kind,
        zoneId: device.zoneId,
        zoneName: device.zoneName,
        protocol: device.adapter.protocol,
        transport: device.adapter.transport,
        driver: device.adapter.driver,
        target: device.adapter.target,
        bridge: device.adapter.bridge,
        configured: device.adapter.configured,
        capabilities: device.capabilities.map((capability) => capability.kind),
        assistantEnabled: device.assistantEnabled === true,
        settingsUrl: device.settingsUrl,
        metadata: device.metadata,
        values: {},
        state: { values: {}, observedAt: null, source: 'device-store', status: 'unknown' },
      });
      if (device.control?.binding)
        this.controlBindings.set(device.id, parseDeviceControlBinding(device.control.binding));
    }
  }

  getSnapshot(): DeviceRegistrySnapshot {
    const allDevices = this.getDevices();
    const allSystems = this.getSystems(allDevices);
    const currentSiteId = configuredSite().siteId;
    const devices = allDevices.filter(
      (device) => device.siteId === currentSiteId,
    );
    const systems = this.getSystems(devices);
    const zones = this.getZones(devices, systems);

    return {
      tenant: {
        id: configuredSite().tenantId,
        name: process.env.PORTAL_TENANT_NAME || 'Energrid Demo',
      },
      site: {
        id: configuredSite().siteId,
        name: configuredSite().siteName,
      },
      sites: summarizeSites(allDevices, allSystems),
      gateways: summarizeGateways(allDevices),
      devices,
      systems,
      zones,
      summary: {
        total: devices.length,
        approved: devices.filter((device) => device.trustStatus === 'approved')
          .length,
        discovered: devices.filter(
          (device) => device.trustStatus === 'discovered',
        ).length,
        controllable: devices.filter(
          (device) =>
            device.control?.status === 'ready' &&
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
        learningEnabled: systems.filter((system) => system.learning.enabled)
          .length,
      },
    };
  }

  getDevices(): RegisteredDevice[] {
    const now = new Date().toISOString();
    const identity = configuredSite();
    const shellyDevices = this.getKitchenLightShellyDevices();
    const importedDevices = this.getApprovedDevicesFromConfig();
    const importedLogicalGroups =
      logicalGroupsFromImportedDevices(importedDevices);
    const hasShellyGroup = shellyDevices.length > 0;
    const hasGenericLightMqtt = !!process.env.HOME_KITCHEN_LIGHT_MQTT_TOPIC;
    const hasImportedKitchenLights = importedLogicalGroups.some(
      (device) => device.id === 'kitchen_light',
    );
    const hasImportedKitchenTemperature = importedDevices.some(
      (device) =>
        device.zoneId === 'kitchen' &&
        device.capabilities.some(
          (capability) => capability.kind === 'temperature',
        ),
    );

    const kitchenLightGroup: RegisteredDevice = {
      id: 'kitchen_light',
      ...identity,
      displayName: 'Kitchen lights',
      kind: 'logical',
      zoneId: 'kitchen',
      zoneName: 'Kitchen',
      trustStatus: 'approved',
      assistantEnabled: shellyDevices.length === 0
        ? true
        : shellyDevices.every((device) => assistantEnabledDeviceIds().has(device.key)),
      capabilities: [
        {
          kind: 'light',
          actions: ['turn_on', 'turn_off'],
        },
      ],
      adapter: {
        id: hasShellyGroup
          ? 'shelly-rpc-group'
          : hasGenericLightMqtt
            ? 'generic-mqtt'
            : 'simulated',
        protocol: hasShellyGroup || hasGenericLightMqtt ? 'mqtt' : 'simulated',
        transport: hasShellyGroup || hasGenericLightMqtt ? 'mqtt' : 'local',
        driver: hasShellyGroup
          ? 'shelly-rpc'
          : hasGenericLightMqtt
            ? 'generic-mqtt-switch'
            : 'simulated-switch',
        configured: hasShellyGroup || hasGenericLightMqtt,
        target: hasShellyGroup
          ? process.env.HOME_SHELLY_RPC_TOPIC || 'shelly/rpc'
          : process.env.HOME_KITCHEN_LIGHT_MQTT_TOPIC || undefined,
        eventTopicPrefix: mqttPrefixFor(identity),
        commandTopic: mqttTopicFor(identity, 'kitchen_light', 'command'),
        stateTopic: mqttTopicFor(identity, 'kitchen_light', 'state'),
      },
      state: unknownState('configured by adapter'),
      responseProfile: responseProfile({
        latencyMs: 600,
        notes: 'Logical light group fans out to physical adapters.',
      }),
      policy: safePolicy(),
      memberDeviceIds: shellyDevices.map((device) => device.key),
    };

    const physicalLights = shellyDevices.map<RegisteredDevice>((device) => ({
      id: device.key,
      ...identity,
      displayName: displayNameFromDeviceKey(device.key),
      kind: 'physical',
      zoneId: 'kitchen',
      zoneName: 'Kitchen',
      trustStatus: 'approved',
      assistantEnabled: assistantEnabledDeviceIds().has(device.key),
      capabilities: [
        {
          kind: 'switch',
          actions: ['turn_on', 'turn_off'],
        },
      ],
      adapter: {
        id: 'shelly-rpc',
        protocol: 'mqtt',
        transport: 'mqtt',
        driver: 'shelly-rpc',
        configured: true,
        target: device.dst,
        eventTopicPrefix: mqttPrefixFor(identity),
        commandTopic: mqttTopicFor(identity, device.key, 'command'),
        stateTopic: mqttTopicFor(identity, device.key, 'state'),
        statusTopic: mqttTopicFor(identity, device.key, 'status'),
      },
      state: unknownState('shelly-rpc'),
      responseProfile: responseProfile({
        latencyMs: 500,
        notes:
          'Shelly local RPC should be fast even when vendor cloud is unavailable.',
      }),
      policy: safePolicy(),
      metadata: {
        dst: device.dst,
        switchId: device.switchId,
        physicalId: device.dst,
        channel: device.switchId,
        component: `switch:${device.switchId}`,
      },
    }));

    const kitchenTemp = this.getKitchenTemperatureFromEnv();
    const tempHasMqtt = !!process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC;
    const tempHasHttp = !!process.env.HOME_KITCHEN_TEMP_URL;

    const temperatureDevice: RegisteredDevice = {
      id: 'kitchen_temperature',
      ...identity,
      displayName: 'Kitchen temperature',
      kind: 'physical',
      zoneId: 'kitchen',
      zoneName: 'Kitchen',
      trustStatus: 'approved',
      capabilities: [
        {
          kind: 'temperature',
          actions: ['read'],
          unit: 'C',
        },
      ],
      adapter: {
        id: tempHasMqtt
          ? 'mqtt-sensor'
          : tempHasHttp
            ? 'http-sensor'
            : 'simulated',
        protocol: tempHasMqtt ? 'mqtt' : tempHasHttp ? 'http' : 'simulated',
        transport: tempHasHttp ? 'http' : tempHasMqtt ? 'mqtt' : 'local',
        driver: tempHasMqtt
          ? 'mqtt-json-sensor'
          : tempHasHttp
            ? 'http-json-sensor'
            : 'simulated-sensor',
        configured: tempHasMqtt || tempHasHttp || kitchenTemp != null,
        target:
          process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC ||
          process.env.HOME_KITCHEN_TEMP_URL,
        eventTopicPrefix: mqttPrefixFor(identity),
        stateTopic: mqttTopicFor(identity, 'kitchen_temperature', 'state'),
        telemetryTopic: mqttTopicFor(
          identity,
          'kitchen_temperature',
          'telemetry',
        ),
        statusTopic: mqttTopicFor(identity, 'kitchen_temperature', 'status'),
      },
      state: {
        values: {
          temperature: kitchenTemp,
        },
        observedAt: kitchenTemp == null ? null : now,
        source: process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC
          ? 'mqtt'
          : process.env.HOME_KITCHEN_TEMP_URL
            ? 'http'
            : process.env.PORTAL_KITCHEN_TEMP_SOURCE || 'simulated',
        status: kitchenTemp == null ? 'unknown' : 'online',
      },
      responseProfile: responseProfile({
        latencyMs: 1000,
        notes:
          'Read-only temperature signal used by the assistant and future climate systems.',
      }),
      policy: readOnlyPolicy(),
    };

    const devices = dedupeDevices([
      ...importedLogicalGroups,
      ...(hasShellyGroup || hasGenericLightMqtt || !hasImportedKitchenLights
        ? [kitchenLightGroup]
        : []),
      ...physicalLights,
      ...(hasImportedKitchenTemperature ? [] : [temperatureDevice]),
      ...importedDevices,
      ...this.getDiscoveredDevices(),
    ]);

    const result = devices.map((device) => ({
      ...this.withLiveState(device),
      ...(this.persistedInstallations.has(device.id)
        ? {
            commissioning: {
              physicalOutcome: this.persistedInstallations.get(device.id)!.physicalOutcome.status,
              confirmedAt: this.persistedInstallations.get(device.id)!.physicalOutcome.confirmedAt,
            },
          }
        : {}),
      control: deviceControlState(
        device,
        this.controlBindings.get(device.id) || null,
      ),
    }));
    const groupState = (
      device: RegisteredDevice,
      seen = new Set<string>(),
    ): boolean => {
      if (seen.has(device.id) || device.trustStatus !== 'approved')
        return false;
      if (
        !device.capabilities.some(
          (c) =>
            c.actions.includes('turn_on') && c.actions.includes('turn_off'),
        )
      )
        return false;
      if (!device.memberDeviceIds?.length)
        return (
          device.adapter.protocol === 'simulated' ||
          device.control?.status === 'ready'
        );
      const next = new Set(seen).add(device.id);
      return device.memberDeviceIds.every((id) => {
        const member = result.find((item) => item.id === id);
        return !!member && groupState(member, next);
      });
    };
    for (const device of result) {
      if (device.memberDeviceIds?.length)
        device.control = {
          status: groupState(device) ? 'ready' : 'needs-setup',
          binding: null,
          reason: "Group control uses every member's explicit route.",
        };
      else if (
        device.adapter.protocol === 'simulated' &&
        device.trustStatus === 'approved' &&
        device.control.status !== 'read-only'
      )
        device.control = {
          status: 'ready',
          binding: null,
          reason: 'Simulation only.',
        };
    }
    return result;
  }

  configureDeviceControl(deviceId: string, value: unknown): RegisteredDevice {
    const device = this.getDevices().find((item) => item.id === deviceId);
    if (!device || device.trustStatus !== 'approved')
      throw new Error('Approve this device before configuring control.');
    if (
      device.tenantId !== configuredSite().tenantId ||
      device.siteId !== configuredSite().siteId
    )
      throw new Error('Control configuration is limited to this site.');
    if (
      device.memberDeviceIds?.length ||
      device.adapter.protocol === 'simulated'
    )
      throw new Error('Configure the physical member routes instead.');
    const binding = parseDeviceControlBinding(value);
    const state = deviceControlState(device, binding);
    if (binding && !['ready', 'disabled'].includes(state.status))
      throw new Error(state.reason);
    this.controlBindings.set(deviceId, binding);
    this.operationalLog?.record({
      level: 'info',
      source: 'device-registry',
      event: 'device.control_configured',
      deviceId,
      message: `Control route ${binding ? binding.kind : 'removed'}; switching ${binding?.enabled ? 'enabled' : 'disabled'}.`,
    });
    return this.getDevices().find((item) => item.id === deviceId)!;
  }

  async persistInstallation(
    device: RegisteredDevice,
    initialApproval = false,
  ): Promise<void> {
    if (!this.installationStore)
      throw new Error('Local device storage is unavailable.');
    const existing = this.persistedInstallations.get(device.id);
    const record: DeviceInstallationRecord = {
      schemaVersion: 1,
      device,
      ...(existing?.observationAuthority
        ? { observationAuthority: existing.observationAuthority }
        : {}),
      physicalOutcome: existing?.physicalOutcome || {
        status: 'not_confirmed',
        confirmedAt: null,
        confirmedBy: null,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.installationStore.save(record);
    this.persistedInstallations.set(device.id, record);
    if (initialApproval)
      await this.persistInstallationEvent(device.id, 'approved', {
        physicalId: String(device.metadata?.physicalId || device.adapter.target || ''),
      });
  }

  async persistInstallationEvent(
    deviceId: string,
    kind: 'approved' | 'control_configured' | 'installation_details_saved' | 'command' | 'physical_outcome_confirmed',
    evidence: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    if (!this.installationStore)
      throw new Error('Local device storage is unavailable.');
    await this.installationStore.append({
      id: `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 10)}`,
      deviceId,
      kind,
      occurredAt: new Date().toISOString(),
      actor: 'portal-installer',
      evidence,
    });
  }

  async confirmPhysicalOutcome(deviceId: string): Promise<RegisteredDevice> {
    const existing = this.persistedInstallations.get(deviceId);
    if (!existing) throw new Error('Persist this device installation before confirmation.');
    const current = this.getDevices().find((device) => device.id === deviceId);
    if (current?.state.command?.status !== 'acked')
      throw new Error('Run a device test and wait for matching reported state before confirming the physical result.');
    const confirmedAt = new Date().toISOString();
    const updated: DeviceInstallationRecord = {
      ...existing,
      physicalOutcome: {
        status: 'confirmed',
        confirmedAt,
        confirmedBy: 'portal-installer',
      },
      updatedAt: confirmedAt,
    };
    await this.installationStore!.save(updated);
    this.persistedInstallations.set(deviceId, updated);
    await this.persistInstallationEvent(deviceId, 'physical_outcome_confirmed', {
      confirmedAt,
    });
    return this.getDevices().find((device) => device.id === deviceId)!;
  }

  async updateInstallationDetails(
    deviceId: string,
    displayName: string,
    zoneName: string,
    assistantEnabled?: boolean,
    settingsUrl?: string | null,
    loadType?: 'lighting' | null,
  ): Promise<RegisteredDevice> {
    const device = this.getDevices().find((item) => item.id === deviceId);
    if (!device || device.trustStatus !== 'approved')
      throw new Error('Approve this device before editing its installation details.');
    if (settingsUrl != null && !safeSettingsUrl(settingsUrl))
      throw new Error('Device settings must be an absolute HTTP or HTTPS URL without embedded credentials.');
    const config = this.liveApprovedDeviceConfigs.get(deviceId) || {
      id: device.id,
      tenantId: device.tenantId,
      siteId: device.siteId,
      siteName: device.siteName,
      gatewayId: device.gatewayId,
      kind: device.kind,
      protocol: device.adapter.protocol,
      transport: device.adapter.transport,
      driver: device.adapter.driver,
      target: device.adapter.target,
      bridge: device.adapter.bridge,
      capabilities: device.capabilities.map((capability) => capability.kind),
      assistantEnabled: device.assistantEnabled === true,
      settingsUrl: device.settingsUrl,
      metadata: device.metadata,
    };
    const zoneId = zoneName.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'unassigned';
    const metadata = { ...(config.metadata || {}) };
    if (loadType === null) delete metadata.loadType;
    else if (loadType !== undefined) metadata.loadType = loadType;

    const nextConfig = {
      ...config,
      metadata,
      displayName,
      zoneName,
      zoneId,
      assistantEnabled: assistantEnabled ?? device.assistantEnabled === true,
      settingsUrl: settingsUrl === undefined
        ? device.settingsUrl
        : settingsUrl ? safeSettingsUrl(settingsUrl) : undefined,
    };
    this.liveApprovedDeviceConfigs.set(deviceId, nextConfig);
    const updated = this.getDevices().find((item) => item.id === deviceId)!;
    try {
      await this.persistInstallation(updated);
      return updated;
    } catch (error) {
      this.liveApprovedDeviceConfigs.set(deviceId, config);
      throw error;
    }
  }

  getInstallationEvents(deviceId: string) {
    return this.installationStore?.events(deviceId) || Promise.resolve([]);
  }

  getAvailableDeviceIds(): string[] {
    const devices = this.getDevices();
    const byId = new Map(devices.map((device) => [device.id, device]));
    return devices
      .filter((device) => device.trustStatus === 'approved')
      .filter((device) =>
        canAssistantUseDevice(device, byId),
      )
      .filter(
        (device) =>
          !device.capabilities.some((c) => c.actions.includes('turn_on')) ||
          device.control?.status === 'ready',
      )
      .filter(
        (device) =>
          device.adapter.configured || device.adapter.protocol === 'simulated',
      )
      .map((device) => device.id);
  }

  approveDiscoveredDevice(deviceId: string): RegisteredDevice | null {
    const id = safeId(deviceId);
    if (!id) return null;

    const discovered = this.getDevices().find(
      (device) => device.id === id && device.trustStatus === 'discovered',
    );
    if (!discovered) return null;

    const capabilities = discovered.capabilities.map(
      (capability) => capability.kind,
    );
    const approved: ApprovedDeviceConfig = {
      id: discovered.id,
      displayName:
        discovered.discovery?.suggestedName || discovered.displayName,
      tenantId: discovered.tenantId,
      siteId: discovered.siteId,
      siteName: discovered.siteName,
      gatewayId: discovered.gatewayId,
      kind: discovered.kind,
      zoneId: discovered.zoneId,
      zoneName: discovered.discovery?.suggestedRoom || discovered.zoneName,
      protocol: discovered.adapter.protocol,
      transport: discovered.adapter.transport,
      driver: discovered.adapter.driver,
      target: discovered.adapter.target,
      bridge: discovered.adapter.bridge,
      configured:
        discovered.adapter.protocol !== 'none' &&
        discovered.metadata?.mqttEvidenceCandidate !== true,
      capabilities,
      values: discovered.state.values,
      state: {
        values: discovered.state.values,
        observedAt: discovered.state.observedAt,
        source: discovered.state.source,
        status: discovered.state.status,
      },
      metadata: cleanMetadata({
        ...discovered.metadata,
        approvedFromDiscovery: true,
        discoverySource: discovered.discovery?.source,
        discoveryConfidence: discovered.discovery?.confidence,
      }),
    };

    this.liveApprovedDeviceConfigs.set(id, approved);
    this.liveDiscoveredDeviceConfigs.delete(id);
    this.blockedDiscoveredDeviceIds.delete(id);
    this.operationalLog?.record({
      level: 'info',
      source: 'device-registry',
      event: 'discovery.approved',
      message: `${discovered.displayName} was approved; control requires a separate route and permission.`,
      deviceId: id,
      status: 'approved',
      details: {
        protocol: discovered.adapter.protocol,
        driver: discovered.adapter.driver,
      },
    });

    return (
      this.getDevices().find(
        (device) => device.id === id && device.trustStatus === 'approved',
      ) || null
    );
  }

  blockDiscoveredDevice(deviceId: string): boolean {
    const id = safeId(deviceId);
    if (!id) return false;

    const discovered = this.getDevices().find(
      (device) => device.id === id && device.trustStatus === 'discovered',
    );
    if (!discovered) return false;

    this.blockedDiscoveredDeviceIds.add(id);
    this.liveDiscoveredDeviceConfigs.delete(id);
    this.operationalLog?.record({
      level: 'info',
      source: 'device-registry',
      event: 'discovery.blocked',
      message: `${discovered.displayName} was blocked from onboarding.`,
      deviceId: id,
      status: 'blocked',
    });

    return true;
  }

  registerDiscoveredShellyDevice(
    physicalId: string,
    component: string,
    channel: number | null,
    commandTopic?: string,
  ): void {
    const id = `${physicalId}:${component}`;
    const capability: DeviceCapabilityKind = component.startsWith('switch:')
      ? 'switch'
      : 'power';

    const existing = this.liveDiscoveredDeviceConfigs.get(id);
    if (
      existing &&
      (!commandTopic || existing.metadata?.mqttCommandTopic === commandTopic)
    )
      return;

    this.liveDiscoveredDeviceConfigs.set(id, {
      id,
      displayName: `${physicalId} ${component}`,
      suggestedName: `${physicalId} ${component}`,
      suggestedRoom: 'Unknown',
      protocol: 'mqtt',
      transport: 'mqtt',
      driver: 'shelly-discovered',
      target: physicalId,
      capabilities: [capability],
      source: 'mqtt',
      confidence: 0.8,
      reason: 'Discovered from Shelly MQTT telemetry',
      metadata: cleanMetadata({
        ...existing?.metadata,
        physicalId,
        component,
        channel: channel ?? undefined,
        mqttCommandTopic: commandTopic,
      }),
    });

    this.operationalLog?.record({
      level: 'info',
      source: 'device-registry',
      event: 'device.discovered',
      deviceId: id,
      message: `Discovered Shelly device ${physicalId} component ${component} channel ${channel ?? '-'}.`,
    });
  }

  registerDiscoveredDevice(config: DiscoveredDeviceConfig): boolean {
    const id = safeId(config.id);

    if (!id) {
      return false;
    }

    if (this.liveApprovedDeviceConfigs.has(id) && !this.isEnrollmentRetired(id)) {
      return false;
    }

    const retired = this.isEnrollmentRetired(id);
    if (retired) this.liveApprovedDeviceConfigs.delete(id);
    const metadata = cleanMetadata({
      ...this.liveDiscoveredDeviceConfigs.get(id)?.metadata,
      ...config.metadata,
      ...(retired ? { previouslyEnrolledRetired: true } : {}),
    });

    this.liveDiscoveredDeviceConfigs.set(id, {
      ...config,
      ...(retired ? {
        reason: 'Previously enrolled device is retired. Explicit approval is required to reenroll.',
      } : {}),
      metadata,
      confidence: config.confidence ?? 0.5,
      reason: config.reason || 'Discovered device awaiting approval.',
    });
    return true;
  }

  getKitchenLightShellyDevices(): ShellyRpcDeviceConfig[] {
    const configured = parseShellyRpcDevices(
      process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES,
    );

    if (configured.length > 0) {
      return configured;
    }

    if (process.env.HOME_USE_DEMO_SHELLY !== 'true') {
      return [];
    }

    return [
      {
        key: 'kitchen-shelly',
        dst: 'shellyplus1-78ee4ccf4b54',
        switchId: 0,
      },
    ];
  }

  private getKitchenTemperatureFromEnv(): number | null {
    const configured = Number(
      process.env.PORTAL_KITCHEN_TEMP_C ||
        process.env.HOME_FAKE_INSIDE_TEMP_C ||
        22.4,
    );

    return Number.isFinite(configured) ? configured : null;
  }

  private getSystems(devices: RegisteredDevice[]): SiteSystem[] {
    const now = new Date().toISOString();
    const systems: SiteSystem[] = [
      {
        id: 'kitchen_lighting',
        ...configuredSite(),
        displayName: 'Kitchen lighting',
        kind: 'lighting',
        zoneId: 'kitchen',
        zoneName: 'Kitchen',
        deviceIds: ['kitchen_light'],
        capabilities: [
          {
            kind: 'light',
            actions: ['turn_on', 'turn_off'],
            description:
              'Group lighting controlled locally through approved adapters.',
          },
        ],
        responseProfile: responseProfile({
          latencyMs: 700,
          notes: 'Fast control path; prefer local network over vendor cloud.',
        }),
        policy: safePolicy(),
        learning: {
          enabled: true,
          objective:
            'Learn occupancy and daylight patterns before proposing scenes.',
          signals: [
            'voice commands',
            'time of day',
            'outside darkness',
            'manual overrides',
          ],
          currentConfidence: 0.25,
        },
        state: unknownState('registry'),
      },
      {
        id: 'floor_heating',
        ...configuredSite(),
        displayName: 'Floor heating loop',
        kind: 'slow_radiant_heating',
        zoneId: 'home',
        zoneName: 'Whole home',
        deviceIds: [],
        capabilities: [
          {
            kind: 'slow_radiant_zone',
            actions: ['read', 'set_target_temperature'],
            unit: 'C',
            description:
              'Slow thermal mass heating with delayed room response.',
          },
        ],
        responseProfile: responseProfile({
          thermalLagMinutes: numberFromEnv(
            'HOME_FLOOR_HEATING_LAG_MINUTES',
            210,
          ),
          minCycleMinutes: 30,
          confidence: 0.2,
          notes:
            'Learns slab delay, spacing behavior, forecast error, and comfort outcome.',
        }),
        policy: climatePolicy(16, 28),
        learning: {
          enabled: true,
          objective:
            'Predict when to start radiant heat using forecast, tariffs, room history, and thermal lag.',
          signals: [
            'inside temperature',
            'outside forecast',
            'floor loop runtime',
            'target comfort',
            'manual corrections',
          ],
          currentConfidence: 0.2,
        },
        state: {
          values: {
            mode: 'learning',
            thermalLagMinutes: numberFromEnv(
              'HOME_FLOOR_HEATING_LAG_MINUTES',
              210,
            ),
          },
          observedAt: now,
          source: 'planned-system',
          status: 'unknown',
        },
      },
      {
        id: 'fan_coils',
        ...configuredSite(),
        displayName: 'Fan coil units',
        kind: 'fast_air_climate',
        zoneId: 'home',
        zoneName: 'Whole home',
        deviceIds: [],
        capabilities: [
          {
            kind: 'fast_air_zone',
            actions: ['read', 'set_target_temperature', 'set_mode'],
            unit: 'C',
            description: 'Fast correction layer for comfort changes.',
          },
        ],
        responseProfile: responseProfile({
          latencyMs: 2000,
          thermalLagMinutes: 10,
          confidence: 0.2,
          notes: 'Learns fast response compared with floor heating.',
        }),
        policy: climatePolicy(16, 30),
        learning: {
          enabled: true,
          objective:
            'Use fast air only when radiant heating cannot meet comfort in time.',
          signals: [
            'room temperature',
            'fan speed',
            'comfort correction commands',
          ],
          currentConfidence: 0.2,
        },
        state: unknownState('planned-system'),
      },
      {
        id: 'refrigerator_inventory',
        ...configuredSite(),
        displayName: 'Refrigerator inventory',
        kind: 'refrigerator_inventory',
        zoneId: 'kitchen',
        zoneName: 'Kitchen',
        deviceIds: [],
        capabilities: [
          {
            kind: 'camera',
            actions: ['capture'],
            description: 'Retrofit refrigerator camera snapshots.',
          },
          {
            kind: 'inventory',
            actions: ['read', 'analyze'],
            description: 'Vision model estimates groceries like eggs and milk.',
          },
        ],
        responseProfile: responseProfile({
          latencyMs: 3500,
          confidence: 0.1,
          notes:
            'Vision inventory must report confidence and avoid pretending certainty.',
        }),
        policy: readOnlyPolicy(),
        learning: {
          enabled: true,
          objective:
            'Learn household inventory patterns and reduce repeated manual checks.',
          signals: [
            'camera snapshots',
            'vision confidence',
            'user corrections',
          ],
          currentConfidence: 0.1,
        },
        state: unknownState('planned-system'),
      },
      {
        id: 'forecast_optimizer',
        ...configuredSite(),
        displayName: 'Forecast optimizer',
        kind: 'forecast_optimizer',
        zoneId: 'home',
        zoneName: 'Whole home',
        deviceIds: devices
          .filter((device) =>
            device.capabilities.some(
              (capability) => capability.kind === 'temperature',
            ),
          )
          .map((device) => device.id),
        capabilities: [
          {
            kind: 'forecast',
            actions: ['read', 'analyze'],
            description: 'Compares weather forecasts with local site response.',
          },
          {
            kind: 'tariff',
            actions: ['read'],
            description:
              'Optional electricity tariff signal for preheating decisions.',
          },
        ],
        responseProfile: responseProfile({
          confidence: 0.15,
          notes:
            'Gets better only after enough forecast vs actual history exists.',
        }),
        policy: readOnlyPolicy(),
        learning: {
          enabled: true,
          objective:
            'Improve preheat and comfort decisions from forecast error and building inertia.',
          signals: [
            'weather forecast',
            'actual outside temperature',
            'inside temperature',
            'energy use',
          ],
          currentConfidence: 0.15,
        },
        state: unknownState('planned-system'),
      },
    ];

    return systems;
  }

  private getZones(
    devices: RegisteredDevice[],
    systems: SiteSystem[],
  ): DeviceRegistrySnapshot['zones'] {
    const byZone = new Map<
      string,
      { id: string; name: string; deviceIds: string[]; systemIds: string[] }
    >();

    for (const device of devices) {
      const zone = byZone.get(device.zoneId) || {
        id: device.zoneId,
        name: device.zoneName,
        deviceIds: [],
        systemIds: [],
      };
      zone.deviceIds.push(device.id);
      byZone.set(device.zoneId, zone);
    }

    for (const system of systems) {
      const zoneId = system.zoneId || 'site';
      const zone = byZone.get(zoneId) || {
        id: zoneId,
        name: system.zoneName || 'Site',
        deviceIds: [],
        systemIds: [],
      };
      zone.systemIds.push(system.id);
      byZone.set(zoneId, zone);
    }

    return [...byZone.values()];
  }

  private getDiscoveredDevices(): RegisteredDevice[] {
    return [
      ...parseDiscoveredDevices(process.env.HOME_DISCOVERED_DEVICES_JSON),
      ...parseDiscoveredDevices([...this.liveDiscoveredDeviceConfigs.values()]),
    ].filter(
      (device) =>
        !this.liveApprovedDeviceConfigs.has(device.id) &&
        !this.blockedDiscoveredDeviceIds.has(device.id),
    );
  }

  private getApprovedDevicesFromConfig(): RegisteredDevice[] {
    return [
      ...parseApprovedDevices(
        process.env.HOME_APPROVED_DEVICES_JSON ||
          process.env.HOME_DEVICE_REGISTRY_JSON ||
          process.env.DEVICE_REGISTRY_JSON,
      ).filter(device => !this.isEnrollmentInactive(device.id)),
      ...parseApprovedDevices([...this.liveApprovedDeviceConfigs.values()])
        .filter(device => !this.isEnrollmentInactive(device.id)),
    ];
  }

  setEnrollmentStatus(deviceId: string, status: DeviceEnrollmentStatus): void {
    const id = safeId(deviceId);
    if (!id) return;
    this.enrollmentStatusByDeviceId.set(id, status);
    if (status !== 'enrolled') {
      this.liveApprovedDeviceConfigs.delete(id);
      return;
    }

    const record = this.persistedInstallations.get(id);
    if (!record) return;
    const device = record.device;
    this.liveApprovedDeviceConfigs.set(id, {
      id: device.id,
      displayName: device.displayName,
      tenantId: device.tenantId,
      siteId: device.siteId,
      siteName: device.siteName,
      gatewayId: device.gatewayId,
      kind: device.kind,
      zoneId: device.zoneId,
      zoneName: device.zoneName,
      protocol: device.adapter.protocol,
      transport: device.adapter.transport,
      driver: device.adapter.driver,
      target: device.adapter.target,
      bridge: device.adapter.bridge,
      configured: device.adapter.configured,
      capabilities: device.capabilities.map(capability => capability.kind),
      assistantEnabled: device.assistantEnabled === true,
      settingsUrl: device.settingsUrl,
      metadata: cleanMetadata(Object.fromEntries(
        Object.entries(device.metadata || {}).filter(([key]) => key !== 'previouslyEnrolledRetired'),
      )),
      values: {},
      state: { values: {}, observedAt: null, source: 'device-store', status: 'unknown' },
    });
    this.liveDiscoveredDeviceConfigs.delete(id);
  }

  isEnrollmentRetired(deviceId: string): boolean {
    return this.enrollmentStatusByDeviceId.get(deviceId) === 'retired';
  }

  private isEnrollmentInactive(deviceId: string): boolean {
    const status = this.enrollmentStatusByDeviceId.get(deviceId);
    return status !== undefined && status !== 'enrolled';
  }

  ingestRegistryPayload(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;

    const raw = payload as {
      tenantId?: string;
      siteId?: string;
      siteName?: string;
      gatewayId?: string;
      devices?: unknown[];
      observedAt?: string;
    };
    if (!Array.isArray(raw.devices)) return;

    for (const item of raw.devices) {
      if (!item || typeof item !== 'object') continue;

      const device = item as ApprovedDeviceConfig;
      const id = safeId(device.id || device.deviceId || device.key);
      if (!id) continue;

      this.liveApprovedDeviceConfigs.set(id, {
        ...device,
        tenantId: device.tenantId || raw.tenantId,
        siteId: device.siteId || raw.siteId,
        siteName: device.siteName || raw.siteName,
        gatewayId: device.gatewayId || raw.gatewayId,
        state: {
          values: device.state?.values || device.values || {},
          observedAt:
            device.state?.observedAt ??
            device.lastSeen ??
            raw.observedAt ??
            null,
          source:
            device.state?.source ||
            device.origin ||
            device.protocol ||
            'mqtt-registry',
          status: device.state?.status || device.status || 'online',
        },
      });
      this.liveDiscoveredDeviceConfigs.delete(id);
    }
  }

  findApprovedDeviceIdByPhysicalChannel(
    physicalId: string,
    component: string | null | undefined,
    channel: number | null = 0,
  ): string | null {
    const normalizedPhysicalId = physicalId.trim().toLowerCase();
    if (!normalizedPhysicalId) return null;

    const normalizedComponent = component?.trim().toLowerCase() || null;

    const matchingDevice = this.getDevices().find((device) => {
      if (device.trustStatus !== 'approved') return false;
      if (device.kind !== 'physical') return false;

      const identifiers = [
        device.adapter.target,
        metadataString(device.metadata, 'physicalId'),
        metadataString(device.metadata, 'hardwareId'),
        metadataString(device.metadata, 'dst'),
      ]
        .filter((value): value is string => !!value)
        .map((value) => value.trim().toLowerCase());

      if (!identifiers.includes(normalizedPhysicalId)) return false;

      const configuredComponent =
        metadataString(device.metadata, 'component')?.trim().toLowerCase() ||
        null;

      const configuredChannel =
        metadataNumber(device.metadata, 'switchId') ??
        metadataNumber(device.metadata, 'channel');

      if (
        configuredComponent &&
        normalizedComponent &&
        configuredComponent !== normalizedComponent
      ) {
        return false;
      }

      if (configuredChannel == null) {
        return channel == null || channel === 0;
      }

      return configuredChannel === channel;
    });

    return matchingDevice?.id || null;
  }

  /**
   * Project an already-authorized and durably accepted observation.
   *
   * Callers must verify the approved installation and persist through
   * the Observation Engine before invoking this method.
   *
   * Never expose this method directly to untrusted MQTT payloads.
   */
  /**
   * Claim fields from verified, trusted observation configuration.
   * Does not create readings or change connectivity.
   */
  claimApprovedObservationFields(
    deviceId: string,
    fields: readonly string[],
  ): void {
    const id = safeId(deviceId);
    if (!id) return;

    const owned =
      this.authoritativeFieldOwnershipByDeviceId.get(id) ??
      new Set<string>();

    for (const field of fields) {
      if (typeof field === 'string' && field.trim()) {
        owned.add(field);
      }
    }

    if (owned.size) {
      this.authoritativeFieldOwnershipByDeviceId.set(id, owned);
    }
  }

  /**
   * Restore historical state without claiming device connectivity
   * or triggering command reconciliation.
   */
  restoreApprovedObservation(payload: {
    deviceId: string;
    values: Record<string, number | boolean | string | null>;
    observedAt: string;
  }): void {
    const id = safeId(payload.deviceId);
    if (!id || !Object.keys(payload.values).length) return;

    const previous =
      this.authoritativeObservationByDeviceId.get(id);

    const values = {
      ...(previous?.values || {}),
      ...payload.values,
    };

    const observedAt =
      previous &&
      Date.parse(previous.observedAt) > Date.parse(payload.observedAt)
        ? previous.observedAt
        : payload.observedAt;

    this.authoritativeObservationByDeviceId.set(id, {
      values,
      observedAt,
    });

    const live = this.liveStateByDeviceId.get(id);

    this.liveStateByDeviceId.set(id, {
      values: {
        ...(live?.values || {}),
        ...values,
      },
      observedAt,
      source: 'approved-observation',
      status: live?.status || 'unknown',
    });
  }

  projectApprovedObservation(payload: {
    deviceId: string;
    values: Record<string, number | boolean | string | null>;
    observedAt: string;
  }): void {
    const id = safeId(payload.deviceId);
    if (!id) return;

    this.claimApprovedObservationFields(
      id,
      Object.keys(payload.values),
    );

    const previous = this.authoritativeObservationByDeviceId.get(id);
    const values = {
      ...(previous?.values || {}),
      ...payload.values,
    };

    this.authoritativeObservationByDeviceId.set(id, {
      values,
      observedAt: payload.observedAt,
    });

    const live = this.liveStateByDeviceId.get(id);

    this.liveStateByDeviceId.set(id, {
      values: {
        ...(live?.values || {}),
        ...values,
      },
      observedAt: payload.observedAt,
      source: 'approved-observation',
      status: live?.status || 'unknown',
    });

    this.observeCommandTelemetry(
      id,
      payload.values,
      payload.observedAt,
      null,
    );
  }

  ingestDeviceTelemetry(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;

    const raw = payload as ApprovedDeviceConfig & {
      deviceId?: string;
      observedAt?: string;
      evidence?: {
        commandId?: string | null;
        action?: string | null;
        expectedValues?: Record<
          string,
          number | boolean | string | null
        > | null;
        reason?: string;
      };
    };
    const id = safeId(raw.id || raw.deviceId || raw.key);
    if (!id) return;

    const incomingValues = raw.state?.values || raw.values || {};

    const owned =
      this.authoritativeFieldOwnershipByDeviceId.get(id);

    const authoritative =
      this.authoritativeObservationByDeviceId.get(id);

    const keepUnowned = (
      input: Record<string, number | boolean | string | null>,
    ) =>
      owned
        ? Object.fromEntries(
            Object.entries(input).filter(
              ([field]) => !owned.has(field),
            ),
          )
        : input;

    const unownedValues = keepUnowned(incomingValues);

    const values = owned
      ? {
          ...keepUnowned(
            this.liveStateByDeviceId.get(id)?.values || {},
          ),
          ...unownedValues,
          ...(authoritative?.values || {}),
        }
      : incomingValues;

    const observedAt =
      raw.observedAt || raw.state?.observedAt || new Date().toISOString();

    this.liveStateByDeviceId.set(id, {
      values,
      observedAt: authoritative?.observedAt || observedAt,
      source: authoritative
        ? 'approved-observation'
        : raw.state?.source || raw.origin || raw.protocol || 'mqtt-telemetry',
      status: normalizeOnlineStatus(
        raw.state?.status || raw.status || 'online',
      ),
    });
    this.observeCommandTelemetry(
      id,
      unownedValues,
      observedAt,
      raw.evidence?.commandId || null,
      raw.evidence?.reason,
    );

    if (!this.liveApprovedDeviceConfigs.has(id)) {
      this.liveDiscoveredDeviceConfigs.set(id, {
        id,
        displayName:
          raw.displayName || raw.name || displayNameFromDeviceKey(id),
        tenantId: raw.tenantId,
        siteId: raw.siteId,
        siteName: raw.siteName,
        gatewayId: raw.gatewayId,
        zoneName: raw.zoneName || raw.location,
        suggestedRoom: raw.zoneName || raw.location,
        suggestedName: raw.displayName || raw.name,
        protocol: isProtocol(raw.protocol) ? raw.protocol : inferProtocol(raw),
        transport: isTransport(raw.transport) ? raw.transport : undefined,
        driver: raw.driver,
        target: raw.target || raw.physicalId,
        bridge: raw.bridge,
        capabilities: inferCapabilities(raw).map(
          (capability) => capability.kind,
        ),
        confidence: 0.65,
        reason:
          'Telemetry arrived on the Energrid site bus before this device was approved.',
      });
    }
  }

  ingestDeviceStatus(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;

    const raw = payload as {
      deviceId?: string;
      status?: string;
      observedAt?: string;
    };
    const id = safeId(raw.deviceId);
    if (!id) return;

    const current = this.liveStateByDeviceId.get(id);
    this.liveStateByDeviceId.set(id, {
      values: current?.values || {},
      observedAt:
        raw.observedAt || current?.observedAt || new Date().toISOString(),
      source: current?.source || 'mqtt-status',
      status: normalizeOnlineStatus(raw.status),
    });
  }

  markDeviceCommandPending(
    deviceId: string,
    command: {
      action: NonNullable<RegisteredDeviceState['command']>['action'];
      expectedValues: Record<string, number | boolean | string | null>;
      message?: string;
      ttlMs?: number;
      actor?: {
        type: 'user' | 'assistant' | 'automation' | 'system';
        id?: string;
        name?: string;
      };
    },
  ): NonNullable<RegisteredDeviceState['command']> {
    const now = Date.now();
    const requestedAt = new Date(now).toISOString();

    const previousCommandId = this.latestCommandIdByDeviceId.get(deviceId);
    const previousTrace = previousCommandId
      ? this.executionTraceByCommandId.get(previousCommandId)
      : null;

    if (previousTrace?.outcome === 'running') {
      replaceActiveTraceStage(previousTrace, 'settling', {
        stage: 'settling',
        status: 'warning',
        observedAt: requestedAt,
        message: 'Stability window interrupted by a newer command.',
      });

      appendTraceStage(previousTrace, {
        stage: 'superseded',
        status: 'complete',
        observedAt: requestedAt,
        message: 'A newer command replaced this execution before completion.',
        evidence: {
          supersededByAction: command.action,
        },
      });

      this.completeExecutionTrace(previousTrace, 'superseded', requestedAt);
    }

    const pending = {
      id: `${deviceId}:${command.action}:${now}`,
      action: command.action,
      status: 'pending' as const,
      requestedAt,
      expectedValues: command.expectedValues,
      message: command.message,
      expiresAt:
        now +
        (command.ttlMs || numberFromEnv('HOME_DEVICE_ACK_TIMEOUT_MS', 5000)),
      displayUntil:
        now + numberFromEnv('HOME_DEVICE_ACK_TIMEOUT_MS', 5000) + 30000,
    };
    this.commandByDeviceId.set(deviceId, pending);

    const trace: DeviceExecutionTrace & {
      expiresAt: number;
      settlingUntil: number | null;
      lastVerifiedValues: Record<
        string,
        number | boolean | string | null
      > | null;
    } = {
      id: pending.id,
      commandId: pending.id,
      deviceId,

      actor: {
        type: 'system',
        name: 'Energrid Control Service',
      },

      intent: command.message || 'Device command execution',

      action: command.action,
      expectedValues: { ...command.expectedValues },
      requestedAt,
      completedAt: null,
      outcome: 'running',
      durationMs: null,
      diagnosis: this.executionInvestigator.investigate({
        outcome: 'running',
        deviceId,
      }),
      expiresAt: pending.expiresAt,
      settlingUntil: null,
      lastVerifiedValues: null,
      stages: [
        {
          stage: 'requested',
          status: 'complete',
          observedAt: requestedAt,
          message: 'Command was accepted by the Energrid control service.',
          evidence: {
            expectedValues: { ...command.expectedValues },
          },
        },
      ],
    };

    this.executionTraceByCommandId.set(trace.commandId, trace);
    this.latestCommandIdByDeviceId.set(deviceId, trace.commandId);
    this.trimExecutionTraces();

    this.operationalLog?.record({
      level: 'info',
      source: 'device-control',
      event: 'command.pending',
      message: `${deviceId} ${command.action} requested; preparing transport.`,
      deviceId,
      status: 'pending',
      details: {
        action: command.action,
        expected: JSON.stringify(command.expectedValues),
      },
    });
    return commandForState(pending);
  }

  markDeviceCommandPublished(
    deviceId: string,
    commandId: string,
    evidence: {
      topic?: string;
      adapter?: string;
    } = {},
  ): DeviceExecutionTrace | null {
    const trace = this.executionTraceByCommandId.get(commandId);
    if (!trace || trace.deviceId !== deviceId) return null;
    if (trace.outcome !== 'running') return publicExecutionTrace(trace);

    appendTraceStage(trace, {
      stage: 'published',
      status: 'complete',
      observedAt: new Date().toISOString(),
      message: 'Command was published to the configured transport.',
      evidence,
    });

    return publicExecutionTrace(trace);
  }

  markDeviceCommandTransportFailed(
    deviceId: string,
    commandId: string,
    message: string,
  ): DeviceExecutionTrace | null {
    const trace = this.executionTraceByCommandId.get(commandId);
    if (!trace || trace.deviceId !== deviceId) return null;

    const now = new Date().toISOString();

    appendTraceStage(trace, {
      stage: 'transport_failed',
      status: 'failed',
      observedAt: now,
      message,
    });

    this.completeExecutionTrace(trace, 'failed', now);
    return publicExecutionTrace(trace);
  }

  getExecutionTraces(limit = 50): DeviceExecutionTrace[] {
    this.refreshExecutionTraces();

    return [...this.executionTraceByCommandId.values()]
      .sort(
        (left, right) =>
          Date.parse(right.requestedAt) - Date.parse(left.requestedAt),
      )
      .slice(0, Math.max(1, limit))
      .map(publicExecutionTrace);
  }

  getLatestExecutionTrace(deviceId: string): DeviceExecutionTrace | null {
    this.refreshExecutionTraces();

    const commandId = this.latestCommandIdByDeviceId.get(deviceId);
    if (!commandId) return null;

    const trace = this.executionTraceByCommandId.get(commandId);
    return trace ? publicExecutionTrace(trace) : null;
  }

  markDeviceCommandFailed(
    deviceId: string,
    command: {
      action: NonNullable<RegisteredDeviceState['command']>['action'];
      expectedValues: Record<string, number | boolean | string | null>;
      message?: string;
    },
  ): NonNullable<RegisteredDeviceState['command']> {
    const now = Date.now();
    const failed = {
      id: `${deviceId}:${command.action}:${now}`,
      action: command.action,
      status: 'failed' as const,
      requestedAt: new Date(now).toISOString(),
      expectedValues: command.expectedValues,
      message: command.message,
      expiresAt: now,
      displayUntil: now + 30000,
    };
    this.commandByDeviceId.set(deviceId, failed);
    this.operationalLog?.record({
      level: 'error',
      source: 'device-control',
      event: 'command.failed',
      message: `${deviceId} ${command.action} failed: ${command.message || 'unknown error'}`,
      deviceId,
      status: 'failed',
      details: {
        action: command.action,
        expected: JSON.stringify(command.expectedValues),
      },
    });
    return commandForState(failed);
  }

  private withLiveState(device: RegisteredDevice): RegisteredDevice {
    this.refreshDeviceCommand(device.id);
    const liveState = this.liveStateByDeviceId.get(device.id);
    const command = this.commandByDeviceId.get(device.id);
    const authoritative =
      this.authoritativeObservationByDeviceId.get(device.id);

    const owned =
      this.authoritativeFieldOwnershipByDeviceId.get(device.id);

    if (!liveState && !command && !authoritative && !owned?.size) {
      return device;
    }

    const keepUnowned = (
      values: Record<string, number | boolean | string | null>,
    ) =>
      owned
        ? Object.fromEntries(
            Object.entries(values).filter(
              ([field]) => !owned.has(field),
            ),
          )
        : values;

    return {
      ...device,
      state: {
        ...device.state,
        ...(liveState || {}),
        values: {
          ...keepUnowned(device.state.values),
          ...keepUnowned(liveState?.values || {}),
          ...(authoritative?.values || {}),
        },
        ...(authoritative
          ? {
              observedAt: authoritative.observedAt,
              source: 'approved-observation',
            }
          : {}),
        ...(command ? { command: commandForState(command) } : {}),
      },
    };
  }

  private observeCommandTelemetry(
    deviceId: string,
    values: Record<string, number | boolean | string | null>,
    observedAt: string,
    evidenceCommandId: string | null,
    reason?: string,
  ): void {
    this.refreshDeviceCommand(deviceId);
    this.refreshExecutionTraces();

    const command = this.commandByDeviceId.get(deviceId);
    if (!command || command.status !== 'pending') {
      this.observePossibleDrift(deviceId, values, observedAt);
      return;
    }

    const trace = this.executionTraceByCommandId.get(command.id);

    if (evidenceCommandId && evidenceCommandId !== command.id) {
      return;
    }

    const telemetryTime = Date.parse(observedAt);
    const requestedTime = Date.parse(command.requestedAt);

    if (
      Number.isFinite(telemetryTime) &&
      Number.isFinite(requestedTime) &&
      telemetryTime < requestedTime
    ) {
      if (trace) {
        appendTraceStage(trace, {
          stage: 'stale',
          status: 'warning',
          observedAt: new Date().toISOString(),
          message:
            'Telemetry was older than the command and could not verify it.',
          evidence: {
            telemetryObservedAt: observedAt,
            requestedAt: command.requestedAt,
          },
        });
      }

      return;
    }

    if (!valuesMatch(command.expectedValues, values)) {
      if (trace && evidenceCommandId === command.id) {
        appendTraceStage(trace, {
          stage: 'mismatched',
          status: 'warning',
          observedAt: new Date().toISOString(),
          message:
            'Device reported state, but it did not match the requested values.',
          evidence: {
            expectedValues: { ...command.expectedValues },
            reportedValues: { ...values },
            reason: reason || null,
          },
        });
      }

      return;
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    this.commandByDeviceId.set(deviceId, {
      ...command,
      status: 'acked',
      message: 'Device reported the requested state.',
      displayUntil: now + 5000,
    });

    if (trace) {
      appendTraceStage(trace, {
        stage: 'reported',
        status: 'complete',
        observedAt,
        message: 'Matching device telemetry was received.',
        evidence: {
          reportedValues: { ...values },
          sourceReason: reason || null,
          commandId: evidenceCommandId,
        },
      });

      appendTraceStage(trace, {
        stage: 'verified',
        status: 'complete',
        observedAt: nowIso,
        message: 'Registry verified that observed values matched the request.',
        evidence: {
          expectedValues: { ...command.expectedValues },
          reportedValues: { ...values },
        },
      });

      const settleMs = numberFromEnv('HOME_DEVICE_SETTLE_WINDOW_MS', 2000);

      trace.settlingUntil = now + settleMs;
      trace.lastVerifiedValues = { ...values };

      appendTraceStage(trace, {
        stage: 'settling',
        status: 'active',
        observedAt: nowIso,
        message: `Waiting ${settleMs}ms to ensure the device remains stable.`,
        evidence: {
          settleWindowMs: settleMs,
        },
      });
    }

    this.operationalLog?.record({
      level: 'info',
      source: 'device-registry',
      event: 'command.acked',
      message: `${deviceId} reported the requested state.`,
      deviceId,
      status: 'acked',
      details: {
        action: command.action,
        expected: JSON.stringify(command.expectedValues),
        commandId: command.id,
      },
    });
  }

  private observePossibleDrift(
    deviceId: string,
    values: Record<string, number | boolean | string | null>,
    observedAt: string,
  ): void {
    const commandId = this.latestCommandIdByDeviceId.get(deviceId);
    if (!commandId) return;

    const trace = this.executionTraceByCommandId.get(commandId);
    if (!trace || trace.outcome !== 'running') return;
    if (!trace.settlingUntil) return;

    if (valuesMatch(trace.expectedValues, values)) return;

    appendTraceStage(trace, {
      stage: 'drifted',
      status: 'failed',
      observedAt,
      message: 'Device moved away from the requested state during settling.',
      evidence: {
        expectedValues: { ...trace.expectedValues },
        observedValues: { ...values },
      },
    });

    this.completeExecutionTrace(trace, 'drifted', observedAt);
  }

  private completeExecutionTrace(
    trace: DeviceExecutionTrace & {
      expiresAt: number;
      settlingUntil: number | null;
      lastVerifiedValues: Record<
        string,
        number | boolean | string | null
      > | null;
    },
    outcome: Exclude<DeviceExecutionTrace['outcome'], 'running'>,
    completedAt: string,
  ): void {
    completeTrace(trace, outcome, completedAt);
    trace.diagnosis = this.executionInvestigator.investigate(trace);
  }

  private refreshExecutionTraces(): void {
    const now = Date.now();

    for (const trace of this.executionTraceByCommandId.values()) {
      if (trace.outcome !== 'running') continue;

      if (trace.settlingUntil && now >= trace.settlingUntil) {
        const completedAt = new Date(trace.settlingUntil).toISOString();

        replaceActiveTraceStage(trace, 'settling', {
          stage: 'settling',
          status: 'complete',
          observedAt: completedAt,
          message:
            'The stability window completed without contradictory telemetry.',
          evidence: {
            settleWindowCompletedAt: completedAt,
          },
        });

        appendTraceStage(trace, {
          stage: 'settled',
          status: 'complete',
          observedAt: completedAt,
          message: 'The device remained at the requested state.',
        });

        this.completeExecutionTrace(trace, 'settled', completedAt);
        continue;
      }

      if (!trace.settlingUntil && now > trace.expiresAt) {
        const completedAt = new Date(trace.expiresAt).toISOString();

        appendTraceStage(trace, {
          stage: 'timed_out',
          status: 'failed',
          observedAt: completedAt,
          message:
            'No matching telemetry arrived before the acknowledgement deadline.',
          evidence: {
            expectedValues: { ...trace.expectedValues },
          },
        });

        this.completeExecutionTrace(trace, 'timed_out', completedAt);
      }
    }
  }

  private trimExecutionTraces(): void {
    const maxTraces = numberFromEnv('HOME_DEVICE_EXECUTION_TRACE_LIMIT', 200);

    const traces = [...this.executionTraceByCommandId.values()].sort(
      (left, right) =>
        Date.parse(right.requestedAt) - Date.parse(left.requestedAt),
    );

    for (const trace of traces.slice(maxTraces)) {
      this.executionTraceByCommandId.delete(trace.commandId);

      if (
        this.latestCommandIdByDeviceId.get(trace.deviceId) === trace.commandId
      ) {
        this.latestCommandIdByDeviceId.delete(trace.deviceId);
      }
    }
  }

  private refreshDeviceCommand(deviceId: string): void {
    const command = this.commandByDeviceId.get(deviceId);
    if (!command) return;

    const now = Date.now();
    if (command.status === 'pending' && now > command.expiresAt) {
      this.commandByDeviceId.set(deviceId, {
        ...command,
        status: 'no_ack',
        message: 'Command was published, but no matching telemetry arrived.',
        displayUntil: now + 30000,
      });
      this.operationalLog?.record({
        level: 'warn',
        source: 'device-registry',
        event: 'command.no_ack',
        message: `${deviceId} did not report the requested state after command publish.`,
        deviceId,
        status: 'no_ack',
        details: {
          action: command.action,
          expected: JSON.stringify(command.expectedValues),
        },
      });
      return;
    }

    if (command.status !== 'pending' && now > command.displayUntil) {
      this.commandByDeviceId.delete(deviceId);
    }
  }
}

function appendTraceStage(
  trace: DeviceExecutionTrace,
  stage: DeviceExecutionTraceStage,
): void {
  const previous = trace.stages.at(-1);

  if (previous?.stage === stage.stage && previous.status === stage.status) {
    return;
  }

  trace.stages.push(stage);
}

function replaceActiveTraceStage(
  trace: DeviceExecutionTrace,
  stageName: DeviceExecutionTraceStage['stage'],
  replacement: DeviceExecutionTraceStage,
): void {
  let index = -1;

  for (
    let candidate = trace.stages.length - 1;
    candidate >= 0;
    candidate -= 1
  ) {
    const stage = trace.stages[candidate];

    if (stage.stage === stageName && stage.status === 'active') {
      index = candidate;
      break;
    }
  }

  if (index >= 0) {
    trace.stages[index] = replacement;
    return;
  }

  appendTraceStage(trace, replacement);
}

function completeTrace(
  trace: DeviceExecutionTrace,
  outcome: DeviceExecutionTrace['outcome'],
  completedAt: string,
): void {
  trace.outcome = outcome;
  trace.completedAt = completedAt;

  const started = Date.parse(trace.requestedAt);
  const completed = Date.parse(completedAt);

  trace.durationMs =
    Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started)
      : null;
}

function publicExecutionTrace(
  trace: DeviceExecutionTrace,
): DeviceExecutionTrace {
  return {
    id: trace.id,
    commandId: trace.commandId,
    deviceId: trace.deviceId,

    actor: trace.actor,

    action: trace.action,
    expectedValues: { ...trace.expectedValues },
    requestedAt: trace.requestedAt,
    completedAt: trace.completedAt,
    outcome: trace.outcome,
    durationMs: trace.durationMs,
    diagnosis: trace.diagnosis,
    stages: trace.stages.map((stage) => ({
      ...stage,
      evidence: stage.evidence ? { ...stage.evidence } : undefined,
    })),
  };
}

function metadataString(
  metadata: RegisteredDevice['metadata'] | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function metadataNumber(
  metadata: RegisteredDevice['metadata'] | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];

  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function commandForState(
  command: NonNullable<RegisteredDeviceState['command']> & {
    expiresAt?: number;
    displayUntil?: number;
  },
): NonNullable<RegisteredDeviceState['command']> {
  return {
    id: command.id,
    action: command.action,
    status: command.status,
    requestedAt: command.requestedAt,
    expectedValues: command.expectedValues,
    message: command.message,
  };
}

function valuesMatch(
  expected: Record<string, number | boolean | string | null>,
  actual: Record<string, number | boolean | string | null>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => actual[key] === value,
  );
}

function unknownState(
  source: string,
): RegisteredDeviceState {
  return {
    values: {},
    observedAt: null,
    source,
    status: 'unknown',
  };
}

function displayNameFromDeviceKey(key: string): string {
  return key
    .split('.')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function dedupeDevices(devices: RegisteredDevice[]): RegisteredDevice[] {
  const byId = new Map<string, RegisteredDevice>();

  for (const device of devices) {
    const existing = byId.get(device.id);

    if (!existing || devicePriority(device) > devicePriority(existing)) {
      byId.set(device.id, device);
    }
  }

  return [...byId.values()];
}

function devicePriority(device: RegisteredDevice): number {
  let score = 0;

  if (device.trustStatus === 'approved') score += 100;
  if (device.adapter.configured) score += 50;

  if (device.kind === 'logical') score += 20;
  if (device.assistantEnabled) score += 10;
  if (device.settingsUrl) score += 5;

  if (device.adapter.id === 'mqtt-discovered') score -= 200;
  if (device.adapter.driver === 'mqtt-unknown') score -= 200;

  return score;
}

function assistantEnabledDeviceIds(): Set<string> {
  return new Set(
    (process.env.HOME_ASSISTANT_ENABLED_DEVICE_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function canAssistantUseDevice(
  device: RegisteredDevice,
  byId: Map<string, RegisteredDevice>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(device.id)) return false;
  const actions = device.capabilities.flatMap((capability) => capability.actions);
  const readOnly = actions.length > 0 && actions.every((action) => action === 'read');
  if (readOnly) return true;
  if (device.assistantEnabled !== true) return false;
  if (device.memberDeviceIds?.length) {
    const next = new Set(seen).add(device.id);
    return device.memberDeviceIds.every((id) => {
      const member = byId.get(id);
      return !!member && canAssistantUseDevice(member, byId, next);
    });
  }
  return true;
}

function configuredSite() {
  return {
    tenantId: process.env.PORTAL_TENANT_ID || 'tenant-demo',
    siteId:
      process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home',
    siteName:
      process.env.PORTAL_SITE_NAME || process.env.HOME_SITE_NAME || 'Home',
    gatewayId:
      process.env.HOME_GATEWAY_ID ||
      process.env.PORTAL_GATEWAY_ID ||
      'site-gateway',
  };
}

function mqttTopicFor(
  identity: Pick<RegisteredDevice, 'tenantId' | 'siteId'>,
  deviceId: string,
  channel: 'state' | 'telemetry' | 'status' | 'command',
): string {
  return [
    mqttPrefixFor(identity),
    'devices',
    safeTopicPart(deviceId),
    channel,
  ].join('/');
}

function mqttPrefixFor(
  identity: Pick<RegisteredDevice, 'tenantId' | 'siteId'>,
): string {
  return [
    'energrid',
    safeTopicPart(identity.tenantId),
    safeTopicPart(identity.siteId),
  ].join('/');
}

function safeTopicPart(value: string): string {
  return safeId(value).replace(/\./g, '_');
}

function summarizeSites(
  devices: RegisteredDevice[],
  systems: SiteSystem[],
): DeviceRegistrySnapshot['sites'] {
  const bySite = new Map<string, DeviceRegistrySnapshot['sites'][number]>();

  for (const device of devices) {
    const site = bySite.get(device.siteId) || {
      id: device.siteId,
      name: device.siteName,
      gatewayIds: [],
      deviceCount: 0,
      systemCount: 0,
    };
    site.deviceCount += 1;
    if (device.gatewayId && !site.gatewayIds.includes(device.gatewayId)) {
      site.gatewayIds.push(device.gatewayId);
    }
    bySite.set(device.siteId, site);
  }

  for (const system of systems) {
    const site = bySite.get(system.siteId) || {
      id: system.siteId,
      name: system.siteName,
      gatewayIds: system.gatewayId ? [system.gatewayId] : [],
      deviceCount: 0,
      systemCount: 0,
    };
    site.systemCount += 1;
    if (system.gatewayId && !site.gatewayIds.includes(system.gatewayId)) {
      site.gatewayIds.push(system.gatewayId);
    }
    bySite.set(system.siteId, site);
  }

  return [...bySite.values()];
}

function summarizeGateways(
  devices: RegisteredDevice[],
): DeviceRegistrySnapshot['gateways'] {
  const gateways = new Map<
    string,
    DeviceRegistrySnapshot['gateways'][number]
  >();

  for (const device of devices) {
    if (!device.gatewayId) continue;
    const gateway = gateways.get(device.gatewayId) || {
      id: device.gatewayId,
      siteId: device.siteId,
      transport:
        device.adapter.transport ||
        transportForProtocol(device.adapter.protocol),
      broker: process.env.HOME_MQTT_HOST,
      topicPrefix: mqttPrefixFor(device),
      status: 'unknown',
    };
    if (device.state.status === 'online') gateway.status = 'online';
    gateways.set(device.gatewayId, gateway);
  }

  return [...gateways.values()];
}

function parseApprovedDevices(
  value: string | unknown[] | undefined,
): RegisteredDevice[] {
  if (!value) return [];

  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  } else {
    parsed = value;
  }

  const items = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { devices?: unknown[] }).devices)
      ? (parsed as { devices: unknown[] }).devices
      : [];

  return items
    .map((item) => normalizeApprovedDevice(item))
    .filter((device): device is RegisteredDevice => !!device);
}

function normalizeApprovedDevice(item: unknown): RegisteredDevice | null {
  if (!item || typeof item !== 'object') return null;

  const raw = item as ApprovedDeviceConfig;
  const id = safeId(raw.id || raw.deviceId || raw.key);
  if (!id) return null;

  const defaultIdentity = configuredSite();
  const identity = {
    tenantId: safeId(raw.tenantId) || defaultIdentity.tenantId,
    siteId: safeId(raw.siteId) || defaultIdentity.siteId,
    siteName: raw.siteName || defaultIdentity.siteName,
    gatewayId: safeId(raw.gatewayId) || defaultIdentity.gatewayId,
  };
  const zoneName =
    raw.zoneName || raw.location || inferZoneName(id, raw.groups);
  const capabilities = inferCapabilities(raw);
  const protocol = inferProtocol(raw);
  const transport = inferTransport(raw, protocol);
  const target = raw.target || raw.physicalId || raw.dst || id;
  const configured = raw.configured ?? protocol !== 'simulated';
  const values = raw.state?.values || raw.values || {};

  return {
    id,
    ...identity,
    displayName: raw.displayName || raw.name || displayNameFromDeviceKey(id),
    kind: raw.kind === 'logical' ? 'logical' : 'physical',
    zoneId: safeId(raw.zoneId || zoneName.toLowerCase()) || 'unassigned',
    zoneName,
    trustStatus: 'approved',
    assistantEnabled: raw.assistantEnabled === true || protocol === 'simulated',
    settingsUrl: safeSettingsUrl(raw.settingsUrl),
    capabilities,
    adapter: {
      id: raw.driver || inferDriver(raw, protocol),
      protocol,
      transport,
      driver: raw.driver || inferDriver(raw, protocol),
      configured,
      target,
      bridge: raw.bridge,
      eventTopicPrefix: mqttPrefixFor(identity),
      commandTopic: mqttTopicFor(identity, id, 'command'),
      stateTopic: mqttTopicFor(identity, id, 'state'),
      telemetryTopic: mqttTopicFor(identity, id, 'telemetry'),
      statusTopic: mqttTopicFor(identity, id, 'status'),
    },
    state: {
      values,
      observedAt: raw.state?.observedAt ?? raw.lastSeen ?? null,
      source: raw.state?.source || raw.origin || protocol,
      status: raw.state?.observedAt || raw.lastSeen ? normalizeOnlineStatus(raw.state?.status || raw.status) : 'unknown',
    },
    responseProfile: responseProfile({
      latencyMs: latencyForProtocol(protocol),
      notes: importedDeviceNotes(protocol, transport),
    }),
    policy: capabilities.every((capability) =>
      capability.actions.every((action) => action === 'read'),
    )
      ? readOnlyPolicy()
      : safePolicy(),
    metadata: cleanMetadata({
      ...raw.metadata,
      ...cleanMetadata({
        origin: raw.origin,
        hardwareId: raw.hardwareId || raw.physicalId,
        physicalId: raw.physicalId,
        channel: raw.channel ?? raw.switchId,
        channelName: raw.channelName,
        component: raw.component,
        model: raw.model,
        groups: raw.groups?.join(','),
        aliases: raw.aliases?.slice(0, 8).join(', '),
      }),
    }),
  };
}

function safeSettingsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function logicalGroupsFromImportedDevices(
  devices: RegisteredDevice[],
): RegisteredDevice[] {
  const byGroup = new Map<string, RegisteredDevice[]>();

  for (const device of devices) {
    const groups = String(device.metadata?.groups || '')
      .split(',')
      .map((group) => group.trim())
      .filter(Boolean);

    for (const group of groups) {
      const current = byGroup.get(group) || [];
      current.push(device);
      byGroup.set(group, current);
    }
  }

  return [...byGroup.entries()]
    .filter(([, members]) => members.length > 0)
    .map(([group, members]) => {
      const isLightGroup = group.includes('light');
      const zoneName = inferZoneName(group);
      const first = members[0];
      const identity = {
        tenantId: first.tenantId,
        siteId: first.siteId,
        siteName: first.siteName,
        gatewayId: first.gatewayId,
      };

      return {
        id: logicalGroupId(group),
        ...identity,
        displayName: displayNameFromDeviceKey(group),
        kind: 'logical',
        zoneId: safeId(zoneName.toLowerCase()) || 'site',
        zoneName,
        trustStatus: 'approved',
        assistantEnabled: members.every((member) => member.assistantEnabled === true),
        capabilities: [
          {
            kind: isLightGroup ? 'light' : 'switch',
            actions: ['turn_on', 'turn_off'],
          },
        ],
        adapter: {
          id: 'registry-group',
          protocol: 'mqtt',
          transport: 'mqtt',
          driver: 'shelly-rpc-group',
          configured: true,
          target: group,
          eventTopicPrefix: mqttPrefixFor(identity),
          commandTopic: mqttTopicFor(
            identity,
            logicalGroupId(group),
            'command',
          ),
          stateTopic: mqttTopicFor(identity, logicalGroupId(group), 'state'),
        },
        state: unknownState('registry-group'),
        responseProfile: responseProfile({
          latencyMs: 900,
          notes: 'Logical group generated from imported physical devices.',
        }),
        policy: safePolicy(),
        memberDeviceIds: members.map((device) => device.id),
      } satisfies RegisteredDevice;
    });
}

function logicalGroupId(group: string): string {
  const normalized = group.trim().toLowerCase();

  if (normalized === 'kitchen.lights') return 'kitchen_light';
  if (normalized === 'bath.lights' || normalized === 'bathroom.lights')
    return 'bath_light';
  if (normalized === 'hall.lights' || normalized === 'hallway.lights')
    return 'hallway_light';
  if (normalized === 'entry.lights' || normalized === 'entrance.lights')
    return 'entry_light';

  return safeId(normalized).replace(/\./g, '_');
}

function inferCapabilities(
  raw: ApprovedDeviceConfig,
): RegisteredDevice['capabilities'] {
  const explicit = (raw.capabilities || []).filter(isCapabilityKind);
  const readings = Object.entries(raw.config?.readings || {})
    .filter(([, config]) => config?.enabled !== false)
    .map(([kind]) => kind)
    .filter(isCapabilityKind);

  const inferred = new Set<DeviceCapabilityKind>([...explicit, ...readings]);
  const text =
    `${raw.type || ''} ${raw.deviceId || ''} ${raw.key || ''} ${(raw.groups || []).join(' ')}`.toLowerCase();

  if (text.includes('temp')) inferred.add('temperature');
  if (text.includes('humid')) inferred.add('humidity');
  if (text.includes('power') || text.includes('energy')) inferred.add('power');
  if (text.includes('motion') || text.includes('presence'))
    inferred.add('motion');
  if (text.includes('pump')) inferred.add('pump');
  if (
    text.includes('boiler') ||
    text.includes('oven') ||
    text.includes('fridge')
  )
    inferred.add('power');
  if (text.includes('light') || text.includes('lights'))
    inferred.add(raw.kind === 'logical' ? 'light' : 'switch');
  if (inferred.size === 0) inferred.add('switch');

  return [...inferred].map((kind) => ({
    kind,
    actions: actionsForCapability(kind),
    unit: unitForCapability(kind),
  }));
}

function actionsForCapability(
  kind: DeviceCapabilityKind,
): RegisteredDevice['capabilities'][number]['actions'] {
  if (
    kind === 'temperature' ||
    kind === 'humidity' ||
    kind === 'power' ||
    kind === 'motion' ||
    kind === 'pump' ||
    kind === 'forecast' ||
    kind === 'tariff'
  ) {
    return ['read'];
  }
  if (kind === 'camera') return ['capture'];
  if (kind === 'inventory') return ['read', 'analyze'];
  if (kind === 'heat_source')
    return ['read', 'set_mode', 'set_flow_temperature'];
  if (kind === 'slow_radiant_zone' || kind === 'fast_air_zone')
    return ['read', 'set_target_temperature', 'set_mode'];
  if (kind === 'valve') return ['open', 'close'];
  return ['turn_on', 'turn_off'];
}

function unitForCapability(kind: DeviceCapabilityKind): string | undefined {
  if (kind === 'temperature') return 'C';
  if (kind === 'humidity') return '%';
  if (kind === 'power') return 'W';
  return undefined;
}

function inferProtocol(raw: ApprovedDeviceConfig): DeviceProtocol {
  if (isProtocol(raw.protocol)) return raw.protocol;
  if (raw.origin === 'zigbee' || raw.driver?.includes('zigbee'))
    return 'zigbee';
  if (raw.origin === 'matter' || raw.driver?.includes('matter'))
    return 'matter';
  if (raw.origin === 'modbus' || raw.driver?.includes('modbus'))
    return 'modbus';
  if (raw.origin === 'shelly' || raw.origin === 'native') return 'mqtt';
  if (raw.target?.startsWith('http')) return 'http';
  return 'mqtt';
}

function inferTransport(
  raw: ApprovedDeviceConfig | DiscoveredDeviceConfig,
  protocol: DeviceProtocol,
): DeviceTransport {
  if (isTransport(raw.transport)) return raw.transport;
  return transportForProtocol(protocol);
}

function transportForProtocol(protocol: DeviceProtocol): DeviceTransport {
  if (protocol === 'http') return 'http';
  if (protocol === 'simulated' || protocol === 'none') return 'local';
  return 'mqtt';
}

function inferDriver(
  raw: ApprovedDeviceConfig,
  protocol: DeviceProtocol,
): string {
  if (raw.origin === 'shelly') return 'shelly-rpc';
  if (protocol === 'zigbee') return 'zigbee2mqtt';
  if (protocol === 'matter') return 'matter-bridge';
  if (protocol === 'modbus') return 'modbus-gateway';
  if (protocol === 'http') return 'http-device';
  if (protocol === 'simulated') return 'simulated-device';
  return 'mqtt-device';
}

function latencyForProtocol(protocol: DeviceProtocol): number | undefined {
  if (protocol === 'mqtt' || protocol === 'zigbee') return 700;
  if (protocol === 'matter') return 800;
  if (protocol === 'modbus') return 1000;
  if (protocol === 'http') return 1500;
  return undefined;
}

function importedDeviceNotes(
  protocol: DeviceProtocol,
  transport: DeviceTransport,
): string {
  if (protocol === transport) return 'Imported from the site device registry.';
  return `Imported from the site device registry; native protocol is ${protocol}, reported through ${transport}.`;
}

function inferZoneName(id: string, groups: string[] = []): string {
  const text = `${id} ${groups.join(' ')}`.toLowerCase();
  if (text.includes('kitchen')) return 'Kitchen';
  if (text.includes('bath')) return 'Bathroom';
  if (text.includes('garage')) return 'Garage';
  if (
    text.includes('din') ||
    text.includes('panel') ||
    text.includes('mainline')
  )
    return 'Panel';
  if (text.includes('shed') || text.includes('pump')) return 'Shed';
  return 'Unassigned';
}

function normalizeOnlineStatus(
  value: string | undefined,
): RegisteredDeviceState['status'] {
  if (value === 'active' || value === 'online') return 'online';
  if (value === 'inactive' || value === 'offline') return 'offline';
  return 'unknown';
}

function cleanMetadata(
  input: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') {
      output[key] = value;
    }
  }

  return output;
}

function parseShellyRpcDevices(
  value: string | undefined,
): ShellyRpcDeviceConfig[] {
  if (!value) return [];

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(':').map((part) => part.trim());

      if (parts.length === 2) {
        return {
          key: parts[0],
          dst: parts[0],
          switchId: Number(parts[1]),
        };
      }

      return {
        key: parts[0],
        dst: parts[1],
        switchId: Number(parts[2]),
      };
    })
    .filter((device) => {
      return (
        !!device.key &&
        !!device.dst &&
        Number.isInteger(device.switchId) &&
        device.switchId >= 0
      );
    });
}

function parseDiscoveredDevices(
  value: string | unknown[] | undefined,
): RegisteredDevice[] {
  if (!value) return [];

  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  } else {
    parsed = value;
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item, index) => normalizeDiscoveredDevice(item, index))
    .filter((device): device is RegisteredDevice => !!device);
}

function normalizeDiscoveredDevice(
  item: unknown,
  index: number,
): RegisteredDevice | null {
  if (!item || typeof item !== 'object') return null;

  const raw = item as DiscoveredDeviceConfig;
  const id = safeId(raw.id) || `discovered-${index + 1}`;
  const defaultIdentity = configuredSite();
  const identity = {
    tenantId: safeId(raw.tenantId) || defaultIdentity.tenantId,
    siteId: safeId(raw.siteId) || defaultIdentity.siteId,
    siteName: raw.siteName || defaultIdentity.siteName,
    gatewayId: safeId(raw.gatewayId) || defaultIdentity.gatewayId,
  };
  const capabilities = (raw.capabilities || ['switch']).filter(
    isCapabilityKind,
  );
  const protocol = isProtocol(raw.protocol) ? raw.protocol : 'none';
  const transport = inferTransport(raw, protocol);
  const source = raw.source || protocolToDiscoverySource(protocol);

  return {
    id,
    ...identity,
    displayName: raw.displayName || raw.suggestedName || id,
    kind: 'physical',
    zoneId: safeId(raw.zoneId) || 'unassigned',
    zoneName: raw.zoneName || raw.suggestedRoom || 'Unassigned',
    trustStatus: 'discovered',
    capabilities: capabilities.map((kind) => ({
      kind,
      actions: actionsForCapability(kind),
      unit: unitForCapability(kind),
    })),
    adapter: {
      id: raw.driver || `${protocol}-discovered`,
      protocol,
      transport,
      driver: raw.driver || `${protocol}-unknown`,
      configured: false,
      target: raw.target,
      bridge: raw.bridge,
      eventTopicPrefix: mqttPrefixFor(identity),
      commandTopic: mqttTopicFor(identity, id, 'command'),
      stateTopic: mqttTopicFor(identity, id, 'state'),
      telemetryTopic: mqttTopicFor(identity, id, 'telemetry'),
      statusTopic: mqttTopicFor(identity, id, 'status'),
    },
    state: unknownState(source),
    responseProfile: responseProfile({
      confidence: clampConfidence(raw.confidence),
      notes:
        'Discovered devices must be approved before the assistant can execute actions.',
    }),
    policy: {
      ...safePolicy(),
      requiresApproval: true,
      notes: 'Pending onboarding approval.',
    },
    discovery: {
      source,
      confidence: clampConfidence(raw.confidence),
      suggestedRoom: raw.suggestedRoom || raw.zoneName,
      suggestedName: raw.suggestedName || raw.displayName,
      reason:
        raw.reason || 'Discovered on the local network but not approved yet.',
    },
    metadata: cleanMetadata(raw.metadata || {}),
  };
}

function safeId(value: string | undefined): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_');
}

function isCapabilityKind(value: string): value is DeviceCapabilityKind {
  return [
    'light',
    'temperature',
    'humidity',
    'switch',
    'power',
    'motion',
    'valve',
    'pump',
    'heat_source',
    'slow_radiant_zone',
    'fast_air_zone',
    'camera',
    'inventory',
    'forecast',
    'tariff',
  ].includes(value);
}

function isProtocol(value: string | undefined): value is DeviceProtocol {
  return [
    'mqtt',
    'http',
    'zigbee',
    'matter',
    'modbus',
    'simulated',
    'none',
  ].includes(String(value));
}

function isTransport(value: string | undefined): value is DeviceTransport {
  return ['mqtt', 'http', 'local'].includes(String(value));
}

function protocolToDiscoverySource(
  protocol: DeviceProtocol,
): 'mqtt' | 'http' | 'zigbee' | 'matter' | 'modbus' | 'manual' | 'simulated' {
  if (protocol === 'mqtt') return 'mqtt';
  if (protocol === 'http') return 'http';
  if (protocol === 'zigbee') return 'zigbee';
  if (protocol === 'matter') return 'matter';
  if (protocol === 'modbus') return 'modbus';
  if (protocol === 'simulated') return 'simulated';
  return 'manual';
}

function clampConfidence(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, Number(value)));
}

function responseProfile(
  input: Partial<RegisteredDevice['responseProfile']> = {},
): RegisteredDevice['responseProfile'] {
  return {
    confidence: input.confidence ?? 0.5,
    learningEnabled: input.learningEnabled ?? true,
    latencyMs: input.latencyMs,
    thermalLagMinutes: input.thermalLagMinutes,
    minCycleMinutes: input.minCycleMinutes,
    notes: input.notes,
  };
}

function safePolicy(): RegisteredDevice['policy'] {
  return {
    requiresApproval: false,
    confirmationRequiredFor: [],
  };
}

function readOnlyPolicy(): RegisteredDevice['policy'] {
  return {
    requiresApproval: false,
    confirmationRequiredFor: [],
    notes: 'Read-only context for the assistant.',
  };
}

function climatePolicy(min: number, max: number): RegisteredDevice['policy'] {
  return {
    requiresApproval: false,
    confirmationRequiredFor: ['set_target_temperature', 'set_flow_temperature'],
    safeRange: {
      min,
      max,
      unit: 'C',
    },
    notes:
      'Climate changes stay inside configured comfort and equipment limits.',
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
