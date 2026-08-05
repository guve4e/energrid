import { Injectable } from '@nestjs/common'
import type {
  DeviceCapabilityKind,
  DeviceProtocol,
  DeviceTransport,
  DeviceRegistrySnapshot,
  RegisteredDevice,
  RegisteredDeviceState,
  SiteSystem,
} from './device-registry.types'

export interface ShellyRpcDeviceConfig {
  key: string
  dst: string
  switchId: number
}

interface DiscoveredDeviceConfig {
  id?: string
  displayName?: string
  suggestedName?: string
  tenantId?: string
  siteId?: string
  siteName?: string
  gatewayId?: string
  zoneId?: string
  zoneName?: string
  suggestedRoom?: string
  protocol?: DeviceProtocol
  transport?: DeviceTransport
  driver?: string
  target?: string
  bridge?: string
  capabilities?: DeviceCapabilityKind[]
  source?: 'mqtt' | 'mdns' | 'http' | 'zigbee' | 'matter' | 'modbus' | 'manual' | 'simulated'
  confidence?: number
  reason?: string
}

interface ApprovedDeviceConfig {
  id?: string
  deviceId?: string
  key?: string
  displayName?: string
  name?: string
  tenantId?: string
  siteId?: string
  siteName?: string
  gatewayId?: string
  type?: string
  kind?: 'logical' | 'physical'
  zoneId?: string
  zoneName?: string
  location?: string
  origin?: string
  physicalId?: string
  dst?: string
  channel?: number
  channelName?: string
  component?: string
  hardwareId?: string
  switchId?: number
  model?: string
  protocol?: DeviceProtocol
  transport?: DeviceTransport
  driver?: string
  target?: string
  bridge?: string
  configured?: boolean
  status?: string
  capabilities?: DeviceCapabilityKind[]
  groups?: string[]
  aliases?: string[]
  metadata?: Record<string, string | number | boolean>
  values?: Record<string, number | boolean | string | null>
  state?: {
    values?: Record<string, number | boolean | string | null>
    observedAt?: string | null
    source?: string
    status?: string
  }
  config?: {
    readings?: Record<string, { enabled?: boolean; unit?: string }>
  }
  lastSeen?: string
}

@Injectable()
export class DeviceRegistryService {
  private readonly liveApprovedDeviceConfigs = new Map<string, ApprovedDeviceConfig>()
  private readonly liveDiscoveredDeviceConfigs = new Map<string, DiscoveredDeviceConfig>()
  private readonly liveStateByDeviceId = new Map<string, RegisteredDeviceState>()

