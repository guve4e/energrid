import { BadGatewayException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional, Inject } from '@nestjs/common'
import { DeviceRegistryService } from './device-registry.service'
import type { NetworkDiscoveryZone, NetworkDiscoveredDevice, RegisteredDevice } from './device-registry.types'
import type { KnownNetworkDevice } from './device-discovery-memory.store'
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { DeviceLanDiscoveryService, ipInCidr } from './device-lan-discovery.service'
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime'
import {
  ENERGRID_HTTP_OBSERVATION_SOURCE,
  ENERGRID_HTTP_STATUS_SELECTOR,
  ENERGRID_SAMPLE_CURSOR_SOURCE,
  energridFirmwareSampleEvidenceId,
  parseEnergridHttpSample,
  resolveEnrolledEnergridHttpEndpoint,
  resolveEnergridHttpEndpoint,
} from './adapters/inbound/energrid/energrid-http-observation.adapter'
import { parseEnergridIdentity } from './adapters/outbound/network/energrid-http-identity.adapter'
import {
  DeviceFirmwareDiagnosticsService,
  type FirmwareDiagnosticCollectionContext,
  type FirmwareDiagnosticFailureReason,
} from './device-firmware-diagnostics'
import { EnergridFirmwareDiagnosticsHttpAdapter, FirmwareDiagnosticsCollectionError } from './adapters/outbound/network/energrid-firmware-diagnostics-http.adapter'
import { performance } from 'node:perf_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { parseShellySwitchStatus } from './adapters/inbound/shelly/shelly-switch-status'
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from './enrollment/physical-device-inventory.token'
import type { PhysicalDeviceInventoryService } from './enrollment/physical-device-inventory.service'
import { hasPhysicalDeviceIdentityClaim } from './enrollment/physical-device-inventory.repository'
import type { RemoteShellyObserverRuntime, RemoteShellyStatusAssignment, RemoteShellyStatusObserverHandle } from './adapters/outbound/network/virtual-lab-network-evidence.adapter'
import { configuredSiteLocalObservers, selectAuthorizedSiteLocalObserver, type AuthorizedSiteLocalObserver } from './site-local-shelly-evidence-intake'

interface AuthorizedRemoteShellyStatusTarget {
  assignmentKey: string
  device: RegisteredDevice
  tenantId: string
  siteId: string
  physicalId: string
  physicalInventoryId: string
  component: string
  ipAddress: string
  scopeId: string
  expectedComponentKeys: string[]
  targetKey: string
}

interface RemoteShellyObserverState {
  key: string
  sessionId: string
  scopeId: string
  owner: { tenantId: string; siteId: string }
  observer?: RemoteShellyObserverRuntime
  handle?: RemoteShellyStatusObserverHandle
  assignmentMap: Map<string, AuthorizedRemoteShellyStatusTarget>
  lastObservedAtByAssignmentKey: Map<string, number>
  configHash: string
  lastSequence: number
  failedStarts: number
  retryAt: number
}

interface AuthorizedLocalShellyStatusTarget {
  device: RegisteredDevice
  observer: AuthorizedSiteLocalObserver
  physicalId: string
  component: string
  channel: number
  ipAddress: string
  zone: NetworkDiscoveryZone
  interfaceAddress: string
}

interface AcceptedShellyStatusObservation {
  output: boolean
  observedAt: string
  observer: { id: string; host: string }
}

