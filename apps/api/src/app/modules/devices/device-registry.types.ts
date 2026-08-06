export type DeviceTrustStatus = 'discovered' | 'approved' | 'blocked'
export type DeviceKind = 'logical' | 'physical'
export type DeviceProtocol =
  | 'mqtt'
  | 'http'
  | 'zigbee'
  | 'matter'
  | 'modbus'
  | 'simulated'
  | 'none'
export type DeviceTransport = 'mqtt' | 'http' | 'local'
export type DeviceOnlineStatus = 'online' | 'offline' | 'unknown'

export type DeviceCapabilityKind =
  | 'light'
  | 'temperature'
  | 'humidity'
  | 'switch'
  | 'power'
  | 'motion'
  | 'valve'
  | 'pump'
  | 'heat_source'
  | 'slow_radiant_zone'
  | 'fast_air_zone'
  | 'camera'
  | 'inventory'
  | 'forecast'
  | 'tariff'

export type DeviceCapabilityAction =
  | 'turn_on'
  | 'turn_off'
  | 'read'
  | 'set_target_temperature'
  | 'set_mode'
  | 'set_flow_temperature'
  | 'open'
  | 'close'
  | 'capture'
  | 'analyze'

export interface RegisteredDeviceCapability {
  kind: DeviceCapabilityKind
  actions: DeviceCapabilityAction[]
  unit?: string
  description?: string
}

export interface DeviceResponseProfile {
  latencyMs?: number
  thermalLagMinutes?: number
  minCycleMinutes?: number
  confidence: number
  learningEnabled: boolean
  notes?: string
}

export interface DevicePolicyProfile {
  requiresApproval: boolean
  confirmationRequiredFor: DeviceCapabilityAction[]
  safeRange?: {
    min?: number
    max?: number
    unit?: string
  }
  notes?: string
}

export interface RegisteredDeviceAdapter {
  id: string
  protocol: DeviceProtocol
  transport?: DeviceTransport
  driver: string
  configured: boolean
  target?: string
  bridge?: string
  eventTopicPrefix?: string
  commandTopic?: string
  stateTopic?: string
  telemetryTopic?: string
  statusTopic?: string
}

export interface RegisteredDeviceState {
  values: Record<string, number | boolean | string | null>
  observedAt: string | null
  source: string
  status: DeviceOnlineStatus
  command?: {
    id: string
    action: DeviceCapabilityAction
    status: 'pending' | 'acked' | 'no_ack' | 'failed'
    requestedAt: string
    expectedValues: Record<string, number | boolean | string | null>
    message?: string
  }
}

export interface DeviceDiscoveryInfo {
  source: 'mqtt' | 'mdns' | 'http' | 'zigbee' | 'matter' | 'modbus' | 'manual' | 'simulated'
  confidence: number
  suggestedRoom?: string
  suggestedName?: string
  reason: string
}

export interface RegisteredDevice {
  id: string
  tenantId: string
  siteId: string
  siteName: string
  gatewayId?: string
  displayName: string
  kind: DeviceKind
  zoneId: string
  zoneName: string
  trustStatus: DeviceTrustStatus
  capabilities: RegisteredDeviceCapability[]
  adapter: RegisteredDeviceAdapter
  state: RegisteredDeviceState
  responseProfile: DeviceResponseProfile
  policy: DevicePolicyProfile
  discovery?: DeviceDiscoveryInfo
  memberDeviceIds?: string[]
  metadata?: Record<string, string | number | boolean>
}

export type SiteSystemKind =
  | 'lighting'
  | 'slow_radiant_heating'
  | 'fast_air_climate'
  | 'heat_pump'
  | 'refrigerator_inventory'
  | 'forecast_optimizer'

export interface SiteSystem {
  id: string
  tenantId: string
  siteId: string
  siteName: string
  gatewayId?: string
  displayName: string
  kind: SiteSystemKind
  zoneId?: string
  zoneName?: string
  deviceIds: string[]
  capabilities: RegisteredDeviceCapability[]
  responseProfile: DeviceResponseProfile
  policy: DevicePolicyProfile
  learning: {
    enabled: boolean
    objective: string
    signals: string[]
    currentConfidence: number
  }
  state: RegisteredDeviceState
}

export interface DeviceRegistrySnapshot {
  tenant: {
    id: string
    name: string
  }
  site: {
    id: string
    name: string
  }
  sites: Array<{
    id: string
    name: string
    gatewayIds: string[]
    deviceCount: number
    systemCount: number
  }>
  gateways: Array<{
    id: string
    siteId: string
    transport: DeviceTransport
    broker?: string
    topicPrefix?: string
    status: DeviceOnlineStatus
  }>
  devices: RegisteredDevice[]
  systems: SiteSystem[]
  zones: Array<{
    id: string
    name: string
    deviceIds: string[]
    systemIds: string[]
  }>
  summary: {
    total: number
    approved: number
    discovered: number
    controllable: number
    sensors: number
    systems: number
    learningEnabled: number
  }
}

export interface NetworkDiscoveredDevice {
  id: string
  ipAddress: string
  networkZoneId: string
  networkZoneName: string
  macAddress?: string
  hostname?: string
  vendor?: string
  protocol: DeviceProtocol | 'unknown'
  confidence: number
  status: DeviceOnlineStatus
  settingsUrl?: string
  model?: string
  app?: string
  generation?: number
  discoveredAt: string
  reason: string
}

export interface NetworkDiscoveryZone {
  id: string
  name: string
  cidr?: string
  interfaceName?: string
  seedIps: string[]
  role?: 'primary' | 'iot' | 'camera' | 'guest' | 'service'
}