  getSnapshot(): DeviceRegistrySnapshot {
    const allDevices = this.getDevices()
    const allSystems = this.getSystems(allDevices)
    const currentSiteId = configuredSite().siteId
    const devices = allDevices.filter((device) => device.siteId === currentSiteId)
    const systems = this.getSystems(devices)
    const zones = this.getZones(devices, systems)

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
        approved: devices.filter((device) => device.trustStatus === 'approved').length,
        discovered: devices.filter((device) => device.trustStatus === 'discovered').length,
        controllable: devices.filter((device) =>
          device.capabilities.some((capability) =>
            capability.actions.some((action) => action !== 'read'),
          ),
        ).length,
        sensors: devices.filter((device) =>
          device.capabilities.some((capability) => capability.actions.includes('read')),
        ).length,
        systems: systems.length,
        learningEnabled: systems.filter((system) => system.learning.enabled).length,
      },
    }
  }

  getDevices(): RegisteredDevice[] {
    const now = new Date().toISOString()
    const identity = configuredSite()
    const shellyDevices = this.getKitchenLightShellyDevices()
    const importedDevices = this.getApprovedDevicesFromConfig()
    const importedLogicalGroups = logicalGroupsFromImportedDevices(importedDevices)
    const hasShellyGroup = shellyDevices.length > 0
    const hasGenericLightMqtt = !!process.env.HOME_KITCHEN_LIGHT_MQTT_TOPIC
    const hasLightHttp =
      !!process.env.HOME_KITCHEN_LIGHT_ON_URL ||
      !!process.env.HOME_KITCHEN_LIGHT_OFF_URL
    const hasImportedKitchenLights = importedLogicalGroups.some(
      (device) => device.id === 'kitchen_light',
    )
    const hasImportedKitchenTemperature = importedDevices.some(
      (device) =>
        device.zoneId === 'kitchen' &&
        device.capabilities.some((capability) => capability.kind === 'temperature'),
    )

    const kitchenLightGroup: RegisteredDevice = {
      id: 'kitchen_light',
      ...identity,
      displayName: 'Kitchen lights',
      kind: 'logical',
      zoneId: 'kitchen',
      zoneName: 'Kitchen',
      trustStatus: 'approved',
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
            : hasLightHttp
              ? 'http-relay'
              : 'simulated',
        protocol: hasShellyGroup || hasGenericLightMqtt ? 'mqtt' : hasLightHttp ? 'http' : 'simulated',
        transport: hasLightHttp ? 'http' : hasShellyGroup || hasGenericLightMqtt ? 'mqtt' : 'local',
        driver: hasShellyGroup
          ? 'shelly-rpc'
          : hasGenericLightMqtt
            ? 'generic-mqtt-switch'
            : hasLightHttp
              ? 'http-switch'
              : 'simulated-switch',
        configured: hasShellyGroup || hasGenericLightMqtt || hasLightHttp,
        target: hasShellyGroup
          ? process.env.HOME_SHELLY_RPC_TOPIC || 'shelly/rpc'
          : process.env.HOME_KITCHEN_LIGHT_MQTT_TOPIC ||
            process.env.HOME_KITCHEN_LIGHT_ON_URL ||
            undefined,
        eventTopicPrefix: mqttPrefixFor(identity),
        commandTopic: mqttTopicFor(identity, 'kitchen_light', 'command'),
        stateTopic: mqttTopicFor(identity, 'kitchen_light', 'state'),
      },
      state: unknownState('configured by adapter', hasShellyGroup || hasGenericLightMqtt || hasLightHttp),
      responseProfile: responseProfile({
        latencyMs: 600,
        notes: 'Logical light group fans out to physical adapters.',
      }),
      policy: safePolicy(),
      memberDeviceIds: shellyDevices.map((device) => device.key),
    }

    const physicalLights = shellyDevices.map<RegisteredDevice>((device) => ({
      id: device.key,
      ...identity,
      displayName: displayNameFromDeviceKey(device.key),
      kind: 'physical',
      zoneId: 'kitchen',
      zoneName: 'Kitchen',
      trustStatus: 'approved',
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
        notes: 'Shelly local RPC should be fast even when vendor cloud is unavailable.',
      }),
      policy: safePolicy(),
      metadata: {
        dst: device.dst,
        switchId: device.switchId,
      },
    }))

    const kitchenTemp = this.getKitchenTemperatureFromEnv()
    const tempHasMqtt = !!process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC
    const tempHasHttp = !!process.env.HOME_KITCHEN_TEMP_URL

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
        id: tempHasMqtt ? 'mqtt-sensor' : tempHasHttp ? 'http-sensor' : 'simulated',
        protocol: tempHasMqtt ? 'mqtt' : tempHasHttp ? 'http' : 'simulated',
        transport: tempHasHttp ? 'http' : tempHasMqtt ? 'mqtt' : 'local',
        driver: tempHasMqtt ? 'mqtt-json-sensor' : tempHasHttp ? 'http-json-sensor' : 'simulated-sensor',
        configured: tempHasMqtt || tempHasHttp || kitchenTemp != null,
        target: process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC || process.env.HOME_KITCHEN_TEMP_URL,
        eventTopicPrefix: mqttPrefixFor(identity),
        stateTopic: mqttTopicFor(identity, 'kitchen_temperature', 'state'),
        telemetryTopic: mqttTopicFor(identity, 'kitchen_temperature', 'telemetry'),
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
        notes: 'Read-only temperature signal used by the assistant and future climate systems.',
      }),
      policy: readOnlyPolicy(),
    }

    const devices = dedupeDevices([
      ...((hasShellyGroup || hasGenericLightMqtt || hasLightHttp || !hasImportedKitchenLights)
        ? [kitchenLightGroup]
        : []),
      ...physicalLights,
      ...(hasImportedKitchenTemperature ? [] : [temperatureDevice]),
      ...importedLogicalGroups,
      ...importedDevices,
      ...this.getDiscoveredDevices(),
    ])

    return devices.map((device) => this.withLiveState(device))
  }

  getAvailableDeviceIds(): string[] {
    return this.getDevices()
      .filter((device) => device.trustStatus === 'approved')
      .filter((device) => device.adapter.configured || device.adapter.protocol === 'simulated')
      .map((device) => device.id)
  }

  getKitchenLightShellyDevices(): ShellyRpcDeviceConfig[] {
    return parseShellyRpcDevices(
      process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES,
    )
  }

  private getKitchenTemperatureFromEnv(): number | null {
    const configured = Number(
      process.env.PORTAL_KITCHEN_TEMP_C ||
        process.env.HOME_FAKE_INSIDE_TEMP_C ||
        22.4,
    )

    return Number.isFinite(configured) ? configured : null
  }

  private getSystems(devices: RegisteredDevice[]): SiteSystem[] {
    const now = new Date().toISOString()
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
            description: 'Group lighting controlled locally through approved adapters.',
          },
        ],
        responseProfile: responseProfile({
          latencyMs: 700,
          notes: 'Fast control path; prefer local network over vendor cloud.',
        }),
        policy: safePolicy(),
        learning: {
          enabled: true,
          objective: 'Learn occupancy and daylight patterns before proposing scenes.',
          signals: ['voice commands', 'time of day', 'outside darkness', 'manual overrides'],
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
            description: 'Slow thermal mass heating with delayed room response.',
          },
        ],
        responseProfile: responseProfile({
          thermalLagMinutes: numberFromEnv('HOME_FLOOR_HEATING_LAG_MINUTES', 210),
          minCycleMinutes: 30,
          confidence: 0.2,
          notes: 'Learns slab delay, spacing behavior, forecast error, and comfort outcome.',
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
            thermalLagMinutes: numberFromEnv('HOME_FLOOR_HEATING_LAG_MINUTES', 210),
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
          objective: 'Use fast air only when radiant heating cannot meet comfort in time.',
          signals: ['room temperature', 'fan speed', 'comfort correction commands'],
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
          notes: 'Vision inventory must report confidence and avoid pretending certainty.',
        }),
        policy: readOnlyPolicy(),
        learning: {
          enabled: true,
          objective: 'Learn household inventory patterns and reduce repeated manual checks.',
          signals: ['camera snapshots', 'vision confidence', 'user corrections'],
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
            device.capabilities.some((capability) => capability.kind === 'temperature'),
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
            description: 'Optional electricity tariff signal for preheating decisions.',
          },
        ],
        responseProfile: responseProfile({
          confidence: 0.15,
          notes: 'Gets better only after enough forecast vs actual history exists.',
        }),
        policy: readOnlyPolicy(),
        learning: {
          enabled: true,
          objective: 'Improve preheat and comfort decisions from forecast error and building inertia.',
          signals: ['weather forecast', 'actual outside temperature', 'inside temperature', 'energy use'],
          currentConfidence: 0.15,
        },
        state: unknownState('planned-system'),
      },
    ]

    return systems
  }

  private getZones(
    devices: RegisteredDevice[],
    systems: SiteSystem[],
  ): DeviceRegistrySnapshot['zones'] {
    const byZone = new Map<string, { id: string; name: string; deviceIds: string[]; systemIds: string[] }>()

    for (const device of devices) {
      const zone = byZone.get(device.zoneId) || {
        id: device.zoneId,
        name: device.zoneName,
        deviceIds: [],
        systemIds: [],
      }
      zone.deviceIds.push(device.id)
      byZone.set(device.zoneId, zone)
    }

    for (const system of systems) {
      const zoneId = system.zoneId || 'site'
      const zone = byZone.get(zoneId) || {
        id: zoneId,
        name: system.zoneName || 'Site',
        deviceIds: [],
        systemIds: [],
      }
      zone.systemIds.push(system.id)
      byZone.set(zoneId, zone)
    }

    return [...byZone.values()]
  }

  private getDiscoveredDevices(): RegisteredDevice[] {
    return [
      ...parseDiscoveredDevices(process.env.HOME_DISCOVERED_DEVICES_JSON),
      ...parseDiscoveredDevices([...this.liveDiscoveredDeviceConfigs.values()]),
    ]
  }

  private getApprovedDevicesFromConfig(): RegisteredDevice[] {
    return [
      ...parseApprovedDevices(
        process.env.HOME_APPROVED_DEVICES_JSON ||
          process.env.HOME_DEVICE_REGISTRY_JSON ||
          process.env.DEVICE_REGISTRY_JSON,
      ),
      ...parseApprovedDevices([...this.liveApprovedDeviceConfigs.values()]),
    ]
  }

  ingestRegistryPayload(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return

    const raw = payload as {
      tenantId?: string
      siteId?: string
      siteName?: string
      gatewayId?: string
      devices?: unknown[]
      observedAt?: string
    }
    if (!Array.isArray(raw.devices)) return

    for (const item of raw.devices) {
      if (!item || typeof item !== 'object') continue

      const device = item as ApprovedDeviceConfig
      const id = safeId(device.id || device.deviceId || device.key)
      if (!id) continue

      this.liveApprovedDeviceConfigs.set(id, {
        ...device,
        tenantId: device.tenantId || raw.tenantId,
        siteId: device.siteId || raw.siteId,
        siteName: device.siteName || raw.siteName,
        gatewayId: device.gatewayId || raw.gatewayId,
        state: {
          values: device.state?.values || device.values || {},
          observedAt: device.state?.observedAt ?? device.lastSeen ?? raw.observedAt ?? null,
          source: device.state?.source || device.origin || device.protocol || 'mqtt-registry',
          status: device.state?.status || device.status || 'online',
        },
      })
      this.liveDiscoveredDeviceConfigs.delete(id)
    }
  }

  ingestDeviceTelemetry(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return

    const raw = payload as ApprovedDeviceConfig & {
      deviceId?: string
      observedAt?: string
    }
    const id = safeId(raw.id || raw.deviceId || raw.key)
    if (!id) return

    const values = raw.state?.values || raw.values || {}
    this.liveStateByDeviceId.set(id, {
      values,
      observedAt: raw.observedAt || raw.state?.observedAt || new Date().toISOString(),
      source: raw.state?.source || raw.origin || raw.protocol || 'mqtt-telemetry',
      status: normalizeOnlineStatus(raw.state?.status || raw.status || 'online'),
    })

    if (!this.liveApprovedDeviceConfigs.has(id)) {
      this.liveDiscoveredDeviceConfigs.set(id, {
        id,
        displayName: raw.displayName || raw.name || displayNameFromDeviceKey(id),
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
        capabilities: inferCapabilities(raw).map((capability) => capability.kind),
        confidence: 0.65,
        reason: 'Telemetry arrived on the Energrid site bus before this device was approved.',
      })
    }
  }

  ingestDeviceStatus(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return

    const raw = payload as {
      deviceId?: string
      status?: string
      observedAt?: string
    }
    const id = safeId(raw.deviceId)
    if (!id) return

    const current = this.liveStateByDeviceId.get(id)
    this.liveStateByDeviceId.set(id, {
      values: current?.values || {},
      observedAt: raw.observedAt || current?.observedAt || new Date().toISOString(),
      source: current?.source || 'mqtt-status',
      status: normalizeOnlineStatus(raw.status),
    })
  }

  private withLiveState(device: RegisteredDevice): RegisteredDevice {
    const liveState = this.liveStateByDeviceId.get(device.id)
    if (!liveState) return device

    return {
      ...device,
      state: {
        ...device.state,
        ...liveState,
        values: {
          ...device.state.values,
          ...liveState.values,
        },
      },
    }
  }
}

