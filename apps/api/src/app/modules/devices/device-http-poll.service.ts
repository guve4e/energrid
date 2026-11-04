import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, Inject } from '@nestjs/common'
import { DeviceRegistryService } from './device-registry.service'
import type { RegisteredDevice } from './device-registry.types'
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { DeviceLanDiscoveryService } from './device-lan-discovery.service'
import { DeviceFirmwareDiagnosticsService } from './device-firmware-diagnostics'
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime'
import { isShellySwitchCollectionCandidate } from './adapters/outbound/network/shelly-switch-collection.adapter'
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from './enrollment/physical-device-inventory.token'
import type { PhysicalDeviceInventoryService } from './enrollment/physical-device-inventory.service'
import { ShellyRouteResolver } from './shelly-route.resolver'
import { ShellyOperationalCollectionService } from './integrations/shelly/shelly-operational-collection.service'
import { EnergridEspHttpCollectionService } from './integrations/energrid/energrid-esp-http-collection.service'
export { buildFirmwareDiagnosticCollectionContext } from './integrations/energrid/energrid-esp-http-collection.service'

@Injectable()
export class DeviceHttpPollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceHttpPollService.name)
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private readonly shelly: ShellyOperationalCollectionService
  private readonly energrid: EnergridEspHttpCollectionService

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly observations?: ApprovedMqttObservationRuntime,
    private readonly discovery?: DeviceDiscoveryMemoryStore,
    private readonly lanDiscovery?: DeviceLanDiscoveryService,
    private readonly firmwareDiagnostics?: DeviceFirmwareDiagnosticsService,
    @Optional() @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
    @Optional() routes?: ShellyRouteResolver,
    @Optional() shelly?: ShellyOperationalCollectionService,
    @Optional() energrid?: EnergridEspHttpCollectionService,
  ) {
    // Direct-constructor tests still work; production Nest provides the shared instance.
    this.shelly = shelly ?? new ShellyOperationalCollectionService(registry, discovery, lanDiscovery, physicalInventory, routes)
    this.energrid = energrid ?? new EnergridEspHttpCollectionService(registry, observations, discovery, lanDiscovery, firmwareDiagnostics)
  }

  onModuleInit(): void {
    if (!httpPollingEnabled()) return

    const intervalMs = httpPollIntervalMs()
    this.logger.log(`[DEVICE HTTP POLL] enabled interval=${intervalMs}ms`)
    void this.pollOnce()
    this.timer = setInterval(() => void this.pollOnce(), intervalMs)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.shelly.stop()
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return
    this.polling = true

    try {
      // One explicit selection rule for scheduled HTTP reads. MQTT subscriptions
      // and command authorization are independent of this schedule.
      const work = selectScheduledHttpCollection(this.registry.getDevices(true))
      await Promise.all(work.httpDevices.map(device => this.pollDevice(device)))
      await Promise.all(work.shellySwitches.map(device => this.shelly.pollAuthorizedLocalShellyStatus(device)))
      await this.refreshRemoteShellyObservers(work.shellySwitches)
    } finally {
      this.polling = false
    }
  }

  private async pollDevice(device: RegisteredDevice): Promise<void> {
    if (device.adapter.driver === 'energrid-esp8266') {
      await this.energrid.pollDevice(device)
      return
    }

    // Only the identity-aware HTTP integration can submit scheduled samples.
    // Shelly switch status uses the separate identity-verified operational path.
    // Legacy generic JSON and Shelly EM1 collection fail closed until their
    // adapters establish source/field authority through approved ingress.
  }

  /** @deprecated Portal/tests compatibility; the Shelly integration owns this policy. */
  async resolveShellyControlTarget(
    deviceId: string,
    ownership: { tenantId: string; siteId: string },
    onStage?: (stage: 'enrollment_and_inventory_validation' | 'enrollment_inventory_validated' | 'saved_endpoint_observer_scope_validation' | 'saved_endpoint_observer_scope_validated') => void,
    requireControlRoute = false,
  ) {
    return this.shelly.resolveShellyControlTarget(deviceId, ownership, onStage, requireControlRoute)
  }

  /** @deprecated Portal compatibility; the Shelly integration performs the read. */
  async observeShellySwitchStatusOnce(deviceId: string, ownership: { tenantId: string; siteId: string }) {
    return this.shelly.observeShellySwitchStatusOnce(deviceId, ownership)
  }

  /** Transitional private seam for existing scheduling tests. */
  private refreshRemoteShellyObservers(devices: RegisteredDevice[]): Promise<void> {
    return this.shelly.refreshRemoteShellyObservers(devices)
  }
}

function isHttpTarget(value: string | undefined): value is string {
  return !!value && /^https?:\/\//.test(value)
}

/**
 * Explain the EXISTING HTTP candidate rules without authorizing collection.
 * MQTT delivery, installation field authority, observer reachability and control
 * are separate decisions. Keep these reasons and the scheduler in one place.
 */
export function explainScheduledHttpCollection(device: RegisteredDevice): {
  httpRead: { selected: boolean; reason: string }
  operationalStatusRead: { selected: boolean; reason: string }
} {
  const operationalStatusRead = isShellySwitchCollectionCandidate(device)
    ? { selected: true, reason: 'identity_checked_switch_candidate' }
    : { selected: false, reason: 'no_operational_switch_collector' }

  // Only a collection integration that verifies identity/provenance can be
  // scheduled to submit measurements. An approved adapter or URL alone does
  // not authorize a generic JSON-to-registry telemetry write.
  const httpRead = device.trustStatus !== 'approved'
    ? { selected: false, reason: 'device_not_approved' }
    : operationalStatusRead.selected && device.adapter.protocol === 'http'
      ? { selected: false, reason: 'covered_by_operational_status_read' }
      : device.adapter.protocol !== 'http'
        ? { selected: false, reason: 'adapter_not_http' }
        : !device.adapter.configured && device.adapter.driver !== 'energrid-esp8266'
          ? { selected: false, reason: 'adapter_not_configured' }
          : !isHttpTarget(device.adapter.target)
            ? { selected: false, reason: 'http_target_missing' }
            : device.adapter.driver !== 'energrid-esp8266'
              ? { selected: false, reason: 'no_trusted_http_integration' }
              : { selected: true, reason: 'scheduled_http_candidate' }

  return { httpRead, operationalStatusRead }
}

/** These are candidates only; the integrations must still verify authority. */
export function selectScheduledHttpCollection(devices: ReadonlyArray<RegisteredDevice>): {
  httpDevices: RegisteredDevice[]
  shellySwitches: RegisteredDevice[]
} {
  const httpDevices: RegisteredDevice[] = []
  const shellySwitches: RegisteredDevice[] = []
  for (const device of devices) {
    const decision = explainScheduledHttpCollection(device)
    if (decision.httpRead.selected) httpDevices.push(device)
    if (decision.operationalStatusRead.selected) shellySwitches.push(device)
  }
  return { httpDevices, shellySwitches }
}

function httpPollingEnabled(): boolean {
  return ['1', 'true', 'yes'].includes(String(process.env.HOME_HTTP_POLL_ENABLED).toLowerCase())
}

function httpPollIntervalMs(): number {
  const configured = Number(process.env.HOME_HTTP_POLL_INTERVAL_MS)
  return Number.isFinite(configured) && configured >= 500 ? configured : 5000
}
