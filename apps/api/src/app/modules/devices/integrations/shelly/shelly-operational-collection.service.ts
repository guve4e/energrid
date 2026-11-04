import { httpPollTimeoutMs } from '../../collection/http-collection-timeout'
import { BadGatewayException, ConflictException, Injectable, Logger, Inject, Optional } from '@nestjs/common'
import { performance } from 'node:perf_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { DeviceRegistryService } from '../../device-registry.service'
import type { NetworkDiscoveryZone, RegisteredDevice } from '../../device-registry.types'
import { DeviceDiscoveryMemoryStore } from '../../device-discovery-memory.store'
import { DeviceLanDiscoveryService, ipInCidr } from '../../device-lan-discovery.service'
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from '../../enrollment/physical-device-inventory.token'
import type { PhysicalDeviceInventoryService } from '../../enrollment/physical-device-inventory.service'
import { ShellyRouteResolver, type AuthorizedLocalShellyStatusTarget } from '../../shelly-route.resolver'
import { parseShellySwitchStatus } from '../../adapters/inbound/shelly/shelly-switch-status'
import { readOnlyShellyRpcDeviceInfoFromBody } from '../../adapters/inbound/shelly/read-only-shelly-rpc'
import { readVerifiedShellySwitchStatus, shellySwitchStatusRpcUrl } from '../../adapters/outbound/network/shelly-switch-collection.adapter'
import { ShellyRemoteObserverSupervisor, safeRemoteObserverError } from './shelly-remote-observer.supervisor'

interface AcceptedShellyStatusObservation {
  output: boolean
  observedAt: string
  observer: { id: string; host: string }
}

/** All Shelly-specific operational reads and remote observer lifecycle live here.
 * Core authorization and state writer remain responsible for admission/persistence.
 */
@Injectable()
export class ShellyOperationalCollectionService {
  private readonly logger = new Logger(ShellyOperationalCollectionService.name)
  private readonly remoteSupervisor: ShellyRemoteObserverSupervisor
  private readonly routes: ShellyRouteResolver

  constructor(
    private readonly registry: DeviceRegistryService,
    @Optional() private readonly discovery?: DeviceDiscoveryMemoryStore,
    @Optional() private readonly lanDiscovery?: DeviceLanDiscoveryService,
    @Optional() @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
    @Optional() routes?: ShellyRouteResolver,
  ) {
    this.routes = routes ?? new ShellyRouteResolver(registry, discovery, lanDiscovery, physicalInventory)
    this.remoteSupervisor = new ShellyRemoteObserverSupervisor(registry, this.routes, lanDiscovery, physicalInventory, discovery)
  }

  stop(): void {
    this.remoteSupervisor.stop()
  }