function unknownState(source: string, configured = true): RegisteredDeviceState {
  return {
    values: {},
    observedAt: null,
    source,
    status: configured ? 'unknown' : 'offline',
  }
}

function displayNameFromDeviceKey(key: string): string {
  return key
    .split('.')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function dedupeDevices(devices: RegisteredDevice[]): RegisteredDevice[] {
  const byId = new Map<string, RegisteredDevice>()

  for (const device of devices) {
    byId.set(device.id, device)
  }

  return [...byId.values()]
}

function configuredSite() {
  return {
    tenantId: process.env.PORTAL_TENANT_ID || 'tenant-demo',
    siteId: process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home',
    siteName: process.env.PORTAL_SITE_NAME || process.env.HOME_SITE_NAME || 'Home',
    gatewayId: process.env.HOME_GATEWAY_ID || process.env.PORTAL_GATEWAY_ID || 'site-gateway',
  }
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
  ].join('/')
}

function mqttPrefixFor(identity: Pick<RegisteredDevice, 'tenantId' | 'siteId'>): string {
  return ['energrid', safeTopicPart(identity.tenantId), safeTopicPart(identity.siteId)].join('/')
}

function safeTopicPart(value: string): string {
  return safeId(value).replace(/\./g, '_')
}

function summarizeSites(
  devices: RegisteredDevice[],
  systems: SiteSystem[],
): DeviceRegistrySnapshot['sites'] {
  const bySite = new Map<string, DeviceRegistrySnapshot['sites'][number]>()

  for (const device of devices) {
    const site = bySite.get(device.siteId) || {
      id: device.siteId,
      name: device.siteName,
      gatewayIds: [],
      deviceCount: 0,
      systemCount: 0,
    }
    site.deviceCount += 1
    if (device.gatewayId && !site.gatewayIds.includes(device.gatewayId)) {
      site.gatewayIds.push(device.gatewayId)
    }
    bySite.set(device.siteId, site)
  }

  for (const system of systems) {
    const site = bySite.get(system.siteId) || {
      id: system.siteId,
      name: system.siteName,
      gatewayIds: system.gatewayId ? [system.gatewayId] : [],
      deviceCount: 0,
      systemCount: 0,
    }
    site.systemCount += 1
    if (system.gatewayId && !site.gatewayIds.includes(system.gatewayId)) {
      site.gatewayIds.push(system.gatewayId)
    }
    bySite.set(system.siteId, site)
  }

  return [...bySite.values()]
}

