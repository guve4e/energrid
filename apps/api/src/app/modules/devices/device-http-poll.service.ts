import { BadGatewayException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional, Inject } from '@nestjs/common'
import { DeviceRegistryService } from './device-registry.service'
import type { NetworkDiscoveryZone, NetworkDiscoveredDevice, RegisteredDevice } from './device-registry.types'
import type { KnownNetworkDevice } from './device-discovery-memory.store'
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { DeviceLanDiscoveryService } from './device-lan-discovery.service'
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
import { randomUUID } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { parseShellySwitchStatus } from './adapters/inbound/shelly/shelly-switch-status'
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from './enrollment/physical-device-inventory.token'
import type { PhysicalDeviceInventoryService } from './enrollment/physical-device-inventory.service'
import { hasPhysicalDeviceIdentityClaim } from './enrollment/physical-device-inventory.repository'

@Injectable()
export class DeviceHttpPollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceHttpPollService.name)
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private readonly diagnosticsPollAt = new Map<string, number>()
  private readonly firmwareDiagnosticsAdapter = new EnergridFirmwareDiagnosticsHttpAdapter()

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
        .filter((device) => isHttpTarget(device.adapter.target))

      await Promise.all(devices.map((device) => this.pollDevice(device)))
    } finally {
      this.polling = false
    }
  }

  private async pollDevice(device: RegisteredDevice): Promise<void> {
    if (device.adapter.driver === 'energrid-esp8266') {
      await this.pollEnergridDevice(device)
      return
    }

    // A Shelly assigned to a Virtual Lab scope is reachable only from its
    // configured remote observer. Do not repeatedly try its saved endpoint
    // from the API host; selected-device RPC remains an explicit one-shot
    // action until a suitable recurring observer transport exists.
    if (device.adapter.driver === 'shelly-lan' && this.isVirtualLabShelly(device)) return

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

  private isVirtualLabShelly(device: RegisteredDevice): boolean {
    const scope = String(device.metadata?.networkScope || '').trim()
    if (!scope || !this.lanDiscovery?.getConfiguredZone) return false

    // Shelly enrollment stores observer identity and zone as
    // "<observer>:<zone-id>"; older local records may store only the zone id.
    // Resolve against configured scopes, never the last Portal-selected scan.
    const scopeId = scope.slice(scope.lastIndexOf(':') + 1)
    return this.lanDiscovery.getConfiguredZone(scopeId)?.collectionSource === 'virtual-lab'
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
      await this.registry.ensureInstallationsLoaded()
      const matches = this.registry.getDevices(true).filter(device => device.id === deviceId)
      const device = matches.find(item => item.tenantId === ownership.tenantId && item.siteId === ownership.siteId)
      if (!device) throw new NotFoundException('No Shelly installation exists in the selected site.')
      if (matches.some(item => item.tenantId !== ownership.tenantId || item.siteId !== ownership.siteId)) {
        throw new ConflictException('The Shelly identity is also registered outside the selected site.')
      }
      const physicalId = String(device.metadata?.physicalId || '')
      const component = String(device.metadata?.component || '')
      if (device.kind !== 'physical' || device.trustStatus !== 'approved' ||
          device.adapter.driver !== 'shelly-lan' || device.adapter.protocol !== 'http' ||
          !device.adapter.configured || !/^shelly[a-z0-9._-]{1,114}$/i.test(physicalId) ||
          component !== 'switch:0' || device.id !== `${physicalId}:${component}`) {
        throw new ConflictException('Only an approved, configured, enrolled Shelly switch:0 installation can be observed.')
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
        throw new ConflictException('The enrolled switch has no exact same-site physical inventory assignment.')
      }
      const decision = await this.registry.getShellyReconciliationTargetDecision(
        ownership.tenantId, ownership.siteId, deviceId, physicalId, component, inventory.physicalDeviceId,
      )
      if (!decision.matched) throw new ConflictException(`Shelly status observation rejected (${decision.reasonCode}).`)
      stage = 'enrollment_inventory_validated'
      this.logShellyObservation(correlationId, stage, 'completed', startedAt, deviceId, ownership)

      stage = 'saved_endpoint_observer_scope_validation'
      const history = (await this.discovery.listIdentityEvidence(ownership)).filter(record =>
        record.ownership?.tenantId === ownership.tenantId && record.ownership.siteId === ownership.siteId &&
        record.device.vendor === 'Shelly' && record.device.id.toLowerCase() === physicalId.toLowerCase() &&
        record.device.components?.some(item => item.component === component) &&
        record.device.observations?.some(item =>
          ['http_rpc', 'site_local_http_rpc'].includes(item.source) &&
          ['shelly.device_id', 'identity.device_id'].includes(item.attribute) &&
          typeof item.value === 'string' && item.value.toLowerCase() === physicalId.toLowerCase()) &&
        record.device.observations?.some(item =>
          ['http_rpc', 'site_local_http_rpc'].includes(item.source) &&
          item.attribute === 'shelly.component_status' && item.value === component &&
          item.method === 'Switch.GetStatus?id=0'))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      const endpoints = [...new Map(history.map(record =>
        [`${record.device.networkZoneId}:${record.device.ipAddress}`, record])).values()]
      if (endpoints.length !== 1) {
        throw new ConflictException(endpoints.length
          ? 'Saved site-owned Shelly evidence has conflicting endpoints; no status was requested.'
          : 'No saved site-owned identity and switch:0 evidence supports this installation.')
      }
      const endpointRecord = endpoints[0]
      const zoneId = endpointRecord.device.networkZoneId
      scopeId = zoneId
      const zone = this.lanDiscovery.getConfiguredZone(zoneId)
      const ipAddress = endpointRecord.device.ipAddress
      if (!zone || zone.collectionSource !== 'virtual-lab' || isIP(ipAddress) !== 4) {
        throw new ConflictException('The saved Shelly endpoint is not in the configured authorized Virtual Lab scope.')
      }
      stage = 'saved_endpoint_observer_scope_validated'
      this.logShellyObservation(correlationId, stage, 'completed', startedAt, deviceId, ownership, { scopeId })

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 18_000)
      try {
        stage = 'remote_execution'
        this.logShellyObservation(correlationId, 'remote_execution_started', 'started', startedAt, deviceId, ownership, { scopeId })
        const evidence = await this.lanDiscovery.readVirtualLabShellyStatusEvidence(
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
        if (!values) throw new BadGatewayException('Switch.GetStatus returned a malformed or mismatched switch:0 response.')

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
          target: `http://${ipAddress}/rpc/Switch.GetStatus?id=0`, location: device.zoneName,
          capabilities: device.capabilities.map(item => item.kind), values,
          state: { values, source, status: 'online', observedAt }, observedAt,
        })
        this.registry.recordObserverReachability(device.id, {
          status: 'reachable', checkedAt: observedAt,
          endpoint: `http://${ipAddress}/rpc/Switch.GetStatus?id=0`, targetIpAddress: ipAddress,
          networkScopeId: zoneId,
          observer: { id: evidence.observer.id, host: evidence.observer.host, platform: 'docker', localScopes: [] },
        })
        stage = 'operational_state_ingestion_completed'
        this.logShellyObservation(correlationId, stage, 'completed', startedAt, deviceId, ownership, { scopeId, observerId })
        return {
          deviceId: device.id, physicalId, component, physicalInventoryId: inventory.physicalDeviceId,
          site: ownership, output: values.output, observedAt, source,
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

function isHttpTarget(value: string | undefined): value is string {
  return !!value && /^https?:\/\//.test(value)
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