  /** Legacy Shelly HTTP read. Retained without changing behavior until its observation
   * authority is migrated to the approved ingress; never emits an offline device state. */
  async pollLegacyShellyHttp(device: RegisteredDevice): Promise<void> {
    const zone = this.configuredShellyZone(device)
    // Never read a saved endpoint from the API host outside its configured local scope.
    if (!zone || (zone.collectionSource ?? 'local') !== 'local' || !httpTargetWithinZone(device.adapter.target, zone)) return
    const target = device.adapter.target
    if (!isHttpTarget(target)) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), httpPollTimeoutMs())
    try {
      const startedAt = Date.now()
      const observedAt = new Date().toISOString()
      const response = await fetch(target, { signal: controller.signal, headers: { Accept: 'application/json' } })
      if (!response.ok) {
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} status=${response.status}`)
        return
      }
      const values = parseShellySwitchStatus(await response.json(), String(device.metadata?.component || ''))
      if (!values) {
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=invalid_shelly_switch_status`)
        return
      }
      this.registry.ingestDeviceTelemetry({
        deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId,
        name: device.displayName, protocol: 'http', transport: 'http', driver: device.adapter.driver,
        target, location: device.zoneName, capabilities: device.capabilities.map(capability => capability.kind),
        values, state: { values, source: 'http-poll', status: 'online' }, observedAt,
      })
      this.logger.log(`[DEVICE HTTP POLL] ${device.id} ${Date.now() - startedAt}ms`)
    } catch (error) {
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} ${error instanceof Error ? error.message : 'failed'}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  async pollAuthorizedLocalShellyStatus(
    device: RegisteredDevice,
    resolvedTarget?: AuthorizedLocalShellyStatusTarget,
  ): Promise<AcceptedShellyStatusObservation | null> {
    let target: AuthorizedLocalShellyStatusTarget | null = resolvedTarget || null
    try {
      if (!target) target = await this.resolveAuthorizedLocalShellyStatusTarget(device)
    } catch (error) {
      this.logger.warn(JSON.stringify({
        event: 'shelly_operational_status_poll', outcome: 'rejected', deviceId: device.id,
        failureCategory: 'authorization_resolution_failed',
        error: safeRemoteObserverError(error),
      }))
      return null
    }
    if (!target) return null
    const { observer, physicalId, component, channel, ipAddress, zone } = target
    const correlationId = randomUUID()
    const startedAt = performance.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(httpPollTimeoutMs(), 2_500))
    const statusUrl = shellySwitchStatusRpcUrl(ipAddress, channel)
    try {
      const { values, observedAt } = await readVerifiedShellySwitchStatus(
        { ipAddress, physicalId, component, channel }, controller.signal,
      )
      const localScopes = [{
        interfaceName: observer.interfaceName!, cidr: zone.cidr!, address: target.interfaceAddress,
      }]
      this.registry.recordObserverReachability(device.id, {
        status: 'reachable', checkedAt: observedAt, endpoint: statusUrl, targetIpAddress: ipAddress,
        networkScopeId: zone.id,
        observer: { id: observer.id, host: observer.host, platform: process.platform, localScopes },
      }, { tenantId: device.tenantId, siteId: device.siteId })
      this.registry.ingestDeviceTelemetry({
        id: device.id, deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId,
        displayName: device.displayName, protocol: 'http', transport: 'http', driver: 'shelly-lan',
        target: statusUrl, location: device.zoneName,
        capabilities: device.capabilities.map(capability => capability.kind), values,
        state: { values, source: `site-local-http-rpc:${observer.id}`, status: 'online', observedAt },
        observedAt,
        observationId: `shelly-local:${createHash('sha256').update(`${observer.id}\u0000${device.id}\u0000${observedAt}\u0000${values.on}`).digest('hex')}`,
      })
      this.logger.log(JSON.stringify({
        event: 'shelly_operational_status_poll', correlationId, outcome: 'accepted',
        deviceId: device.id, observerId: observer.id, scopeId: zone.id,
        observedAt, observerDurationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      }))
      return { output: values.on, observedAt, observer: { id: observer.id, host: observer.host } }
    } catch (error) {
      this.registry.recordObserverReachability(device.id, {
        status: 'unreachable', checkedAt: new Date().toISOString(), endpoint: statusUrl,
        targetIpAddress: ipAddress, networkScopeId: zone.id,
        observer: { id: observer.id, host: observer.host, platform: process.platform, localScopes: [{
          interfaceName: observer.interfaceName!, cidr: zone.cidr!, address: target.interfaceAddress,
        }] },
        reason: error instanceof Error ? safeRemoteObserverError(error) : 'observer_error',
      }, { tenantId: device.tenantId, siteId: device.siteId })
      this.logger.warn(JSON.stringify({
        event: 'shelly_operational_status_poll', correlationId, outcome: 'rejected',
        deviceId: device.id, observerId: observer.id, scopeId: zone.id,
        failureCategory: controller.signal.aborted ? 'timeout' : 'observation_failed',
        error: safeRemoteObserverError(error),
        observerDurationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      }))
    } finally {
      clearTimeout(timeout)
    }
    return null
  }

  /** Transitional wrapper for existing read-only poller tests and callers.
   * The shared route resolver is the only implementation of this policy.
   */
  private async resolveAuthorizedLocalShellyStatusTarget(
    device: RegisteredDevice,
    expectedIpAddress?: string,
  ): Promise<AuthorizedLocalShellyStatusTarget | null> {
    return this.routes.resolveAuthorizedLocalShellyStatusTarget(device, expectedIpAddress)
  }

  private configuredShellyZone(device: RegisteredDevice): NetworkDiscoveryZone | undefined {
    const scope = String(device.metadata?.networkScope || '').trim()
    if (!scope || !this.lanDiscovery?.getConfiguredZone) return undefined

    // Shelly enrollment stores observer identity and zone as
    // "<observer>:<zone-id>"; older local records may store only the zone id.
    // Resolve against configured scopes, never the last Portal-selected scan.
    const scopeId = scope.slice(scope.lastIndexOf(':') + 1)
    return this.lanDiscovery.getConfiguredZone(scopeId)
  }

  refreshRemoteShellyObservers(devices: RegisteredDevice[]): Promise<void> {
    return this.remoteSupervisor.refreshRemoteShellyObservers(devices)
  }

  /** @deprecated Call ShellyRouteResolver directly. Retained for Portal/legacy read-only callers. */
  async resolveShellyControlTarget(
    deviceId: string,
    ownership: { tenantId: string; siteId: string },
    onStage?: (stage: 'enrollment_and_inventory_validation' | 'enrollment_inventory_validated' | 'saved_endpoint_observer_scope_validation' | 'saved_endpoint_observer_scope_validated') => void,
    requireControlRoute = false,
  ) {
    return this.routes.resolveShellyControlTarget(deviceId, ownership, onStage, requireControlRoute)
  }

  /** Perform one operator-triggered, read-only status read for an enrolled Shelly. */
  async observeShellySwitchStatusOnce(
    deviceId: string,
    ownership: { tenantId: string; siteId: string },
  ) {
    const correlationId = randomUUID()
    const startedAt = performance.now()
    let stage = 'request_accepted_site_resolved'
    let scopeId: string | undefined
    let observerId: string | undefined
    this.logShellyObservation(correlationId, stage, 'completed', startedAt, deviceId, ownership)
    try {
      stage = 'enrollment_and_inventory_validation'
      const target = await this.resolveShellyControlTarget(deviceId, ownership, nextStage => {
        stage = nextStage
        if (nextStage === 'enrollment_inventory_validated' || nextStage === 'saved_endpoint_observer_scope_validated')
          this.logShellyObservation(correlationId, nextStage, 'completed', startedAt, deviceId, ownership, scopeId ? { scopeId } : {})
      })
      const { device, inventory, physicalId, component, ipAddress, zone } = target
      const zoneId = zone.id
      scopeId = zoneId

      if (zone.collectionSource === 'local' && target.siteLocalObserver) {
        if (!this.lanDiscovery) throw new BadGatewayException('The authorized site-local observer adapter is unavailable.')
        observerId = target.siteLocalObserver.id
        this.logShellyObservation(correlationId, 'remote_execution_started', 'started', startedAt, deviceId, ownership, { scopeId, observerId })
        stage = 'rpc_response_validation'
        const result = await this.lanDiscovery.readSiteLocalShellySwitchStatus({
          scopeId: zoneId, observerId, tenantId: ownership.tenantId, siteId: ownership.siteId,
          physicalId, ipAddress, component,
          expectedComponentKeys: inventory.components.map(item => item.key).filter(key => /^switch:\d+$/.test(key)),
        })
        const identity = readOnlyShellyRpcDeviceInfoFromBody(result.identityBefore, 'GET /rpc/Shelly.GetDeviceInfo')
        const identityAfter = readOnlyShellyRpcDeviceInfoFromBody(result.identityAfter, 'GET /rpc/Shelly.GetDeviceInfo')
        const values = parseShellySwitchStatus(result.statusBefore, component)
        if (result.failure || identity?.id?.toLowerCase() !== physicalId.toLowerCase() ||
            identity.gen === undefined || identity.gen < 2 || identityAfter?.id?.toLowerCase() !== physicalId.toLowerCase() ||
            identityAfter.gen === undefined || identityAfter.gen < 2 || !values) {
          throw new ConflictException('The authorized site-local RPC did not verify the enrolled Shelly identity and switch component.')
        }
        const observedAt = result.observedAt!
        const observedTime = Date.parse(observedAt)
        if (!Number.isFinite(observedTime) || observedTime > Date.now() + 30_000 || Date.now() - observedTime > 15 * 60_000) {
          throw new BadGatewayException('The site-local observer returned stale or invalid status evidence; no state was changed.')
        }
        this.logShellyObservation(correlationId, 'rpc_response_validated', 'completed', startedAt, deviceId, ownership, { scopeId, observerId })
        const source = `site-local-http-rpc:${observerId}`
        this.registry.ingestDeviceTelemetry({
          id: device.id, deviceId: device.id, tenantId: ownership.tenantId, siteId: ownership.siteId,
          displayName: device.displayName, protocol: 'http', transport: 'http', driver: 'shelly-lan',
          target: `http://${ipAddress}/rpc/Switch.GetStatus?id=${target.channel}`, location: device.zoneName,
          capabilities: device.capabilities.map(item => item.kind), values,
          state: { values, source, status: 'online', observedAt }, observedAt,
        })
        this.registry.recordObserverReachability(device.id, {
          status: 'reachable', checkedAt: observedAt,
          endpoint: `http://${ipAddress}/rpc/Switch.GetStatus?id=${target.channel}`, targetIpAddress: ipAddress,
          networkScopeId: zoneId,
          observer: { id: observerId, host: target.siteLocalObserver.host, platform: 'docker', localScopes: [] },
        }, { tenantId: device.tenantId, siteId: device.siteId })
        this.logShellyObservation(correlationId, 'operational_state_ingestion_completed', 'completed', startedAt, deviceId, ownership, { scopeId, observerId })
        return { deviceId: device.id, physicalId, component, physicalInventoryId: inventory.physicalDeviceId,
          site: ownership, output: values.on, observedAt, source,
          observer: { id: observerId, host: target.siteLocalObserver.host }, networkScopeId: zoneId }
      }

      if (zone.collectionSource === 'local') {
        const localTarget = await this.resolveAuthorizedLocalShellyStatusTarget(device, ipAddress)
        if (!localTarget || localTarget.ipAddress !== ipAddress || localTarget.zone.id !== zoneId ||
            localTarget.observer.id !== device.metadata?.siteLocalObserverId) {
          throw new ConflictException('The authorized local observer cannot verify this saved Home endpoint and scope.')
        }
        observerId = localTarget.observer.id
        this.logShellyObservation(correlationId, 'remote_execution_started', 'started', startedAt, deviceId, ownership, { scopeId, observerId })
        stage = 'rpc_response_validation'
        const observation = await this.pollAuthorizedLocalShellyStatus(device, localTarget)
        if (!observation) throw new BadGatewayException('The authorized local observer could not verify Shelly identity and read the switch status.')
        this.logShellyObservation(correlationId, 'rpc_response_validated', 'completed', startedAt, deviceId, ownership, { scopeId, observerId })
        stage = 'operational_state_ingestion_completed'
        this.logShellyObservation(correlationId, stage, 'completed', startedAt, deviceId, ownership, { scopeId, observerId })
        return {
          deviceId: device.id, physicalId, component, physicalInventoryId: inventory.physicalDeviceId,
          site: ownership, output: observation.output, observedAt: observation.observedAt,
          source: `site-local-http-rpc:${observerId}`, observer: observation.observer, networkScopeId: zoneId,
        }
      }

      const lanDiscovery = this.lanDiscovery
      if (!lanDiscovery) throw new BadGatewayException('The configured Lab observer is unavailable.')

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 18_000)
      try {
        stage = 'remote_execution'
        this.logShellyObservation(correlationId, 'remote_execution_started', 'started', startedAt, deviceId, ownership, { scopeId })
        const evidence = await lanDiscovery.readVirtualLabShellyStatusEvidence(
          zoneId, ipAddress, physicalId, inventory.components.map(item => item.key), controller.signal,
        )
        observerId = evidence.observer.id
        this.logShellyObservation(correlationId, 'remote_execution_completed', 'completed', startedAt, deviceId, ownership, { scopeId, observerId })
        stage = 'rpc_response_validation'
        if (typeof evidence.identity.id !== 'string' || evidence.identity.id.toLowerCase() !== physicalId.toLowerCase() ||
            typeof evidence.identity.gen !== 'number' || evidence.identity.gen < 2) {
          throw new ConflictException('The remote observer returned a Shelly identity that does not match the enrolled physical device.')
        }
        const expectedKeys = inventory.components.map(item => item.key).sort()
        const actualKeys = [...evidence.componentKeys].sort()
        if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
          throw new ConflictException('The remote observer component profile differs from the site-owned physical inventory.')
        }
        const status = evidence.componentStatuses.find(item => item.componentKey === component)
        const values = status ? parseShellySwitchStatus(status.body, component) : null
        if (!values) throw new BadGatewayException(`Switch.GetStatus returned a malformed or mismatched ${component} response.`)

        const observedAt = status!.observedAt
        const observedTime = Date.parse(observedAt)
        const now = Date.now()
        if (!Number.isFinite(observedTime) || observedTime > now + 60_000 || now - observedTime > 15 * 60_000) {
          throw new BadGatewayException('The remote observer returned stale or invalid collection time; no state was changed.')
        }
        this.logShellyObservation(correlationId, 'rpc_response_validated', 'completed', startedAt, deviceId, ownership, { scopeId, observerId })
        const source = `site-local-http-rpc:${evidence.observer.id}`
        stage = 'operational_state_ingestion'
        this.registry.ingestDeviceTelemetry({
          id: device.id, deviceId: device.id, tenantId: ownership.tenantId, siteId: ownership.siteId,
          displayName: device.displayName, protocol: 'http', transport: 'http', driver: 'shelly-lan',
          target: `http://${ipAddress}/rpc/Switch.GetStatus?id=${target.channel}`, location: device.zoneName,
          capabilities: device.capabilities.map(item => item.kind), values,
          state: { values, source, status: 'online', observedAt }, observedAt,
        })
        this.registry.recordObserverReachability(device.id, {
          status: 'reachable', checkedAt: observedAt,
          endpoint: `http://${ipAddress}/rpc/Switch.GetStatus?id=${target.channel}`, targetIpAddress: ipAddress,
          networkScopeId: zoneId,
          observer: { id: evidence.observer.id, host: evidence.observer.host, platform: 'docker', localScopes: [] },
        }, { tenantId: device.tenantId, siteId: device.siteId })
        stage = 'operational_state_ingestion_completed'
        this.logShellyObservation(correlationId, stage, 'completed', startedAt, deviceId, ownership, { scopeId, observerId })
        return {
          deviceId: device.id, physicalId, component, physicalInventoryId: inventory.physicalDeviceId,
          site: ownership, output: values.on, observedAt, source,
          observer: evidence.observer, networkScopeId: zoneId,
        }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new BadGatewayException(
            'The bounded remote Shelly status observation exceeded its 18-second deadline; no state was changed.',
            { cause: error },
          )
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      this.logShellyObservation(correlationId, stage, 'failed', startedAt, deviceId, ownership, {
        ...(scopeId ? { scopeId } : {}), ...(observerId ? { observerId } : {}),
        failureCategory: shellyObservationFailureCategory(stage, error),
        error: safeShellyObservationError(error),
      })
      throw error
    }
  }

  private logShellyObservation(
    correlationId: string,
    stage: string,
    outcome: 'started' | 'completed' | 'failed',
    startedAt: number,
    deviceId: string,
    ownership: { tenantId: string; siteId: string },
    details: Record<string, unknown> = {},
  ): void {
    const record = {
      event: 'shelly_status_observation', correlationId, stage, outcome,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      deviceId, tenantId: ownership.tenantId, siteId: ownership.siteId, ...details,
    }
    const message = JSON.stringify(record)
    if (outcome === 'failed') this.logger.error(message)
    else this.logger.log(message)
  }

}