function summarizeGateways(devices: RegisteredDevice[]): DeviceRegistrySnapshot['gateways'] {
  const gateways = new Map<string, DeviceRegistrySnapshot['gateways'][number]>()

  for (const device of devices) {
    if (!device.gatewayId) continue
    const gateway = gateways.get(device.gatewayId) || {
      id: device.gatewayId,
      siteId: device.siteId,
      transport: device.adapter.transport || transportForProtocol(device.adapter.protocol),
      broker: process.env.HOME_MQTT_HOST,
      topicPrefix: mqttPrefixFor(device),
      status: 'unknown',
    }
    if (device.state.status === 'online') gateway.status = 'online'
    gateways.set(device.gatewayId, gateway)
  }

  return [...gateways.values()]
}

function parseApprovedDevices(value: string | unknown[] | undefined): RegisteredDevice[] {
  if (!value) return []

  let parsed: unknown
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  } else {
    parsed = value
  }

  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { devices?: unknown[] }).devices)
      ? (parsed as { devices: unknown[] }).devices
      : []

  return items
    .map((item) => normalizeApprovedDevice(item))
    .filter((device): device is RegisteredDevice => !!device)
}

function normalizeApprovedDevice(item: unknown): RegisteredDevice | null {
  if (!item || typeof item !== 'object') return null

  const raw = item as ApprovedDeviceConfig
  const id = safeId(raw.id || raw.deviceId || raw.key)
  if (!id) return null

  const defaultIdentity = configuredSite()
  const identity = {
    tenantId: safeId(raw.tenantId) || defaultIdentity.tenantId,
    siteId: safeId(raw.siteId) || defaultIdentity.siteId,
    siteName: raw.siteName || defaultIdentity.siteName,
    gatewayId: safeId(raw.gatewayId) || defaultIdentity.gatewayId,
  }
  const zoneName = raw.zoneName || raw.location || inferZoneName(id, raw.groups)
  const capabilities = inferCapabilities(raw)
  const protocol = inferProtocol(raw)
  const transport = inferTransport(raw, protocol)
  const target = raw.target || raw.physicalId || raw.dst || id
  const configured = raw.configured ?? protocol !== 'simulated'
  const values = raw.state?.values || raw.values || {}

  return {
    id,
    ...identity,
    displayName: raw.displayName || raw.name || displayNameFromDeviceKey(id),
    kind: raw.kind === 'logical' ? 'logical' : 'physical',
    zoneId: safeId(raw.zoneId || zoneName.toLowerCase()) || 'unassigned',
    zoneName,
    trustStatus: 'approved',
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
      status: normalizeOnlineStatus(raw.state?.status || raw.status),
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
  }
}