@Injectable()
export class DeviceHttpPollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceHttpPollService.name)
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private readonly diagnosticsPollAt = new Map<string, number>()
  private readonly firmwareDiagnosticsAdapter = new EnergridFirmwareDiagnosticsHttpAdapter()
  private remoteAssignmentRefreshAt = 0
  private refreshingRemoteAssignments = false
  private readonly remoteShellyObservers = new Map<string, RemoteShellyObserverState>()
  private readonly localShellyResolutionWarnings = new Set<string>()

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly observations?: ApprovedMqttObservationRuntime,
    private readonly discovery?: DeviceDiscoveryMemoryStore,
    private readonly lanDiscovery?: DeviceLanDiscoveryService,
    private readonly firmwareDiagnostics?: DeviceFirmwareDiagnosticsService,
    @Optional() @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
  ) {}

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
    for (const observer of this.remoteShellyObservers.values()) observer.handle?.close()
    this.remoteShellyObservers.clear()
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return
    this.polling = true

    try {
      const devices = this.registry
        // Poll approved installations for every authorized site, regardless
        // of which site a Portal user currently has selected.
        .getDevices(true)
        .filter((device) => device.trustStatus === 'approved')
        // Energrid's adapter stays unconfigured until observation approval.
        // Its persisted installation binding is checked by trusted ingress.
        .filter((device) => device.adapter.configured || device.adapter.driver === 'energrid-esp8266')
        .filter((device) => device.adapter.protocol === 'http')
        .filter((device) => device.adapter.driver === 'shelly-lan' || isHttpTarget(device.adapter.target))

      const localShellyDevices = this.registry.getDevices(true).filter(device =>
        device.trustStatus === 'approved' && device.kind === 'physical' &&
        ['shelly-lan', 'shelly-discovered'].includes(device.adapter.driver) &&
        /^shelly[a-z0-9._-]{1,114}:(?:switch|em1):(?:[0-9]|[12][0-9]|3[01])$/i.test(device.id),
      )

      await Promise.all(devices.map((device) => this.pollDevice(device)))
      await Promise.all(localShellyDevices.map(device => this.pollAuthorizedLocalShellyStatus(device)))
      // The HTTP-only `devices` list excludes MQTT-profile Shelly installations,
      // even though their verified site-owned endpoint can still be observed by
      // this read-only RPC collector. Use the enrolled Shelly component list.
      await this.refreshRemoteShellyObservers(localShellyDevices)
    } finally {
      this.polling = false
    }
  }

  private async pollDevice(device: RegisteredDevice): Promise<void> {
    if (device.adapter.driver === 'energrid-esp8266') {
      await this.pollEnergridDevice(device)
      return
    }

    if (device.adapter.driver === 'shelly-lan') {
      const zone = this.configuredShellyZone(device)
      // Never fall back to an API-host request when the installation has no
      // configured scope or belongs to a remote observer.
      if (!zone || (zone.collectionSource ?? 'local') !== 'local' || !httpTargetWithinZone(device.adapter.target, zone)) return
    }

    const target = device.adapter.target
    if (!isHttpTarget(target)) return

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), httpPollTimeoutMs())

    try {
      const startedAt = Date.now()
      const observedAt = new Date().toISOString()
      const response = await fetch(target, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        // A failed API-host request is an observer-relative failure, not a
        // device-reported state. Preserve the last valid Shelly state; its
        // timestamp will age naturally in the Portal.
        if (device.adapter.driver !== 'shelly-lan') this.registry.ingestDeviceStatus({
          deviceId: device.id,
          status: 'offline',
          observedAt: new Date().toISOString(),
        })
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} status=${response.status}`)
        return
      }

      const json = await response.json()
      const values = device.adapter.driver === 'shelly-lan'
        ? parseShellySwitchStatus(json, String(device.metadata?.component || ''))
        : normalizeHttpValues(json)
      if (device.adapter.driver === 'shelly-lan' && !values) {
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=invalid_shelly_switch_status`)
        return
      }
      this.registry.ingestDeviceTelemetry({
        deviceId: device.id,
        name: device.displayName,
        protocol: 'http',
        transport: 'http',
        driver: device.adapter.driver,
        target,
        location: device.zoneName,
        capabilities: device.capabilities.map((capability) => capability.kind),
        values,
        state: {
          values,
          source: 'http-poll',
          status: 'online',
        },
        observedAt,
      })
      this.logger.log(`[DEVICE HTTP POLL] ${device.id} ${Date.now() - startedAt}ms`)
    } catch (error) {
      if (device.adapter.driver !== 'shelly-lan') this.registry.ingestDeviceStatus({
        deviceId: device.id,
        status: 'offline',
        observedAt: new Date().toISOString(),
      })
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} ${error instanceof Error ? error.message : 'failed'}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async pollAuthorizedLocalShellyStatus(
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
    const identityUrl = `http://${ipAddress}/rpc/Shelly.GetDeviceInfo`
    const statusUrl = `http://${ipAddress}/rpc/Switch.GetStatus?id=${channel}`
    try {
      const identityResponse = await fetch(identityUrl, {
        signal: controller.signal, redirect: 'manual', cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      })
      if (identityResponse.status !== 200) throw new Error(`identity_http_${identityResponse.status}`)
      const identity = asJsonObject(await readJsonResponse(identityResponse, 4 * 1024))
      if (String(identity?.id || '').toLowerCase() !== physicalId.toLowerCase() ||
          typeof identity?.gen !== 'number' || identity.gen < 2) {
        throw new Error('identity_mismatch')
      }
      const statusResponse = await fetch(statusUrl, {
        signal: controller.signal, redirect: 'manual', cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      })
      if (statusResponse.status !== 200) throw new Error(`status_http_${statusResponse.status}`)
      const observedAt = new Date().toISOString()
      const values = parseShellySwitchStatus(await readJsonResponse(statusResponse, 4 * 1024), component)
      if (!values) throw new Error('invalid_switch_status')
      const endpoint = statusUrl
      const localScopes = [{
        interfaceName: observer.interfaceName!, cidr: zone.cidr!, address: target.interfaceAddress,
      }]
      this.registry.recordObserverReachability(device.id, {
        status: 'reachable', checkedAt: observedAt, endpoint, targetIpAddress: ipAddress,
        networkScopeId: zone.id,
        observer: { id: observer.id, host: observer.host, platform: process.platform, localScopes },
      })
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
      })
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

  private async resolveAuthorizedLocalShellyStatusTarget(
    device: RegisteredDevice,
    expectedIpAddress?: string,
  ): Promise<AuthorizedLocalShellyStatusTarget | null> {
    const reject = (reason: string, context: Record<string, string | number | boolean> = {}): null => {
      const key = `${device.id}:${reason}`
      if (!this.localShellyResolutionWarnings.has(key)) {
        this.localShellyResolutionWarnings.add(key)
        this.logger.warn(JSON.stringify({
          event: 'shelly_operational_status_poll', outcome: 'skipped', deviceId: device.id,
          failureCategory: reason, ...context,
        }))
      }
      return null
    }
    if (!this.discovery || !this.lanDiscovery || !this.physicalInventory ||
        device.kind !== 'physical' || device.trustStatus !== 'approved' ||
        !device.tenantId || !device.siteId) return reject('observation_dependencies_or_enrollment_missing')
    const physicalId = String(device.metadata?.physicalId || '')
    const component = String(device.metadata?.component || '')
    const match = /^(switch):(0|[1-9]|[12][0-9]|3[01])$/.exec(component)
    if (!/^shelly[a-z0-9._-]{1,114}$/i.test(physicalId) || !match ||
        device.id !== `${physicalId}:${component}`) return reject('identity_or_component_binding_invalid')
    const installationScope = String(device.metadata?.networkScope || '').trim()
    const installationScopeId = installationScope.includes(':')
      ? installationScope.slice(installationScope.lastIndexOf(':') + 1)
      : installationScope
    let observers: AuthorizedSiteLocalObserver[]
    try { observers = configuredSiteLocalObservers() } catch { return reject('observer_configuration_invalid') }
    const matchingScopeIds = [...new Set(observers.filter(item => item.tenantId === device.tenantId && item.siteId === device.siteId &&
      (item.scopeId === installationScopeId || item.cidr === installationScope || installationScope.endsWith(`:${item.cidr}`)))
      .map(item => item.scopeId))]
    if (matchingScopeIds.length !== 1) return reject(matchingScopeIds.length ? 'site_scope_authorization_ambiguous' : 'site_scope_authorization_missing', {
      tenantSiteScopeMatchCount: matchingScopeIds.length,
    })
    const scopeId = matchingScopeIds[0]
    const selection = selectAuthorizedSiteLocalObserver({ observers, tenantId: device.tenantId,
      siteId: device.siteId, scopeId, physicalId, component })
    if (!selection.observer) return reject(selection.reason, {
      tenantSiteObserverCount: observers.filter(item => item.tenantId === device.tenantId && item.siteId === device.siteId &&
        (item.scopeId === scopeId || item.cidr === installationScope || installationScope.endsWith(`:${item.cidr}`))).length,
      installationTenantId: device.tenantId,
      installationSiteId: device.siteId,
      installationScopeId: scopeId === installationScope ? 'cidr' : scopeId,
    })
    const observer = selection.observer
    const selectedScopeId = observer.scopeId
    if (!observer.interfaceName) return reject('component_or_interface_not_explicitly_authorized')
    const zone = this.lanDiscovery.getConfiguredZone(selectedScopeId)
    if (!zone || zone.collectionSource === 'virtual-lab' || zone.cidr !== observer.cidr || !zone.cidr ||
        (installationScopeId !== observer.scopeId && installationScope !== observer.cidr &&
          !installationScope.endsWith(`:${observer.cidr}`))) {
      return reject('scope_not_authorized_for_local_observation')
    }
    const runtimeHost = normalizedObserverHost(hostname())
    if (runtimeHost !== normalizedObserverHost(observer.host)) return reject('observer_host_mismatch')
    const addresses = networkInterfaces()[observer.interfaceName!] || []
    const matchingAddresses = addresses.filter(address => !address.internal && address.family === 'IPv4' &&
      networkInterfaceMatchesCidr(address.address, address.netmask, observer.cidr))
    if (matchingAddresses.length !== 1) return reject('observer_interface_scope_mismatch')
    const inventory = await this.physicalInventory.forLogicalDevice(
      { tenantId: device.tenantId, siteId: device.siteId }, device.id,
    )
    const inventoryId = String(device.metadata?.physicalInventoryId || '')
    const inventoryChecks = {
      inventoryFound: !!inventory,
      // The site-owned inventory lookup and its logical assignment are
      // authoritative. Some imported installation rows omit this optional
      // metadata mirror; if present, it must still match exactly.
      inventoryIdMatches: !!inventory && (!inventoryId || inventory.physicalDeviceId === inventoryId),
      siteOwnerMatches: !!inventory && inventory.scope.tenantId === device.tenantId && inventory.scope.siteId === device.siteId,
      physicalIdentityClaimMatches: !!inventory && hasPhysicalDeviceIdentityClaim(inventory, 'mqtt:shelly-protocol-id', physicalId),
      componentExists: !!inventory && inventory.components.some(item => item.key === component),
      logicalAssignmentMatches: !!inventory && inventory.assignments.some(item => item.deviceId === device.id &&
        item.physicalDeviceId === inventory.physicalDeviceId && item.componentKey === component),
    }
    if (Object.values(inventoryChecks).some(check => !check)) {
      return reject('physical_inventory_assignment_mismatch', {
        ...inventoryChecks,
        expectedPhysicalInventoryId: inventoryId || 'missing',
        resolvedPhysicalInventoryId: inventory?.physicalDeviceId || 'missing',
      })
    }
    const records = await this.discovery.listIdentityEvidence({ tenantId: device.tenantId, siteId: device.siteId })
    const endpoints = [...new Map(records.filter(record => {
      const observations = record.device.observations || []
      const identityAt = new Set(observations.filter(item => item.source === 'http_identity' &&
        item.attribute === 'identity.device_id' && typeof item.value === 'string' &&
        item.value.toLowerCase() === physicalId.toLowerCase() &&
        item.scopeId === scopeId && item.method === 'GET /rpc/Shelly.GetDeviceInfo').map(item => item.observedAt))
      return record.ownership?.tenantId === device.tenantId && record.ownership.siteId === device.siteId &&
        record.device.vendor === 'Shelly' && record.device.id.toLowerCase() === physicalId.toLowerCase() &&
        record.device.networkZoneId === scopeId && record.device.protocol === 'http' &&
        (!expectedIpAddress || record.device.ipAddress === expectedIpAddress) &&
        ipInCidr(record.device.ipAddress, observer.cidr) &&
        observations.some(item => item.source === 'http_identity' && item.attribute === 'identity.verified' &&
          item.value === true && identityAt.has(item.observedAt)) &&
        observations.some(item => item.source === 'site_local_http_rpc' && item.attribute === 'observer.identity' &&
          item.value === observer.id && item.scopeId === scopeId && item.interfaceName === observer.interfaceName) &&
        observations.some(item => item.source === 'site_local_http_rpc' && item.attribute === 'shelly.component_status' &&
          item.value === component && item.scopeId === scopeId && item.interfaceName === observer.interfaceName &&
          item.method === `Switch.GetStatus?id=${match[2]}`)
    }).map(record => [`${record.device.networkZoneId}:${record.device.ipAddress}`, record])).values()]
    if (endpoints.length !== 1) return reject(endpoints.length === 0
      ? 'saved_identity_or_component_evidence_missing'
      : 'saved_endpoint_ambiguous')
    return {
      device, observer, physicalId, component, channel: Number(match[2]),
      ipAddress: endpoints[0].device.ipAddress, zone, interfaceAddress: matchingAddresses[0].address,
    }
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

  private async refreshRemoteShellyObservers(devices: RegisteredDevice[]): Promise<void> {
    const now = Date.now()
    if (this.refreshingRemoteAssignments || now - this.remoteAssignmentRefreshAt < 15_000) return
    if (!this.lanDiscovery || !this.physicalInventory || !this.discovery) return
    this.refreshingRemoteAssignments = true
    this.remoteAssignmentRefreshAt = now
    try {
      const groups = new Map<string, {
        owner: { tenantId: string; siteId: string }
        scopeId: string
        transport: 'virtual-lab' | 'site-local-ssh'
        siteLocalObserver?: AuthorizedSiteLocalObserver
        assignments: Map<string, AuthorizedRemoteShellyStatusTarget>
        remoteTargets: Map<string, RemoteShellyStatusAssignment>
      }>()
      const candidates = devices.filter(device => ['shelly-lan', 'shelly-discovered'].includes(device.adapter.driver))
      for (const device of candidates) {
        const owner = { tenantId: device.tenantId, siteId: device.siteId }
        try {
          const target = await this.resolveShellyInstallationTarget(device.id, owner)
          let transport: 'virtual-lab' | 'site-local-ssh'
          let siteLocalObserver: AuthorizedSiteLocalObserver | undefined
          if (target.zone.collectionSource === 'virtual-lab') {
            transport = 'virtual-lab'
          } else {
            if ((target.device.metadata?.siteLocalObserverId || '') === '') continue
            const observers = configuredSiteLocalObservers()
            const selection = selectAuthorizedSiteLocalObserver({ observers,
              tenantId: owner.tenantId, siteId: owner.siteId, scopeId: target.zone.id,
              physicalId: target.physicalId, component: target.component })
            if (!selection.observer || selection.observer.id !== target.device.metadata?.siteLocalObserverId) {
              throw new ConflictException(selection.observer ? 'The reconciled endpoint belongs to a different authorized observer.' : selection.reason)
            }
            siteLocalObserver = selection.observer
            if (normalizedObserverHost(hostname()) === normalizedObserverHost(siteLocalObserver.host)) continue
            if (!siteLocalObserver.sshTarget || !siteLocalObserver.interfaceName ||
                siteLocalObserver.cidr !== target.zone.cidr || !target.zone.cidr) {
              throw new ConflictException('The authorized remote observer has no explicit secure SSH execution target, interface, or matching scope.')
            }
            transport = 'site-local-ssh'
          }
          const expectedComponentKeys = target.inventory.components
            .map(component => component.key)
            .filter(component => /^switch:\d+$/.test(component))
            .sort()
          if (!expectedComponentKeys.includes(target.component)) continue
          const groupKey = `${owner.tenantId}\u0000${owner.siteId}\u0000${target.zone.id}\u0000${transport}\u0000${siteLocalObserver?.id || 'virtual-lab'}`
          const group = groups.get(groupKey) || {
            owner, scopeId: target.zone.id, transport, ...(siteLocalObserver ? { siteLocalObserver } : {}),
            assignments: new Map<string, AuthorizedRemoteShellyStatusTarget>(),
            remoteTargets: new Map<string, RemoteShellyStatusAssignment>(),
          }
          const targetKey = createHash('sha256').update(JSON.stringify([
            owner.tenantId, owner.siteId, target.zone.id, target.inventory.physicalDeviceId,
            target.physicalId, target.ipAddress, expectedComponentKeys,
          ])).digest('hex').slice(0, 32)
          const assignmentKey = createHash('sha256').update(JSON.stringify([
            targetKey, device.id, target.component,
          ])).digest('hex').slice(0, 32)
          const authorized: AuthorizedRemoteShellyStatusTarget = {
            assignmentKey, device, tenantId: owner.tenantId, siteId: owner.siteId,
            physicalId: target.physicalId, physicalInventoryId: target.inventory.physicalDeviceId,
            component: target.component, ipAddress: target.ipAddress, scopeId: target.zone.id,
            expectedComponentKeys, targetKey,
          }
          group.assignments.set(assignmentKey, authorized)
          const remoteTarget = group.remoteTargets.get(targetKey) || {
            key: targetKey, physicalId: target.physicalId, ipAddress: target.ipAddress,
            expectedComponentKeys,
            components: [],
          }
          if (!remoteTarget.components.some(item => item.assignmentKey === assignmentKey))
            remoteTarget.components.push({ assignmentKey, componentKey: target.component })
          group.remoteTargets.set(targetKey, remoteTarget)
          groups.set(groupKey, group)
        } catch (error) {
          this.logger.warn(JSON.stringify({ event: 'remote_shelly_observer_assignment', outcome: 'rejected',
            deviceId: device.id, failureCategory: safeRemoteAssignmentFailure(error) }))
        }
      }

      for (const [key, current] of this.remoteShellyObservers) {
        if (groups.has(key)) continue
        current.handle?.close()
        this.remoteShellyObservers.delete(key)
      }

      for (const [key, group] of groups) {
        const assignments = [...group.remoteTargets.values()]
          .map(target => ({ ...target, components: [...target.components].sort((a, b) => a.componentKey.localeCompare(b.componentKey)) }))
          .sort((a, b) => a.key.localeCompare(b.key))
        const configHash = JSON.stringify(assignments)
        let session = this.remoteShellyObservers.get(key)
        if (session?.handle?.isAlive()) {
          if (session.configHash !== configHash) {
            const nextMap = new Map(group.assignments)
            if (session.handle.update(assignments)) {
              session.assignmentMap = nextMap
              session.configHash = configHash
            } else {
              session.handle.close()
            }
          }
          continue
        }
        if (session && session.retryAt > now) continue
        if (!session) {
          session = {
            key, sessionId: randomUUID(), scopeId: group.scopeId, owner: group.owner,
            assignmentMap: new Map(group.assignments), configHash: '', lastSequence: 0,
            lastObservedAtByAssignmentKey: new Map(),
            failedStarts: 0, retryAt: 0,
          }
          this.remoteShellyObservers.set(key, session)
        }
        session.assignmentMap = new Map(group.assignments)
        session.scopeId = group.scopeId
        session.owner = group.owner
        session.sessionId = randomUUID()
        session.lastSequence = 0
        session.lastObservedAtByAssignmentKey.clear()
        try {
          const onMessage = (message: unknown) => this.acceptRemoteShellyMessage(session!, message)
          const onExit = (reason: 'spawn_failed' | 'runner_exited') => this.handleRemoteShellyObserverExit(session!, reason)
          const started = group.transport === 'site-local-ssh' && group.siteLocalObserver
            ? await this.lanDiscovery.startSiteLocalShellyOperationalObserver(group.scopeId, group.siteLocalObserver,
              session.sessionId, assignments, onMessage, onExit)
            : await this.lanDiscovery.startRemoteShellyOperationalObserver(
              group.scopeId, session.sessionId, assignments, onMessage, onExit)
          session.handle = started.handle
          session.observer = started.observer
          if (group.transport === 'virtual-lab' && !started.handle.update(assignments)) {
            started.handle.close()
            throw new Error('Remote observer rejected authorized assignments.')
          }
          session.configHash = configHash
          session.failedStarts = 0
          session.retryAt = 0
          this.logger.log(`[REMOTE SHELLY OBSERVER] started scope=${group.scopeId} assignments=${group.assignments.size} observer=${started.observer.id}`)
        } catch (error) {
          session.handle = undefined
          session.failedStarts += 1
          session.retryAt = now + Math.min(30_000, 1_000 * (2 ** Math.min(session.failedStarts, 5)))
          this.logger.warn(`[REMOTE SHELLY OBSERVER] start failed scope=${group.scopeId} reason=${safeRemoteObserverError(error)} retryMs=${session.retryAt - now}`)
        }
      }
    } finally {
      this.refreshingRemoteAssignments = false
    }
  }

  private handleRemoteShellyObserverExit(
    session: RemoteShellyObserverState,
    reason: 'spawn_failed' | 'runner_exited',
  ): void {
    if (this.remoteShellyObservers.get(session.key) !== session) return
    session.failedStarts += 1
    session.retryAt = Date.now() + Math.min(30_000, 1_000 * (2 ** Math.min(session.failedStarts, 5)))
    this.logger.warn(`[REMOTE SHELLY OBSERVER] stopped scope=${session.scopeId} reason=${reason} retryMs=${session.retryAt - Date.now()}`)
  }

  private acceptRemoteShellyMessage(session: RemoteShellyObserverState, message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected malformed output scope=${session.scopeId}`)
      return
    }
    const event = message as Record<string, unknown>
    if (event.schemaVersion !== 1 || !['observation', 'failure'].includes(String(event.kind)) ||
        event.observerSessionId !== session.sessionId || event.scopeId !== session.scopeId ||
        !Number.isInteger(event.sequence) || (event.sequence as number) <= session.lastSequence ||
        event.observationId !== `${session.sessionId}:${event.sequence}`) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected stale or malformed event scope=${session.scopeId}`)
      return
    }
    const assignmentKey = String(event.assignmentKey || '')
    const assignment = session.assignmentMap.get(assignmentKey)
    if (!assignment || event.targetKey !== assignment.targetKey || event.ipAddress !== assignment.ipAddress ||
        event.physicalId !== assignment.physicalId || event.componentKey !== assignment.component) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected unassigned event scope=${session.scopeId}`)
      return
    }
    session.lastSequence = event.sequence as number
    const observer = session.observer
    if (!observer) return
    if (event.kind === 'failure') {
      const checkedAt = typeof event.checkedAt === 'string' && freshRemoteTimestamp(event.checkedAt, 30_000)
        ? event.checkedAt : new Date().toISOString()
      const reason = safeRemoteFailureCode(event.reasonCode)
      this.logger.warn(JSON.stringify({ event: 'remote_shelly_operational_observation', outcome: 'observer_failure',
        deviceId: assignment.device.id, observerId: observer.id, scopeId: assignment.scopeId,
        component: assignment.component, observationId: String(event.observationId), reason, checkedAt }))
      this.registry.recordObserverReachability(assignment.device.id, {
        status: 'unreachable', checkedAt,
        endpoint: `http://${assignment.ipAddress}/rpc/Switch.GetStatus?id=${assignment.component.split(':')[1]}`,
        targetIpAddress: assignment.ipAddress, networkScopeId: assignment.scopeId,
        observer: { id: observer.id, host: observer.host, platform: observer.platform, localScopes: observer.localScopes },
        reason,
      })
      return
    }
    const status = event.body
    const identity = event.identity
    const keys = event.componentKeys
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
        (identity as Record<string, unknown>).id !== assignment.physicalId ||
        typeof (identity as Record<string, unknown>).gen !== 'number' || ((identity as Record<string, unknown>).gen as number) < 2 ||
        !Array.isArray(keys) || keys.length !== assignment.expectedComponentKeys.length ||
        [...keys].sort().some((key, index) => key !== assignment.expectedComponentKeys[index]) ||
        !freshRemoteTimestamp(String(event.observedAt || ''), 30_000)) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected identity, component, or timestamp scope=${session.scopeId} device=${assignment.device.id}`)
      return
    }
    const values = parseShellySwitchStatus(status, assignment.component)
    if (!values) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected status scope=${session.scopeId} device=${assignment.device.id}`)
      return
    }
    const observedAt = String(event.observedAt)
    const observedTime = Date.parse(observedAt)
    const previousRemoteTime = session.lastObservedAtByAssignmentKey.get(assignmentKey)
    if (previousRemoteTime !== undefined && observedTime <= previousRemoteTime) return
    const current = this.registry.getDevices(true).find(device => device.id === assignment.device.id &&
      device.tenantId === assignment.tenantId && device.siteId === assignment.siteId)?.state?.observedAt
    const currentTime = current ? Date.parse(current) : Number.NaN
    if (Number.isFinite(currentTime) && Date.parse(observedAt) <= currentTime) return
    const source = `site-local-http-rpc:${observer.id}`
    const endpoint = `http://${assignment.ipAddress}/rpc/Switch.GetStatus?id=${assignment.component.split(':')[1]}`
    this.registry.ingestDeviceTelemetry({
      id: assignment.device.id, deviceId: assignment.device.id,
      tenantId: assignment.tenantId, siteId: assignment.siteId,
      displayName: assignment.device.displayName, protocol: 'http', transport: 'http', driver: 'shelly-lan',
      target: endpoint, location: assignment.device.zoneName,
      capabilities: assignment.device.capabilities.map(item => item.kind),
      values, state: { values, source, status: 'online', observedAt }, observedAt,
      observationId: String(event.observationId),
    })
    this.logger.log(JSON.stringify({ event: 'remote_shelly_operational_observation', outcome: 'submitted_to_canonical_writer',
      deviceId: assignment.device.id, observerId: observer.id, scopeId: assignment.scopeId,
      component: assignment.component, observationId: String(event.observationId), observedAt }))
    session.lastObservedAtByAssignmentKey.set(assignmentKey, observedTime)
    this.registry.recordObserverReachability(assignment.device.id, {
      status: 'reachable', checkedAt: observedAt, endpoint,
      targetIpAddress: assignment.ipAddress, networkScopeId: assignment.scopeId,
      observer: { id: observer.id, host: observer.host, platform: observer.platform, localScopes: observer.localScopes },
    })
  }

  /** Resolve a command target only from the enrolled installation and saved site-owned RPC evidence. */
  async resolveShellyControlTarget(
    deviceId: string,
    ownership: { tenantId: string; siteId: string },
    onStage?: (stage: 'enrollment_and_inventory_validation' | 'enrollment_inventory_validated' | 'saved_endpoint_observer_scope_validation' | 'saved_endpoint_observer_scope_validated') => void,
  ) {
    const target = await this.resolveShellyInstallationTarget(deviceId, ownership, onStage)
    if (target.zone.collectionSource === 'local') {
      const localTarget = await this.resolveAuthorizedLocalShellyStatusTarget(target.device, target.ipAddress)
      if (!localTarget || localTarget.ipAddress !== target.ipAddress || localTarget.zone.id !== target.zone.id) {
        throw new ConflictException('The configured local observer cannot verify this Shelly endpoint in its authorized interface and scope.')
      }
      if (target.device.metadata?.siteLocalObserverId !== localTarget.observer.id) {
        throw new ConflictException('The reconciled endpoint evidence belongs to a different observer; review network identity before enabling switching.')
      }
    }
    return target
  }

  /** Resolve the enrolled site-owned endpoint/evidence independently from an executable command transport. */
  private async resolveShellyInstallationTarget(
    deviceId: string,
    ownership: { tenantId: string; siteId: string },
    onStage?: (stage: 'enrollment_and_inventory_validation' | 'enrollment_inventory_validated' | 'saved_endpoint_observer_scope_validation' | 'saved_endpoint_observer_scope_validated') => void,
  ) {
    onStage?.('enrollment_and_inventory_validation')
    await this.registry.ensureInstallationsLoaded()
    const matches = this.registry.getDevices(true).filter(device => device.id === deviceId)
    const device = matches.find(item => item.tenantId === ownership.tenantId && item.siteId === ownership.siteId)
    if (!device) throw new NotFoundException('No Shelly installation exists in the selected site.')
    if (matches.some(item => item.tenantId !== ownership.tenantId || item.siteId !== ownership.siteId)) {
      throw new ConflictException('The Shelly identity is also registered outside the selected site.')
    }
    const physicalId = String(device.metadata?.physicalId || '')
    const component = String(device.metadata?.component || '')
    const channel = device.metadata?.channel
    if (device.kind !== 'physical' || device.trustStatus !== 'approved' ||
        !['shelly-lan', 'shelly-discovered'].includes(device.adapter.driver) ||
        !['http', 'mqtt'].includes(device.adapter.protocol) ||
        !device.adapter.configured || !/^shelly[a-z0-9._-]{1,114}$/i.test(physicalId) ||
        !/^switch:\d+$/.test(component) || !Number.isInteger(channel) ||
        component !== `switch:${channel}` || device.id !== `${physicalId}:${component}`) {
      throw new ConflictException('Only an approved, configured Shelly switch installation is supported.')
    }
    if (!this.physicalInventory || !this.discovery || !this.lanDiscovery) {
      throw new BadGatewayException('Site-owned Shelly identity and endpoint evidence is unavailable.')
    }
    const inventory = await this.physicalInventory.forLogicalDevice(ownership, deviceId)
    if (!inventory || inventory.scope.tenantId !== ownership.tenantId || inventory.scope.siteId !== ownership.siteId ||
        !hasPhysicalDeviceIdentityClaim(inventory, 'mqtt:shelly-protocol-id', physicalId) ||
        !inventory.components.some(item => item.key === component) ||
        !inventory.assignments.some(item => item.deviceId === deviceId &&
          item.physicalDeviceId === inventory.physicalDeviceId && item.componentKey === component) ||
        (device.metadata?.physicalInventoryId !== undefined &&
          device.metadata.physicalInventoryId !== inventory.physicalDeviceId)) {
      throw new ConflictException('The switch has no exact same-site physical inventory assignment.')
    }
    const decision = await this.registry.getShellyReconciliationTargetDecision(
      ownership.tenantId, ownership.siteId, deviceId, physicalId, component, inventory.physicalDeviceId,
    )
    if (!decision.matched) throw new ConflictException(`Shelly route rejected (${decision.reasonCode}).`)
    onStage?.('enrollment_inventory_validated')

    onStage?.('saved_endpoint_observer_scope_validation')
    const savedScope = String(device.metadata?.networkScope || '').trim()
    const scopeParts = savedScope.split(':').reverse()
    const zone = scopeParts
      .map(part => this.lanDiscovery?.getConfiguredZone(part))
      .find((candidate): candidate is NetworkDiscoveryZone => Boolean(candidate))
    if (!zone || !scopeMatchesConfiguredZone(savedScope, zone)) {
      throw new ConflictException('The saved endpoint does not belong to a configured installation network scope.')
    }

    // Discovery Memory is an audit history. Select only the endpoint already
    // reconciled onto this enrolled installation and still marked current in
    // its site-owned Physical Inventory record. A scan at a new address must
    // not silently move the command route.
    const ipAddress = String(device.metadata?.ipAddress || '')
    if (isIP(ipAddress) !== 4) {
      throw new ConflictException('No reconciled active Shelly endpoint is saved for this installation; review its network identity before enabling switching.')
    }
    const activeObservations = inventory.networkObservations.filter(item =>
      item.isCurrent && scopeMatchesConfiguredZone(item.networkScope, zone),
    )
    const activeEndpoints = [...new Set(activeObservations.map(item => item.ipAddress))]
    if (activeEndpoints.length !== 1 || activeEndpoints[0] !== ipAddress) {
      throw new ConflictException(activeEndpoints.length > 1
        ? `Physical Inventory has conflicting active endpoints in ${zone.id}; review network identity reconciliation before enabling switching.`
        : `The saved ${zone.id} endpoint differs from the active Physical Inventory association; explicitly reconcile the endpoint before enabling switching.`)
    }
    if (device.metadata?.identityEvidenceSource !== 'verified_site_local_shelly_rpc' ||
        device.metadata?.componentEvidenceSource !== 'verified_site_local_shelly_rpc' ||
        !String(device.metadata?.siteLocalEvidenceScanId || '').startsWith('site-observer-') ||
        !String(device.metadata?.siteLocalObserverId || '')) {
      throw new ConflictException('The active endpoint lacks operator-reconciled site-local Shelly identity and component evidence.')
    }

    const history = (await this.discovery.listIdentityEvidence(ownership)).filter(record => {
      if (!record?.device) return false
      const observations = record.device.observations || []
      const independentlyVerifiedAt = new Set(observations.filter(item => item.source === 'http_identity' &&
        item.attribute === 'identity.verified' && item.value === true).map(item => item.observedAt))
      const identityMatches = observations.some(item =>
        ['http_identity', 'http_rpc', 'site_local_http_rpc'].includes(item.source) &&
        ['shelly.device_id', 'identity.device_id'].includes(item.attribute) &&
        typeof item.value === 'string' && item.value.toLowerCase() === physicalId.toLowerCase() &&
        (item.source !== 'http_identity' || independentlyVerifiedAt.has(item.observedAt)))
      return record.ownership?.tenantId === ownership.tenantId && record.ownership.siteId === ownership.siteId &&
        record.device.vendor === 'Shelly' && record.device.id.toLowerCase() === physicalId.toLowerCase() &&
        record.device.networkZoneId === zone.id && record.device.ipAddress === ipAddress &&
        record.device.components?.some(item => item.component === component) && identityMatches &&
        observations.some(item => ['http_rpc', 'site_local_http_rpc'].includes(item.source) &&
          item.attribute === 'shelly.component_status' && item.value === component &&
          item.method === `Switch.GetStatus?id=${channel}`)
    })
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    if (!history.length) {
      throw new ConflictException(`No saved site-owned identity and ${component} component-status evidence supports the reconciled ${zone.id} endpoint.`)
    }
    if (isIP(ipAddress) !== 4) {
      throw new ConflictException('The saved Shelly endpoint is not in a configured authorized execution scope.')
    }
    const endpointInScope = zone.cidr
      ? ipInCidr(ipAddress, zone.cidr)
      : zone.seedIps.includes(ipAddress)
    if (!endpointInScope) {
      throw new ConflictException('The saved Shelly endpoint is outside the configured network scope.')
    }
    onStage?.('saved_endpoint_observer_scope_validated')
    const collectionSource = zone.collectionSource ?? 'local'
    return { device, inventory, physicalId, component, channel: channel as number, ipAddress,
      zone: { ...zone, collectionSource } }
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
        })
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

  private async pollEnergridDevice(device: RegisteredDevice): Promise<void> {
    const scope = { tenantId: device.tenantId, siteId: device.siteId }
    const physicalId = String(device.metadata?.physicalId || '').toLowerCase()
    let collectionContext: FirmwareDiagnosticCollectionContext | undefined
    if (!scope.tenantId || !scope.siteId || !physicalId || !this.discovery || !this.observations) {
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=trusted_http_ingress_unavailable`)
      return
    }
    const diagnosticsDue = this.claimDiagnosticsCollection(scope, device.id)
    const recordFailure = (reason: FirmwareDiagnosticFailureReason) => diagnosticsDue
      ? this.recordFirmwareDiagnosticsFailure(scope, device.id, physicalId, reason, collectionContext)
      : Promise.resolve()

    let records: KnownNetworkDevice[]
    try {
      records = await this.discovery.listIdentityEvidence(scope)
    } catch {
      this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'unknown', observedAt: new Date().toISOString() })
      await recordFailure('endpoint_unverified')
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=trusted_identity_evidence_unavailable`)
      return
    }
    const networkScope = String(device.metadata?.networkScope || '')
    // The last selected/scanned scope is transient UI state. Resolve every
    // installation against its configured scope so a Lab scan cannot hide a
    // Home endpoint (or vice versa) from the scheduled poller.
    const scannedZones = this.lanDiscovery?.getZones() || []
    const configuredZone = this.lanDiscovery?.getConfiguredZone?.(networkScope) ||
      scannedZones.find(zone => zone.id === networkScope)
    const endpointZones = configuredZone ? [configuredZone] : scannedZones
    // Discovery Memory may be absent (for example, a legacy installation
    // whose scan history is intentionally unscoped). Revalidate only the
    // enrolled installation's saved target within its configured zone; this
    // candidate is not trusted until its exact firmware identity is checked.
    const endpoint = resolveEnergridHttpEndpoint(device, records, endpointZones) ||
      resolveEnrolledEnergridHttpEndpoint(device, endpointZones)
    if (!endpoint) {
      this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'unknown', observedAt: new Date().toISOString() })
      await recordFailure('endpoint_unverified')
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=verified_endpoint_missing_or_out_of_scope`)
      return
    }
    collectionContext = buildFirmwareDiagnosticCollectionContext(
      endpoint.identityUrl,
      endpoint.record.device.ipAddress,
      configuredZone || scannedZones.find(zone => zone.id === networkScope),
    )
    const recordObserverReachability = (status: 'reachable' | 'unreachable', reason?: string) => {
      if (!collectionContext || typeof this.registry.recordObserverReachability !== 'function') return
      this.registry.recordObserverReachability(device.id, {
        status,
        checkedAt: new Date().toISOString(),
        endpoint: collectionContext.target.endpoint,
        targetIpAddress: collectionContext.target.ipAddress,
        networkScopeId: collectionContext.target.networkScopeId,
        observer: collectionContext.observer,
        ...(reason ? { reason } : {}),
      })
    }

    const virtualLabPoll = configuredZone?.collectionSource === 'virtual-lab'
    if (virtualLabPoll) {
      try {
        const configuredTarget = new URL(device.adapter.target!)
        if (configuredTarget.protocol !== 'http:' || (configuredTarget.port && configuredTarget.port !== '80')) {
          throw new Error('virtual_lab_target_not_configured')
        }
      } catch {
        this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'unknown', observedAt: new Date().toISOString() })
        await recordFailure('scope_rejected')
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=virtual_lab_target_not_configured`)
        return
      }
    }

    const controller = new AbortController()
    // The fixed remote reader includes Docker/SSH startup as well as two
    // bounded GETs, while local Home sensors keep their existing HTTP timeout.
    const timeout = setTimeout(() => controller.abort(), virtualLabPoll ? 12_000 : httpPollTimeoutMs())
    let phase: 'identity' | 'status' | 'observation' = 'identity'
    let targetResponded = false
    try {
      const virtualEvidence = virtualLabPoll
        ? await this.lanDiscovery!.readVirtualLabEnergridHttpEvidence(
          networkScope, endpoint.record.device.ipAddress, physicalId, controller.signal,
        )
        : null
      let identityPayload: unknown
      if (virtualEvidence) {
        targetResponded = true
        recordObserverReachability('reachable', 'http_response')
        if (virtualEvidence.identity.status >= 300 && virtualEvidence.identity.status < 400) throw new Error('identity_redirect_rejected')
        if (virtualEvidence.identity.status !== 200) throw new Error(`identity_http_${virtualEvidence.identity.status}`)
        identityPayload = virtualEvidence.identity.body
      } else {
        const identityResponse = await fetch(endpoint.identityUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        })
        targetResponded = true
        recordObserverReachability('reachable', 'http_response')
        if (identityResponse.status >= 300 && identityResponse.status < 400) throw new Error('identity_redirect_rejected')
        if (!identityResponse.ok) throw new Error(`identity_http_${identityResponse.status}`)
        identityPayload = await readJsonResponse(identityResponse, 4 * 1024)
      }
      const identity = parseEnergridIdentity(identityPayload)
      if (!identity) {
        this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'unknown', observedAt: new Date().toISOString() })
        await recordFailure('identity_request_failed')
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=invalid_firmware_identity_response`)
        return
      }
      if (identity.id !== physicalId) {
        // The endpoint answered, but it is not the enrolled physical device.
        // Keep device reachability unknown instead of labeling it offline or
        // allowing the reused address to supply measurements.
        this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'unknown', observedAt: new Date().toISOString() })
        await recordFailure('identity_mismatch')
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=firmware_identity_mismatch`)
        return
      }
      if (endpoint.renewalDue) {
        const observedAt = new Date().toISOString()
        const refreshed: NetworkDiscoveredDevice = {
          ...endpoint.record.device,
          id: identity.id,
          vendor: 'Energrid',
          model: identity.model,
          firmwareVersion: identity.firmwareVersion,
          protocol: 'http',
          confidence: 0.95,
          status: 'online',
          discoveredAt: observedAt,
          reason: 'Energrid firmware identity was re-verified by the bounded HTTP poller.',
          observations: [
            ...(endpoint.record.device.observations || []),
            { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' },
            { source: 'http_identity', attribute: 'identity.device_id', value: identity.id, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' },
            { source: 'http_identity', attribute: 'device.model', value: identity.model, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' },
            { source: 'http_identity', attribute: 'firmware.version', value: identity.firmwareVersion, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' },
            ...identity.capabilities.map(capability => ({ source: 'http_identity' as const, attribute: 'device.capability', value: capability, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' })),
          ],
        }
        try {
          await this.discovery!.recordIdentityObservation(observedAt, refreshed, scope)
          this.logger.log(`[DEVICE HTTP POLL] ${device.id} identity_refreshed scope=${device.metadata?.networkScope} observedAt=${observedAt}`)
        } catch {
          throw new Error('identity_evidence_persistence_failed')
        }
      }
      this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'online', observedAt: new Date().toISOString() })
      if (diagnosticsDue) await this.pollFirmwareDiagnostics(device, endpoint.identityUrl, physicalId, scope)

      phase = 'status'
      let payload: unknown
      if (virtualEvidence) {
        if (!virtualEvidence.status) throw new Error('status_not_requested_identity_mismatch')
        if (virtualEvidence.status.status >= 300 && virtualEvidence.status.status < 400) throw new Error('status_http_redirect_rejected')
        if (virtualEvidence.status.status !== 200) throw new Error(`status_http_${virtualEvidence.status.status}`)
        payload = virtualEvidence.status.body
      } else {
        const statusResponse = await fetch(endpoint.statusUrl, {
          signal: controller.signal,
          redirect: 'error',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        })
        if (!statusResponse.ok) throw new Error(`status_http_${statusResponse.status}`)
        payload = await readJsonResponse(statusResponse)
      }
      const parsed = parseEnergridHttpSample(payload, physicalId)
      if (!parsed.accepted) {
        this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'online', observedAt: new Date().toISOString() })
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=${parsed.reason}`)
        return
      }

      phase = 'observation'
      const evidenceId = parsed.sample.sampleId
        ? energridFirmwareSampleEvidenceId(physicalId, parsed.sample.sampleId)
        : await this.observations.sourceSampleEvidenceId(
          scope, device.id, ENERGRID_SAMPLE_CURSOR_SOURCE, parsed.sample.counters,
        )
      if (!evidenceId) {
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=observation_store_unavailable`)
        return
      }
      const result = await this.observations.ingestHttpObservation({
        scope,
        deviceId: device.id,
        sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE,
        selector: ENERGRID_HTTP_STATUS_SELECTOR,
        payload: parsed.sample.values,
        evidenceId,
      })
      if (result.outcome === 'processed') {
        this.logger.log(`[DEVICE HTTP POLL] ${device.id} ${result.accepted ? 'accepted' : 'rejected'} stage=${result.stage} reason=${result.reason} fields=${result.updatedKeys.join(',') || '-'} rejectedFields=${result.rejectedFields.join(',') || '-'}`)
      } else {
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=${result.reasonCode}`)
      }
    } catch (error) {
      const transportFailure = error instanceof Error && (error.name === 'AbortError' || error instanceof TypeError)
      if (transportFailure && !targetResponded) {
        recordObserverReachability('unreachable', error instanceof Error && error.name === 'AbortError' ? 'request_timeout' : 'request_failed')
      }
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'request_timeout'
        : error instanceof Error && /^((identity|status)_http_\d+|response_too_large|invalid_response_json|source_sample_session_ambiguous|identity_evidence_persistence_failed|identity_redirect_rejected)$/.test(error.message)
          ? error.message
          : phase === 'observation' ? 'observation_ingress_failed'
            : phase === 'identity' ? 'identity_request_failed'
              : 'request_failed'
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=${reason}`)
      if (phase === 'identity') {
        await recordFailure(reason === 'request_timeout' ? 'request_timeout' : 'identity_request_failed')
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async pollFirmwareDiagnostics(
    device: RegisteredDevice,
    verifiedIdentityUrl: string,
    physicalId: string,
    scope: { tenantId: string; siteId: string },
  ): Promise<void> {
    if (!this.firmwareDiagnostics) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), httpPollTimeoutMs());
    try {
      const sample = await this.firmwareDiagnosticsAdapter.collect(verifiedIdentityUrl, physicalId, controller.signal);
      const view = await this.firmwareDiagnostics.record(scope, device.id, physicalId, sample);
      this.logger.log(`[DEVICE FIRMWARE DIAGNOSTICS] ${device.id} recorded boot=${sample.bootSessionId} uptimeMs=${sample.uptimeMs} restartCount10m=${view.restartCount10m}`);
    } catch (error) {
      const reason = error instanceof FirmwareDiagnosticsCollectionError ? error.reason : 'collector_error';
      const networkScope = String(device.metadata?.networkScope || '');
      const zone = this.lanDiscovery?.getConfiguredZone?.(networkScope) ||
        this.lanDiscovery?.getZones().find(item => item.id === networkScope);
      const diagnosticsEndpoint = `${new URL(verifiedIdentityUrl).origin}/api/v1/diagnostics`;
      const context = buildFirmwareDiagnosticCollectionContext(
        diagnosticsEndpoint,
        new URL(verifiedIdentityUrl).hostname,
        zone,
      );
      await this.recordFirmwareDiagnosticsFailure(scope, device.id, physicalId, reason, context);
      this.logger.warn(`[DEVICE FIRMWARE DIAGNOSTICS] ${device.id} skipped reason=${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private claimDiagnosticsCollection(scope: { tenantId: string; siteId: string }, deviceId: string): boolean {
    const key = `${scope.tenantId}\0${scope.siteId}\0${deviceId}`;
    const now = performance.now();
    const lastPoll = this.diagnosticsPollAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if (now - lastPoll < firmwareDiagnosticsIntervalMs()) return false;
    if (!this.diagnosticsPollAt.has(key) && this.diagnosticsPollAt.size >= 512) {
      const oldest = this.diagnosticsPollAt.keys().next().value;
      if (oldest) this.diagnosticsPollAt.delete(oldest);
    }
    this.diagnosticsPollAt.set(key, now);
    return true;
  }

  private async recordFirmwareDiagnosticsFailure(
    scope: { tenantId: string; siteId: string },
    deviceId: string,
    physicalId: string,
    reason: FirmwareDiagnosticFailureReason,
    context?: FirmwareDiagnosticCollectionContext,
  ): Promise<void> {
    if (!this.firmwareDiagnostics) return;
    try {
      await this.firmwareDiagnostics.recordFailure(scope, deviceId, physicalId, reason, new Date().toISOString(), context);
    } catch {
      this.logger.warn(`[DEVICE FIRMWARE DIAGNOSTICS] ${deviceId} failure_record_unavailable`);
    }
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

export function buildFirmwareDiagnosticCollectionContext(
  endpointUrl: string,
  ipAddress: string,
  zone: NetworkDiscoveryZone | undefined,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  observerHost = hostname(),
  observerPlatform = process.platform,
): FirmwareDiagnosticCollectionContext {
  const localScopes = Object.entries(interfaces).flatMap(([interfaceName, addresses]) =>
    (addresses || []).flatMap(address => {
      if (address.internal || address.family !== 'IPv4') return []
      const prefix = ipv4NetmaskPrefix(address.netmask)
      if (prefix === null) return []
      return [{ interfaceName: interfaceName.slice(0, 64), cidr: `${address.address}/${prefix}`, address: address.address }]
    }),
  ).slice(0, 32)
  let endpoint = ipAddress
  try {
    const url = new URL(endpointUrl);
    endpoint = `${url.origin}${url.pathname}`;
  } catch { /* Keep the verified endpoint IP only. */ }
  return {
    observer: {
      id: `${observerHost}/${observerPlatform}`,
      host: observerHost.slice(0, 128),
      platform: observerPlatform.slice(0, 32),
      localScopes,
    },
    target: {
      endpoint,
      ipAddress,
      networkScopeId: zone?.id || '',
      networkScopeName: zone?.name || '',
    },
  }
}

function ipv4NetmaskPrefix(netmask: string): number | null {
  const octets = netmask.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null
  const bits = octets.map(value => value.toString(2).padStart(8, '0')).join('')
  if (!/^1*0*$/.test(bits)) return null
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0')
}

async function readJsonResponse(response: Response, maxBytes = 16 * 1024): Promise<unknown> {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('response_too_large')
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('response_too_large')
      }
      chunks.push(value)
    }
    return parseJson(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'))
  }
  if (typeof response.text === 'function') return parseJson(await response.text())
  return response.json()
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body) as unknown } catch { throw new Error('invalid_response_json') }
}

function normalizeHttpValues(payload: unknown): Record<string, number | boolean | string | null> {
  if (!payload || typeof payload !== 'object') return {}

  const raw = payload as Record<string, unknown>
  const source =
    raw.values && typeof raw.values === 'object'
      ? (raw.values as Record<string, unknown>)
      : raw
  const values: Record<string, number | boolean | string | null> = {}

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' || value === null) {
      values[key] = value
    } else if (value && typeof value === 'object' && 'value' in value) {
      const nested = (value as { value?: unknown }).value
      if (typeof nested === 'number' || typeof nested === 'boolean' || typeof nested === 'string' || nested === null) {
        values[key] = nested
      }
    }
  }

  return values
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedObserverHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.local$/, '')
}

function networkInterfaceMatchesCidr(address: string, netmask: string, cidr: string): boolean {
  const prefix = ipv4NetmaskPrefix(netmask)
  const [network, prefixText] = cidr.split('/')
  const authorizedPrefix = Number(prefixText)
  if (prefix === null || prefix !== authorizedPrefix || isIP(address) !== 4 || isIP(network) !== 4) return false
  return ipv4Network(address, prefix) === ipv4Network(network, prefix)
}

function ipv4Network(address: string, prefix: number): number {
  const value = address.split('.').map(Number).reduce((current, octet) => current * 256 + octet, 0)
  const blockSize = 2 ** (32 - prefix)
  return Math.floor(value / blockSize) * blockSize
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

function freshRemoteTimestamp(value: string, maximumAgeMs: number): boolean {
  const timestamp = Date.parse(value)
  const now = Date.now()
  return Number.isFinite(timestamp) && timestamp <= now + 15_000 && now - timestamp <= maximumAgeMs
}

function safeRemoteFailureCode(value: unknown): string {
  return typeof value === 'string' && ['identity_mismatch', 'component_mismatch', 'invalid_status', 'rpc_unavailable'].includes(value)
    ? value
    : 'rpc_unavailable'
}

function safeRemoteObserverError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'observer_error'
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code)) return code
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(name) ? name : 'observer_error'
}

function safeRemoteAssignmentFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'observer_error'
  const message = error.message
  if (message.startsWith('Shelly route rejected (')) {
    const reason = /^Shelly route rejected \(([a-z0-9_]{1,80})\)\.$/.exec(message)?.[1]
    return reason ? `route_rejected_${reason}` : 'route_rejected'
  }
  if (message.includes('exact same-site physical inventory assignment')) return 'physical_inventory_assignment_mismatch'
  if (message.includes('configured installation network scope')) return 'installation_scope_not_configured'
  if (message.includes('conflicting active endpoints')) return 'active_endpoint_conflict'
  if (message.includes('active Physical Inventory association')) return 'active_endpoint_mismatch'
  if (message.includes('No reconciled active Shelly endpoint')) return 'active_endpoint_missing'
  if (message.includes('operator-reconciled site-local Shelly identity')) return 'reconciled_identity_metadata_missing'
  if (message.startsWith('No saved site-owned identity and ')) return 'saved_identity_or_component_evidence_missing'
  if (message.includes('outside the configured network scope')) return 'endpoint_out_of_scope'
  if (message.includes('belongs to a different authorized observer')) return 'observer_assignment_mismatch'
  if (message.includes('explicit secure SSH execution target')) return 'observer_transport_configuration_missing'
  if (message.includes('scope, physical ID and component allowlist')) return 'observer_assignment_unauthorized'
  if (['observer_identity_not_authorized', 'observer_component_not_authorized', 'observer_assignment_ambiguous'].includes(message)) {
    return message
  }
  return safeRemoteObserverError(error)
}

function scopeMatchesConfiguredZone(scopeValue: string, zone: NetworkDiscoveryZone): boolean {
  const scope = scopeValue.trim()
  return scope === zone.id || (!!zone.cidr && scope === zone.cidr) ||
    scope.endsWith(`:${zone.id}`) || (!!zone.cidr && scope.endsWith(`:${zone.cidr}`))
}

function httpPollingEnabled(): boolean {
  return ['1', 'true', 'yes'].includes(String(process.env.HOME_HTTP_POLL_ENABLED).toLowerCase())
}

function httpPollIntervalMs(): number {
  const configured = Number(process.env.HOME_HTTP_POLL_INTERVAL_MS)
  return Number.isFinite(configured) && configured >= 500 ? configured : 5000
}

function httpPollTimeoutMs(): number {
  const configured = Number(process.env.HOME_HTTP_POLL_TIMEOUT_MS)
  return Number.isFinite(configured) && configured >= 250 ? configured : 2000
}

function firmwareDiagnosticsIntervalMs(): number {
  const configured = Number(process.env.HOME_FIRMWARE_DIAGNOSTICS_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 15_000 && configured <= 15 * 60_000 ? configured : 60_000;
}