function shellyObservationFailureCategory(stage: string, error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  if (code.startsWith('VIRTUAL_LAB_SHELLY_')) return code.toLowerCase()
  if (stage === 'enrollment_and_inventory_validation' || stage === 'saved_endpoint_observer_scope_validation') {
    return 'precondition_failed'
  }
  if (stage === 'remote_execution') return 'remote_execution_failed'
  if (stage === 'rpc_response_validation') return 'rpc_response_rejected'
  if (stage === 'operational_state_ingestion') return 'state_ingestion_failed'
  return 'unexpected_failure'
}

function safeShellyObservationError(error: unknown): Array<Record<string, string | number>> {
  const details: Array<Record<string, string | number>> = []
  const visited = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !visited.has(current) && details.length < 4) {
    visited.add(current)
    const value = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
    const entry: Record<string, string | number> = {
      type: safeDiagnosticToken(value.name, 'Error'),
    }
    if (typeof value.code === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(value.code)) entry.code = value.code
    else if (typeof value.code === 'number' && Number.isInteger(value.code) && value.code >= 0 && value.code <= 255) entry.code = value.code
    if (typeof value.message === 'string') {
      const firstLine = value.message.split(/\r?\n/, 1)[0]
      const safeMessage = firstLine
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
        .replace(/\b(password|passwd|secret|token|authorization|credential|api[_-]?key)(\s*(?:[=:]|\s)\s*)\S+/gi, '$1$2[redacted]')
        .slice(0, 180)
      if (safeMessage) entry.message = safeMessage
    }
    details.push(entry)
    current = value.cause
  }
  return details
}

function safeDiagnosticToken(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)
    ? value
    : fallback
}

function isHttpTarget(value: string | undefined): value is string {
  return !!value && /^https?:\/\//.test(value)
}



function httpTargetWithinZone(value: string | undefined, zone: NetworkDiscoveryZone): boolean {
  if (!isHttpTarget(value)) return false
  try {
    const host = new URL(value).hostname
    if (isIP(host) !== 4) return false
    return zone.cidr ? ipInCidr(host, zone.cidr) : zone.seedIps.includes(host)
  } catch { return false }
}