function logicalGroupsFromImportedDevices(devices: RegisteredDevice[]): RegisteredDevice[] {
  const byGroup = new Map<string, RegisteredDevice[]>()

  for (const device of devices) {
    const groups = String(device.metadata?.groups || '')
      .split(',')
      .map((group) => group.trim())
      .filter(Boolean)

    for (const group of groups) {
      const current = byGroup.get(group) || []
      current.push(device)
      byGroup.set(group, current)
    }
  }

  return [...byGroup.entries()]
    .filter(([, members]) => members.length > 0)
    .map(([group, members]) => {
      const isLightGroup = group.includes('light')
      const zoneName = inferZoneName(group)
      const first = members[0]
      const identity = {
        tenantId: first.tenantId,
        siteId: first.siteId,
        siteName: first.siteName,
        gatewayId: first.gatewayId,
      }

      return {
        id: logicalGroupId(group),
        ...identity,
        displayName: displayNameFromDeviceKey(group),
        kind: 'logical',
        zoneId: safeId(zoneName.toLowerCase()) || 'site',
        zoneName,
        trustStatus: 'approved',
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
          commandTopic: mqttTopicFor(identity, logicalGroupId(group), 'command'),
          stateTopic: mqttTopicFor(identity, logicalGroupId(group), 'state'),
        },
        state: unknownState('registry-group'),
        responseProfile: responseProfile({
          latencyMs: 900,
          notes: 'Logical group generated from imported physical devices.',
        }),
        policy: safePolicy(),
        memberDeviceIds: members.map((device) => device.id),
      } satisfies RegisteredDevice
    })
}

function logicalGroupId(group: string): string {
  const normalized = group.trim().toLowerCase()

  if (normalized === 'kitchen.lights') return 'kitchen_light'
  if (normalized === 'bath.lights' || normalized === 'bathroom.lights') return 'bath_light'
  if (normalized === 'hall.lights' || normalized === 'hallway.lights') return 'hallway_light'
  if (normalized === 'entry.lights' || normalized === 'entrance.lights') return 'entry_light'

  return safeId(normalized).replace(/\./g, '_')
}

function inferCapabilities(raw: ApprovedDeviceConfig): RegisteredDevice['capabilities'] {
  const explicit = (raw.capabilities || []).filter(isCapabilityKind)
  const readings = Object.entries(raw.config?.readings || {})
    .filter(([, config]) => config?.enabled !== false)
    .map(([kind]) => kind)
    .filter(isCapabilityKind)

  const inferred = new Set<DeviceCapabilityKind>([...explicit, ...readings])
  const text = `${raw.type || ''} ${raw.deviceId || ''} ${raw.key || ''} ${(raw.groups || []).join(' ')}`.toLowerCase()

  if (text.includes('temp')) inferred.add('temperature')
  if (text.includes('humid')) inferred.add('humidity')
  if (text.includes('power') || text.includes('energy')) inferred.add('power')
  if (text.includes('motion') || text.includes('presence')) inferred.add('motion')
  if (text.includes('pump')) inferred.add('pump')
  if (text.includes('boiler') || text.includes('oven') || text.includes('fridge')) inferred.add('power')
  if (text.includes('light') || text.includes('lights')) inferred.add(raw.kind === 'logical' ? 'light' : 'switch')
  if (inferred.size === 0) inferred.add('switch')

  return [...inferred].map((kind) => ({
    kind,
    actions: actionsForCapability(kind),
    unit: unitForCapability(kind),
  }))
}

function actionsForCapability(kind: DeviceCapabilityKind): RegisteredDevice['capabilities'][number]['actions'] {
  if (
    kind === 'temperature' ||
    kind === 'humidity' ||
    kind === 'power' ||
    kind === 'motion' ||
    kind === 'pump' ||
    kind === 'forecast' ||
    kind === 'tariff'
  ) {
    return ['read']
  }
  if (kind === 'camera') return ['capture']
  if (kind === 'inventory') return ['read', 'analyze']
  if (kind === 'heat_source') return ['read', 'set_mode', 'set_flow_temperature']
  if (kind === 'slow_radiant_zone' || kind === 'fast_air_zone') return ['read', 'set_target_temperature', 'set_mode']
  if (kind === 'valve') return ['open', 'close']
  return ['turn_on', 'turn_off']
}

function unitForCapability(kind: DeviceCapabilityKind): string | undefined {
  if (kind === 'temperature') return 'C'
  if (kind === 'humidity') return '%'
  if (kind === 'power') return 'W'
  return undefined
}

function inferProtocol(raw: ApprovedDeviceConfig): DeviceProtocol {
  if (isProtocol(raw.protocol)) return raw.protocol
  if (raw.origin === 'zigbee' || raw.driver?.includes('zigbee')) return 'zigbee'
  if (raw.origin === 'matter' || raw.driver?.includes('matter')) return 'matter'
  if (raw.origin === 'modbus' || raw.driver?.includes('modbus')) return 'modbus'
  if (raw.origin === 'shelly' || raw.origin === 'native') return 'mqtt'
  if (raw.target?.startsWith('http')) return 'http'
  return 'mqtt'
}

function inferTransport(raw: ApprovedDeviceConfig | DiscoveredDeviceConfig, protocol: DeviceProtocol): DeviceTransport {
  if (isTransport(raw.transport)) return raw.transport
  return transportForProtocol(protocol)
}

function transportForProtocol(protocol: DeviceProtocol): DeviceTransport {
  if (protocol === 'http') return 'http'
  if (protocol === 'simulated' || protocol === 'none') return 'local'
  return 'mqtt'
}

function inferDriver(raw: ApprovedDeviceConfig, protocol: DeviceProtocol): string {
  if (raw.origin === 'shelly') return 'shelly-rpc'
  if (protocol === 'zigbee') return 'zigbee2mqtt'
  if (protocol === 'matter') return 'matter-bridge'
  if (protocol === 'modbus') return 'modbus-gateway'
  if (protocol === 'http') return 'http-device'
  if (protocol === 'simulated') return 'simulated-device'
  return 'mqtt-device'
}

function latencyForProtocol(protocol: DeviceProtocol): number | undefined {
  if (protocol === 'mqtt' || protocol === 'zigbee') return 700
  if (protocol === 'matter') return 800
  if (protocol === 'modbus') return 1000
  if (protocol === 'http') return 1500
  return undefined
}

function importedDeviceNotes(protocol: DeviceProtocol, transport: DeviceTransport): string {
  if (protocol === transport) return 'Imported from the site device registry.'
  return `Imported from the site device registry; native protocol is ${protocol}, reported through ${transport}.`
}

function inferZoneName(id: string, groups: string[] = []): string {
  const text = `${id} ${groups.join(' ')}`.toLowerCase()
  if (text.includes('kitchen')) return 'Kitchen'
  if (text.includes('bath')) return 'Bathroom'
  if (text.includes('garage')) return 'Garage'
  if (text.includes('din') || text.includes('panel') || text.includes('mainline')) return 'Panel'
  if (text.includes('shed') || text.includes('pump')) return 'Shed'
  return 'Unassigned'
}

function normalizeOnlineStatus(value: string | undefined): RegisteredDeviceState['status'] {
  if (value === 'active' || value === 'online') return 'online'
  if (value === 'inactive' || value === 'offline') return 'offline'
  return 'unknown'
}

function cleanMetadata(
  input: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {}

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') {
      output[key] = value
    }
  }

  return output
}

function parseShellyRpcDevices(value: string | undefined): ShellyRpcDeviceConfig[] {
  if (!value) return []

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(':').map((part) => part.trim())

      if (parts.length === 2) {
        return {
          key: parts[0],
          dst: parts[0],
          switchId: Number(parts[1]),
        }
      }

      return {
        key: parts[0],
        dst: parts[1],
        switchId: Number(parts[2]),
      }
    })
    .filter((device) => {
      return (
        !!device.key &&
        !!device.dst &&
        Number.isInteger(device.switchId) &&
        device.switchId >= 0
      )
    })
}

function parseDiscoveredDevices(value: string | unknown[] | undefined): RegisteredDevice[] {
  if (!value) return []

  let parsed: unknown
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  } else {
    parsed = value
  }

  if (!Array.isArray(parsed)) return []

  return parsed
    .map((item, index) => normalizeDiscoveredDevice(item, index))
    .filter((device): device is RegisteredDevice => !!device)
}

function normalizeDiscoveredDevice(
  item: unknown,
  index: number,
): RegisteredDevice | null {
  if (!item || typeof item !== 'object') return null

  const raw = item as DiscoveredDeviceConfig
  const id = safeId(raw.id) || `discovered-${index + 1}`
  const defaultIdentity = configuredSite()
  const identity = {
    tenantId: safeId(raw.tenantId) || defaultIdentity.tenantId,
    siteId: safeId(raw.siteId) || defaultIdentity.siteId,
    siteName: raw.siteName || defaultIdentity.siteName,
    gatewayId: safeId(raw.gatewayId) || defaultIdentity.gatewayId,
  }
  const capabilities = (raw.capabilities || ['switch']).filter(
    isCapabilityKind,
  )
  const protocol = isProtocol(raw.protocol) ? raw.protocol : 'none'
  const transport = inferTransport(raw, protocol)
  const source = raw.source || protocolToDiscoverySource(protocol)

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
    state: unknownState(source, false),
    responseProfile: responseProfile({
      confidence: clampConfidence(raw.confidence),
      notes: 'Discovered devices must be approved before the assistant can execute actions.',
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
      reason: raw.reason || 'Discovered on the local network but not approved yet.',
    },
  }
}

function safeId(value: string | undefined): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
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
  ].includes(value)
}

function isProtocol(value: string | undefined): value is DeviceProtocol {
  return ['mqtt', 'http', 'zigbee', 'matter', 'modbus', 'simulated', 'none'].includes(String(value))
}

function isTransport(value: string | undefined): value is DeviceTransport {
  return ['mqtt', 'http', 'local'].includes(String(value))
}

function protocolToDiscoverySource(
  protocol: DeviceProtocol,
): 'mqtt' | 'http' | 'zigbee' | 'matter' | 'modbus' | 'manual' | 'simulated' {
  if (protocol === 'mqtt') return 'mqtt'
  if (protocol === 'http') return 'http'
  if (protocol === 'zigbee') return 'zigbee'
  if (protocol === 'matter') return 'matter'
  if (protocol === 'modbus') return 'modbus'
  if (protocol === 'simulated') return 'simulated'
  return 'manual'
}

function clampConfidence(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, Number(value)))
}

function responseProfile(input: Partial<RegisteredDevice['responseProfile']> = {}): RegisteredDevice['responseProfile'] {
  return {
    confidence: input.confidence ?? 0.5,
    learningEnabled: input.learningEnabled ?? true,
    latencyMs: input.latencyMs,
    thermalLagMinutes: input.thermalLagMinutes,
    minCycleMinutes: input.minCycleMinutes,
    notes: input.notes,
  }
}

function safePolicy(): RegisteredDevice['policy'] {
  return {
    requiresApproval: false,
    confirmationRequiredFor: [],
  }
}

function readOnlyPolicy(): RegisteredDevice['policy'] {
  return {
    requiresApproval: false,
    confirmationRequiredFor: [],
    notes: 'Read-only context for the assistant.',
  }
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
    notes: 'Climate changes stay inside configured comfort and equipment limits.',
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}
