import { BadGatewayException, BadRequestException, ConflictException, GatewayTimeoutException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common'
import {
  dedupeNetworkEndpoints,
  normalizeNetworkHostname,
} from './network-discovery-evidence-utils'
import type { DeviceDiscoveryMemoryStore, DiscoveryOwnership } from './device-discovery-memory.store'
import { DEVICE_DISCOVERY_MEMORY_STORE, DEVICE_REGISTRY_SERVICE } from './device-runtime.tokens'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { hostname as localHostname, networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import { reverse } from 'node:dns/promises'
import { BlockList, isIP, Socket } from 'node:net'
import { promisify } from 'node:util'
import { privateShellyBaseUrl } from '@energrid/domain-devices'
import type {
  NetworkDiscoveredDevice,
  NetworkDiscoveryZone,
} from './device-registry.types'
import type { DeviceRegistryService } from './device-registry.service'
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from './enrollment/physical-device-inventory.token'
import type { PhysicalDeviceInventoryService } from './enrollment/physical-device-inventory.service'
import type { PhysicalLanObservation } from './enrollment/physical-device-inventory.repository'
import { shellyLanCandidates } from './adapters/inbound/shelly/shelly-lan-candidates'
import { energridDiscoveryCandidate } from './adapters/inbound/energrid/energrid-discovery-candidate'
import { readOnlyShellyDeviceInfo, readOnlyShellyRpcDeviceInfo, readOnlyShellyRpcDeviceInfoFromBody } from './adapters/inbound/shelly/read-only-shelly-rpc'
import { compareNetworkSnapshots, type NetworkDiscoverySnapshot, type NetworkDiscoverySnapshotDiff } from './network-discovery-snapshot'
import { NmapNetworkEvidenceAdapter, type NmapCapability, type NmapScanResult } from './adapters/outbound/network/nmap-network-evidence.adapter'
import {
  inferConfiguredIpv4Scopes,
  LocalNetworkRuntimeAdapter,
  type LocalNetworkRuntimeReport,
} from './adapters/outbound/network/local-network-runtime.adapter'
import { EnergridHttpIdentityAdapter } from './adapters/outbound/network/energrid-http-identity.adapter'
import { VirtualLabNetworkEvidenceAdapter, type VirtualLabEnergridHttpEvidence, type VirtualLabScanResult } from './adapters/outbound/network/virtual-lab-network-evidence.adapter'

const execFileAsync = promisify(execFile)
const activeScanConcurrency = 24
const tcpConnectTimeoutMs = 1_500

export type NetworkCandidate = {
  ipAddress: string
  macAddress?: string
  hostname?: string
  hostnameEvidence?: string[]
  macEvidence?: string[]
  vendor?: string
  model?: string
  protocol?: NetworkDiscoveredDevice['protocol']
  confidence?: number
  status?: NetworkDiscoveredDevice['status']
  firmwareVersion?: string
  app?: string
  generation?: number
  components?: NetworkDiscoveredDevice['components']
  deviceReportedMacAddress?: string
  reason?: string
  networkZoneId?: string
  networkZoneName?: string
  interfaceName?: string
  evidenceSource?: string
  observedAt?: string
  observations?: NetworkDiscoveredDevice['observations']
}

/** Explicit collection controls for isolated observer callers. Defaults preserve API scan behavior. */
export interface DeviceLanEvidenceCollectionOptions {
  nmapEnabled?: boolean
  maxHosts?: number
  timeoutMs?: number
  allowActiveScanFallback?: boolean
  includeNeighborTable?: boolean
  includeRouterClientSources?: boolean
  includeConfiguredSeedTargets?: boolean
}

@Injectable()
export class DeviceLanNetworkEvidenceCollector {
  constructor(
    @Optional() private readonly nmapAdapter?: NmapNetworkEvidenceAdapter,
    @Optional() private readonly runtimeAdapter?: LocalNetworkRuntimeAdapter,
    @Optional() private readonly energridIdentityAdapter: EnergridHttpIdentityAdapter = new EnergridHttpIdentityAdapter(),
  ) {}

  async getNmapCapability(
    nmapEnabled = process.env.HOME_NMAP_ENABLED === 'true',
    signal?: AbortSignal,
  ): Promise<NmapCapability & { enabled: boolean }> {
    const capability = await (this.nmapAdapter || new NmapNetworkEvidenceAdapter()).getCapability(signal)
    return { ...capability, enabled: nmapEnabled }
  }

  async collectEvidence(
    zones: NetworkDiscoveryZone[],
    signal?: AbortSignal,
    options: DeviceLanEvidenceCollectionOptions = {},
  ): Promise<{
    candidates: NetworkCandidate[]
    nmap: NmapScanResult
    runtime?: LocalNetworkRuntimeReport
  }> {
    const nmapEnabled = options.nmapEnabled ?? process.env.HOME_NMAP_ENABLED === 'true'
    const nmapAdapter = this.nmapAdapter || new NmapNetworkEvidenceAdapter()
    const runtimePromise = this.runtimeAdapter?.inspect(zones)
    const nmap = await nmapAdapter.scan(zones, {
      enabled: nmapEnabled,
      maxHosts: options.maxHosts ?? (Number(process.env.HOME_NMAP_MAX_HOSTS) || 254),
      timeoutMs: options.timeoutMs ?? (Number(process.env.HOME_NMAP_TIMEOUT_MS) || 120_000),
      signal,
    })
    const nmapHostDiscoveryUsed = nmapEnabled && nmap.capability.available
    const allowActiveScanFallback = options.allowActiveScanFallback ?? true
    throwIfScanAborted(signal)
    const reachableDevices = nmapHostDiscoveryUsed || !allowActiveScanFallback ? [] : await activeScanZones(zones, signal)
    const tcpDevices = nmapHostDiscoveryUsed || !allowActiveScanFallback ? [] : await tcpDiscoverZones(zones, reachableDevices, signal)
    const [arpDevices, routerClients] = await Promise.all([
      options.includeNeighborTable === false
        ? Promise.resolve([])
        : readNeighborTable(options.includeConfiguredSeedTargets ?? true),
      options.includeRouterClientSources === false ? Promise.resolve([]) : readRouterClientCandidates(),
    ])
    const runtime = await runtimePromise
    if (runtime) {
      runtime.capabilities.push({
        id: 'nmap',
        available: nmap.capability.available,
        detail: nmap.capability.available
          ? `Nmap ${nmap.capability.version || 'version unknown'} ran successfully; the TCP service collector is supported. Actual scan attempts and results are recorded in this snapshot.`
          : `${nmap.capability.reason || 'Nmap is unavailable.'} The TCP service collector is supported, but no Nmap evidence was collected.`,
      })
      runtime.capabilities.push({
        id: 'active_probing',
        available: allowActiveScanFallback && process.env.HOME_LAN_ACTIVE_SCAN_ENABLED !== 'false',
        detail: !allowActiveScanFallback || process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false' ? 'Active ICMP/TCP subnet probes are disabled.' : 'Bounded active probes are available and require explicit operator approval.',
      })
    }
    const stamp = (candidates: NetworkCandidate[], source: string) => candidates.map(candidate => ({
      ...candidate,
      evidenceSource: candidate.evidenceSource || source,
      observedAt: candidate.observedAt || new Date().toISOString(),
    }))
    const candidates = [
      ...stamp(arpDevices, 'neighbor_table'),
      ...stamp(routerClients, 'router_clients'),
      ...stamp(reachableDevices, 'icmp'),
      ...stamp(tcpDevices, 'tcp'),
      ...stamp(zones.flatMap(zone => zone.seedIps.map(ipAddress => ({
        ipAddress, networkZoneId: zone.id, networkZoneName: zone.name,
      }))), 'seed_ip'),
    ].map(candidate => assignNetworkZone(candidate, zones))
      .filter((candidate) => candidateBelongsToConfiguredZone(candidate, zones))
    throwIfScanAborted(signal)
    const nmapCandidates: NetworkCandidate[] = nmap.hosts.flatMap(host => {
      const zone = zones.find(item => item.id === host.scopeId)
      if (!zone) return []
      return [{
        ipAddress: host.ipAddress,
        ...(host.macAddress ? { macAddress: host.macAddress } : {}),
        ...(host.hostname ? { hostname: host.hostname } : {}),
        ...(host.interfaceName ? { interfaceName: host.interfaceName } : {}),
        networkZoneId: zone.id,
        networkZoneName: zone.name,
        status: host.status,
        reason: host.reason,
        evidenceSource: 'nmap',
        observedAt: host.observedAt,
        observations: host.observations,
      }]
    })
    return { candidates: [...candidates, ...nmapCandidates], nmap, ...(runtime ? { runtime } : {}) }
  }

  async getRuntimeCapabilities(zones: NetworkDiscoveryZone[]): Promise<{ nmap: NmapCapability & { enabled: boolean }; observer?: LocalNetworkRuntimeReport }> {
    const [nmap, observer] = await Promise.all([
      this.getNmapCapability(),
      this.runtimeAdapter?.inspect(zones),
    ])
    if (observer) {
      observer.capabilities.push({
        id: 'nmap', available: nmap.available,
        detail: nmap.available
          ? `Nmap ${nmap.version || 'version unknown'} ran successfully; the TCP service collector is supported${nmap.enabled ? ' and enabled' : ' but disabled'}. Evidence is reported in completed snapshot methods and endpoints.`
          : `${nmap.reason || 'Nmap is unavailable.'} The TCP service collector is supported, but no Nmap evidence was collected.`,
      })
      observer.capabilities.push({
        id: 'active_probing', available: process.env.HOME_LAN_ACTIVE_SCAN_ENABLED !== 'false',
        detail: process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false' ? 'Active ICMP/TCP subnet probes are disabled.' : 'Bounded active probes are available and require explicit operator approval.',
      })
    }
    return { nmap, ...(observer ? { observer } : {}) }
  }

  async collectCandidates(zones: NetworkDiscoveryZone[]): Promise<NetworkCandidate[]> {
    return (await this.collectEvidence(zones)).candidates
  }

  enrichCandidate(
    candidate: NetworkCandidate & { networkZoneId: string; networkZoneName: string },
    observedAt: string,
    allowEndpointEnrichment: boolean,
    allowIdentityProbe = true,
    signal?: AbortSignal,
  ): Promise<NetworkDiscoveredDevice> {
    return enrichNetworkDevice(candidate, observedAt, allowEndpointEnrichment, this.energridIdentityAdapter, allowIdentityProbe, signal)
  }
}

@Injectable()
export class DeviceLanDiscoveryService {
  private readonly logger = new Logger(DeviceLanDiscoveryService.name)
  private lastScan: NetworkDiscoveredDevice[] = []
  private lastScanOwnership: DiscoveryOwnership | null = null
  private lastZones: NetworkDiscoveryZone[] = []

  constructor(
    @Inject(DEVICE_DISCOVERY_MEMORY_STORE)
    private readonly discoveryMemory: DeviceDiscoveryMemoryStore,
    @Inject(DEVICE_REGISTRY_SERVICE)
    private readonly registry: DeviceRegistryService,
    private readonly evidenceCollector: DeviceLanNetworkEvidenceCollector,
    @Optional()
    @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
    @Optional()
    private readonly virtualLabEvidence: VirtualLabNetworkEvidenceAdapter = new VirtualLabNetworkEvidenceAdapter(),
  ) {}

  getLastScan(): NetworkDiscoveredDevice[] {
    const { tenant, site } = this.registry.getSnapshot()
    return this.lastScanOwnership?.tenantId === tenant.id && this.lastScanOwnership.siteId === site.id
      ? this.lastScan
      : []
  }

  getZones(): NetworkDiscoveryZone[] {
    return this.lastZones.length > 0 ? this.lastZones : configuredNetworkZones()
  }

  getConfiguredZone(scopeId: string): NetworkDiscoveryZone | undefined {
    return configuredNetworkZones().find(zone => zone.id === scopeId)
  }

  async verifyShellyCandidate(candidateId: string, ownership: DiscoveryOwnership): Promise<{
    status: 'verified'; scanId: string; physicalId: string; physicalDeviceId: string;
    componentKeys: string[]; identityVerifiedAt: string; componentsVerifiedAt: string;
  }> {
    const controller = new AbortController()
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.verifyShellyCandidateWithinDeadline(candidateId, ownership, controller.signal),
        new Promise<never>((_resolve, reject) => {
          deadlineTimer = setTimeout(() => {
            controller.abort()
            reject(new GatewayTimeoutException('Selected-device verification exceeded 20 seconds. No subnet scan was run; check the authorized observer route to this endpoint and retry.'))
          }, 20_000)
        }),
      ])
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      controller.abort()
    }
  }

  private async verifyShellyCandidateWithinDeadline(
    candidateId: string,
    ownership: DiscoveryOwnership,
    signal: AbortSignal,
  ) {
    const active = this.registry.getSnapshot()
    if (active.tenant.id !== ownership.tenantId || active.site.id !== ownership.siteId) {
      throw new ConflictException('The active Portal site changed. Reopen Add Devices and retry verification.')
    }
    const candidateMatch = candidateId.match(/^(shelly[a-z0-9._-]{1,114}):((?:switch|em1):\d+)$/i)
    if (!candidateMatch) throw new BadRequestException('The selected ID is not a Shelly physical-device component candidate.')
    const physicalId = candidateMatch[1]
    const component = candidateMatch[2]
    const registryMatches = this.registry.getDevices(true).filter(device => device.id === candidateId)
    if (registryMatches.some(device => device.tenantId !== ownership.tenantId || device.siteId !== ownership.siteId)) {
      throw new ConflictException('The selected Shelly component is registered under a different tenant or site.')
    }
    const registered = registryMatches.find(device => device.tenantId === ownership.tenantId && device.siteId === ownership.siteId)
    if (registered && registered.trustStatus !== 'discovered') {
      throw new ConflictException('The selected Shelly component is already enrolled or is no longer pending.')
    }
    if (registered && registered.adapter.driver !== 'shelly-lan') {
      throw new ConflictException('The selected component is not registered as a Shelly LAN candidate.')
    }
    if (!this.physicalInventory) throw new BadGatewayException('Physical inventory is unavailable; the selected candidate cannot be verified safely.')
    const inventories = await this.physicalInventory.list(ownership)
    const matchingInventory = inventories.filter(item =>
      item.scope.tenantId === ownership.tenantId && item.scope.siteId === ownership.siteId &&
      item.identity?.namespace === 'mqtt:shelly-protocol-id' && typeof item.identity.value === 'string' &&
      item.identity.value.toLowerCase() === physicalId.toLowerCase(),
    )
    if (matchingInventory.length > 1) {
      throw new ConflictException('More than one site-owned physical inventory record matches this Shelly identity.')
    }
    const inventory = matchingInventory[0]

    const history = await this.discoveryMemory.listIdentityEvidence(ownership)
    const matchingHistory = history
      .filter(record => record.ownership?.tenantId === ownership.tenantId && record.ownership.siteId === ownership.siteId &&
        record.device.vendor === 'Shelly' && record.device.id.toLowerCase() === physicalId.toLowerCase() &&
        record.device.components?.some(item => item.component === component) &&
        record.device.observations?.some(item =>
          ['http_rpc', 'http_identity'].includes(item.source) &&
          ['shelly.device_id', 'identity.device_id'].includes(item.attribute) &&
          typeof item.value === 'string' && item.value.toLowerCase() === physicalId.toLowerCase(),
        ),
      )
      .map(record => ({
        record,
        candidate: shellyLanCandidates(record.device).find(item => item.id === candidateId),
      }))
      .filter((item): item is { record: typeof item.record; candidate: NonNullable<typeof item.candidate> } => !!item.candidate)
      .sort((a, b) => b.record.lastSeenAt.localeCompare(a.record.lastSeenAt))[0]
    if (!matchingHistory) throw new ConflictException('No saved site-owned LAN evidence supports this physical identity and verified component.')
    const priorCandidate = matchingHistory.candidate
    const candidate = registered || priorCandidate
    const candidatePhysicalId = typeof candidate.metadata?.physicalId === 'string' ? candidate.metadata.physicalId : ''
    const candidateComponent = typeof candidate.metadata?.component === 'string' ? candidate.metadata.component : ''
    const ipAddress = typeof candidate.metadata?.ipAddress === 'string' ? candidate.metadata.ipAddress : ''
    if (candidatePhysicalId.toLowerCase() !== physicalId.toLowerCase() || candidateComponent !== component ||
        ipAddress !== matchingHistory.record.device.ipAddress || isIP(ipAddress) !== 4) {
      throw new ConflictException('The pending candidate does not match the latest saved physical identity, component, and endpoint evidence.')
    }
    const prior = matchingHistory.record
    const zone = this.getConfiguredZone(prior.device.networkZoneId)
    if (!zone || !ipIsInZone(ipAddress, zone)) {
      throw new BadRequestException('The saved endpoint is no longer inside an authorized network scope.')
    }
    const virtualLab = zone.collectionSource === 'virtual-lab'
    if (virtualLab && process.env.HOME_VIRTUAL_LAB_ENABLED !== 'true') {
      throw new BadGatewayException('Virtual Lab selected-device verification is disabled.')
    }
    if (virtualLab && !zone.seedIps.includes(ipAddress)) {
      throw new BadRequestException('The saved endpoint is not one of the explicitly configured Virtual Lab targets.')
    }
    if (!inventory && !virtualLab) {
      throw new ConflictException('No unique site-owned physical inventory record matches this Shelly identity.')
    }
    if (inventory && !inventory.components.some(item => item.key === component)) {
      throw new ConflictException(`Physical inventory ${inventory.physicalDeviceId} has no expected ${component} component.`)
    }
    if (inventory) {
      const componentAssignments = inventory.assignments.filter(item => item.componentKey === component)
      if (componentAssignments.some(item => item.deviceId !== candidateId)) {
        throw new ConflictException(`Physical inventory component ${component} is already assigned to another logical device.`)
      }
      const assignments = inventory.assignments.filter(item => item.deviceId === candidateId)
      if (assignments.length > 1 || assignments.some(item =>
        item.physicalDeviceId !== inventory.physicalDeviceId || item.componentKey !== component,
      )) {
        throw new ConflictException('The selected logical component has a conflicting physical inventory assignment.')
      }
    }

    const expectedKeys = (inventory?.components.map(item => item.key) || prior.device.components?.map(item => item.component) || [])
      .filter((key): key is string => /^(?:switch|em1):\d+$/.test(key))
      .filter((key, index, values) => values.indexOf(key) === index)
      .sort()
    if (!expectedKeys.includes(component)) {
      throw new ConflictException('The saved site-owned profile has no supported evidence for the selected component.')
    }

    let identity: NonNullable<ReturnType<typeof readOnlyShellyRpcDeviceInfoFromBody>>
    let componentEvidence: ShellyComponentProbeEvidence | undefined
    let observerIdentity: { id: string; host: string; interfaceName: string } | undefined
    const observationSource: 'http_rpc' | 'site_local_http_rpc' = virtualLab ? 'site_local_http_rpc' : 'http_rpc'
    if (virtualLab) {
      const remote = await this.virtualLabEvidence.verifyShellyComponent(zone, ipAddress, physicalId, expectedKeys, signal)
      const parsedIdentity = readOnlyShellyRpcDeviceInfoFromBody(remote.identity)
      if (!parsedIdentity) throw new ConflictException(`The Virtual Lab observer returned an invalid Shelly.GetDeviceInfo response for ${ipAddress}.`)
      identity = parsedIdentity
      observerIdentity = remote.observer
      const observedKeys = remote.componentKeys.slice().sort()
      if (observedKeys.length !== expectedKeys.length || observedKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new ConflictException(`RPC component profile mismatch: saved evidence expects [${expectedKeys.join(', ')}], device reports [${observedKeys.join(', ')}]. No evidence or inventory changes were saved.`)
      }
      const verifiedAt = new Date().toISOString()
      componentEvidence = shellyComponentEvidenceFromRpcStatuses(expectedKeys, remote.componentStatuses, zone.id, zone.interfaceName || remote.observer.interfaceName, verifiedAt, 'site_local_http_rpc')
      if (componentEvidence.failureReason) throw new BadGatewayException(componentEvidence.failureReason)
    } else {
      const reachability = await probeTcpConnection(ipAddress, 80, 1_500, signal)
      if (reachability.status !== 'connected') {
        throw new BadGatewayException(reachability.message || `The observer could not connect to ${ipAddress}:80.`)
      }
      const identityRead = await readOnlyShellyRpcDeviceInfo(ipAddress, 1_500, signal)
      if (identityRead.status === 'timeout') {
        throw new GatewayTimeoutException(`Shelly.GetDeviceInfo timed out at ${ipAddress} after 1.5 seconds.`)
      }
      if (identityRead.status === 'unavailable') {
        throw new BadGatewayException(`The observer connected to ${ipAddress}:80, but could not complete the Shelly.GetDeviceInfo RPC.`)
      }
      if (identityRead.status !== 'verified') {
        throw new ConflictException(`The endpoint at ${ipAddress} did not return a valid Shelly.GetDeviceInfo response.`)
      }
      identity = identityRead.info
    }
    if (identity.id?.toLowerCase() !== physicalId.toLowerCase() || typeof identity.gen !== 'number' || identity.gen < 2) {
      throw new ConflictException(`Fresh RPC identity mismatch at ${ipAddress}: expected ${physicalId}; no evidence was saved.`)
    }
    if (identity.method !== 'GET /rpc/Shelly.GetDeviceInfo') {
      throw new ConflictException('The endpoint did not answer Shelly.GetDeviceInfo over RPC; no evidence was saved.')
    }
    const expectedMac = [candidate.metadata?.deviceReportedMacAddress, candidate.metadata?.macAddress]
      .find((value): value is string => typeof value === 'string' && !!value.trim())
    if (expectedMac && (!identity.mac || normalizeMacAddress(expectedMac) !== normalizeMacAddress(identity.mac))) {
      throw new ConflictException('The device-reported MAC differs from the known physical candidate; no evidence was saved.')
    }
    if (!componentEvidence) {
      const savedInterfaceName = prior.device.observations?.find(item =>
        item.attribute === 'shelly.device_id' && item.interfaceName,
      )?.interfaceName
      componentEvidence = await probeShellyComponentsWithEvidence(ipAddress, zone.id, savedInterfaceName, signal)
      if (componentEvidence.failureReason) throw new BadGatewayException(componentEvidence.failureReason)
    }
    const observedKeys = componentEvidence.components.map(item => item.component).sort()
    if (expectedKeys.length === 0) {
      throw new ConflictException('Saved site-owned evidence has no supported Shelly switch or EM1 components to verify.')
    }
    if (!observedKeys.includes(component) || expectedKeys.some(key => !observedKeys.includes(key)) ||
        observedKeys.some(key => !expectedKeys.includes(key))) {
      throw new ConflictException(`RPC component profile mismatch: inventory expects [${expectedKeys.join(', ')}], device reports [${observedKeys.join(', ')}]. No evidence or inventory changes were saved.`)
    }
    throwIfScanAborted(signal)

    const completedAt = new Date().toISOString()
    const identityVerifiedAt = identity.observedAt || completedAt
    const componentsVerifiedAt = componentEvidence.observations
      .filter(item => item.attribute === 'shelly.component_status')
      .map(item => item.observedAt).sort().at(-1) || completedAt
    const verifiedDevice: NetworkDiscoveredDevice = {
      ...prior.device,
      id: physicalId,
      ipAddress,
      networkZoneId: zone.id,
      networkZoneName: zone.name,
      vendor: 'Shelly',
      protocol: 'http',
      status: 'online',
      generation: identity.gen,
      model: identity.model || prior.device.model,
      app: identity.app || prior.device.app,
      firmwareVersion: identity.firmware || prior.device.firmwareVersion,
      macAddress: identity.mac || prior.device.macAddress,
      deviceReportedMacAddress: identity.mac || prior.device.deviceReportedMacAddress,
      components: componentEvidence.components,
      discoveredAt: completedAt,
      reason: 'Fresh read-only Shelly RPC identity and component status verified from the selected candidate endpoint.',
      observations: [
        ...(prior.device.observations || []),
        ...(observerIdentity ? [{ source: 'site_local_http_rpc' as const, attribute: 'observer.identity', value: observerIdentity.id, observedAt: identityVerifiedAt, scopeId: zone.id }] : []),
        { source: observationSource, attribute: 'shelly.device_id', value: physicalId, observedAt: identityVerifiedAt, scopeId: zone.id, method: identity.method || 'GET /rpc/Shelly.GetDeviceInfo' },
        ...(identity.mac ? [{ source: observationSource, attribute: 'shelly.device_reported_mac', value: identity.mac, observedAt: identityVerifiedAt, scopeId: zone.id, method: identity.method || 'GET /rpc/Shelly.GetDeviceInfo' }] : []),
        ...componentEvidence.observations,
      ],
    }
    const candidates = shellyLanCandidates(verifiedDevice)
    if (!candidates.some(item => item.id === candidateId)) {
      throw new ConflictException('Fresh RPC evidence did not reproduce the selected logical component candidate.')
    }
    throwIfScanAborted(signal)
    const scanId = randomUUID()
    const savedInterfaceName = prior.device.observations?.find(item =>
      item.attribute === 'shelly.device_id' && item.interfaceName,
    )?.interfaceName
    await this.discoveryMemory.recordScan(completedAt, [verifiedDevice], ownership)
    throwIfScanAborted(signal)
    await this.discoveryMemory.recordSnapshot({
      schemaVersion: 2, scanId, ownership, startedAt: completedAt, completedAt,
      collector: observerIdentity
        ? { id: observerIdentity.id, host: observerIdentity.host, interfaces: [observerIdentity.interfaceName] }
        : { id: `${localHostname()}/${savedInterfaceName || 'interface-unknown'}`, host: localHostname(), interfaces: savedInterfaceName ? [savedInterfaceName] : [] },
      scopes: [{ id: zone.id, name: zone.name, ...(zone.cidr ? { cidr: zone.cidr } : {}), ...(zone.collectionSource ? { collectionSource: zone.collectionSource } : {}), complete: false, gatewayIpsObserved: [],
        collectionStages: { hostDiscovery: { durationMs: 0, complete: false, targetCount: 0, hostsReported: 0 },
          serviceEnrichment: { durationMs: 0, complete: true, targetCount: 1, hostsReported: 1 } } }],
      methods: ['operator_selected_shelly_read_only_rpc'], successes: 1, failures: [],
      limitations: ['One previously observed endpoint was revalidated; no subnet discovery was run.'],
      rawEvidence: [], rawEvidenceOmitted: 0, endpoints: [verifiedDevice], topology: { relationships: [] },
    })
    throwIfScanAborted(signal)
    const verifiedInventory = await this.physicalInventory.discover({
      scope: ownership, ...(inventory ? { physicalDeviceId: inventory.physicalDeviceId } : {}),
      identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId }, vendor: 'Shelly',
      hardwareModel: identity.model || inventory?.hardwareModel, firmwareVersion: identity.firmware || inventory?.firmwareVersion,
      evidenceSource: 'selected_device_read_only_rpc_verification', observedAt: completedAt,
      components: candidates.map(item => ({ key: String(item.metadata?.component), capabilities: item.capabilities || [] })),
      endpoint: { protocol: 'http', kind: 'rpc', address: `http://${ipAddress}` },
    })
    throwIfScanAborted(signal)
    await this.physicalInventory.refreshNetworkObservations(ownership, [{
      physicalDeviceId: verifiedInventory.physicalDeviceId, ipAddress, ...(identity.mac ? { macAddress: normalizeMacAddress(identity.mac) } : {}),
      networkScope: `${prior.device.gatewayId || observerIdentity?.id || 'gateway-unknown'}:${zone.id}`, observedAt: completedAt, evidenceSource: 'selected_device_read_only_rpc_verification',
    }])
    throwIfScanAborted(signal)
    const activeSiteName = this.registry.getSnapshot().site.name
    for (const item of candidates) this.registry.registerDiscoveredDevice({
      ...item, tenantId: ownership.tenantId, siteId: ownership.siteId, siteName: activeSiteName,
    })
    return { status: 'verified' as const, scanId, physicalId, physicalDeviceId: verifiedInventory.physicalDeviceId,
      componentKeys: observedKeys, identityVerifiedAt, componentsVerifiedAt }
  }

  readVirtualLabEnergridHttpEvidence(
    scopeId: string,
    targetIp: string,
    physicalId: string,
    signal?: AbortSignal,
  ): Promise<VirtualLabEnergridHttpEvidence> {
    if (process.env.HOME_VIRTUAL_LAB_ENABLED !== 'true') {
      throw new Error('Virtual Lab HTTP polling is disabled.')
    }
    const zone = this.getConfiguredZone(scopeId)
    if (!zone || zone.collectionSource !== 'virtual-lab') {
      throw new Error('Virtual Lab HTTP polling requires a configured virtual network scope.')
    }
    return this.virtualLabEvidence.readEnergridHttpEvidence(zone, targetIp, physicalId, signal)
  }

  getNmapCapability(): Promise<NmapCapability & { enabled: boolean }> {
    return this.evidenceCollector.getNmapCapability()
  }

  getRuntimeCapabilities(): ReturnType<DeviceLanNetworkEvidenceCollector['getRuntimeCapabilities']> {
    return this.evidenceCollector.getRuntimeCapabilities(this.getZones())
  }

  async scanNow(options: { scopeIds?: string[]; fullSubnetConfirmed?: boolean; signal?: AbortSignal } = {}): Promise<{
    scannedAt: string
    zones: NetworkDiscoveryZone[]
    devices: NetworkDiscoveredDevice[]
    snapshot: NetworkDiscoverySnapshot
    comparison: NetworkDiscoverySnapshotDiff | null
  }> {
    const startedAt = new Date().toISOString()
    const scanId = randomUUID()
    // Capture the server-authorized owner once, before collection starts. Network
    // scope IDs below describe vantage/network identity, not site ownership.
    const registryAtStart = this.registry.getSnapshot()
    const ownership = { tenantId: registryAtStart.tenant.id, siteId: registryAtStart.site.id }
    const configuredZones = configuredNetworkZones()
    if (configuredZones.length === 0) {
      throw new BadRequestException('No network scan scopes are configured')
    }
    const zones = selectScanZones(configuredZones, options.scopeIds)
    if (zones.some(zone => zone.cidr && zone.collectionSource !== 'virtual-lab') && options.fullSubnetConfirmed !== true) {
      throw new BadRequestException('Full-subnet discovery requires explicit operator confirmation')
    }
    const virtualLabZones = zones.filter(zone => zone.collectionSource === 'virtual-lab')
    if (virtualLabZones.length && (virtualLabZones.length !== 1 || zones.length !== 1)) {
      throw new BadRequestException('Virtual Lab scans must run separately from local network scopes')
    }
    let virtualLabResult: VirtualLabScanResult | undefined
    const evidence = virtualLabZones.length
      ? (virtualLabResult = await this.virtualLabEvidence.scan(virtualLabZones[0], options.signal), {
          candidates: virtualLabResult.candidates as NetworkCandidate[],
          nmap: virtualLabResult.nmap,
          runtime: undefined,
        })
      : await this.evidenceCollector.collectEvidence(zones, options.signal)
    throwIfScanAborted(options.signal)
    const nmapHostDiscoverySelected = !!virtualLabResult ||
      (process.env.HOME_NMAP_ENABLED === 'true' && evidence.nmap.capability.available)
    const discoveredCandidates = evidence.candidates
    const endpointCandidates = mergeNeighborCandidates(discoveredCandidates)
    const identityCandidates = identityCandidatesForScan(discoveredCandidates)
    const conflictingEndpoints = new Set(endpointCandidates
      .filter(candidate => (candidate.macEvidence || []).length > 1)
      .map(candidate => `${candidate.networkZoneId}:${candidate.ipAddress}`))
    const devices = virtualLabResult?.devices || await Promise.all(
      identityCandidates.map(async (candidate) => {
        const matchesExplicitScope = candidateMatchesExplicitScope(candidate, zones)
        return this.evidenceCollector.enrichCandidate(candidate as NetworkCandidate & {
          networkZoneId: string
          networkZoneName: string
        }, startedAt,
        !conflictingEndpoints.has(`${candidate.networkZoneId}:${candidate.ipAddress}`) && matchesExplicitScope,
        matchesExplicitScope,
        options.signal)
      }),
    )
    throwIfScanAborted(options.signal)

    this.lastZones = configuredZones
    this.lastScan = addNmapEndpointEvidence(
      dedupeNetworkDevices(devices),
      discoveredCandidates.filter(candidate => candidate.evidenceSource === 'nmap'),
    )
    this.lastScanOwnership = ownership
    const boundedEvidence = buildBoundedRawEvidence(discoveredCandidates, this.lastScan, startedAt)
    throwIfScanAborted(options.signal)
    const completedAt = new Date().toISOString()
    await this.discoveryMemory.recordScan(completedAt, devices.map(device => {
      const observations = (device.observations || []).filter(item => item.method !== 'nmap_tcp_connect_service_scan')
      return { ...device, ...(observations.length ? { observations } : { observations: undefined }) }
    }), ownership)
    throwIfScanAborted(options.signal)
    if (this.physicalInventory && !virtualLabResult) {
      try {
        const scope = ownership
        const observations: PhysicalLanObservation[] = []
        for (const device of this.lastScan) {
          throwIfScanAborted(options.signal)
          const candidates = shellyLanCandidates(device)
          const first = candidates[0]
          const physicalId = first?.metadata?.physicalId
          if (!first || typeof physicalId !== 'string') continue
          const record = await this.physicalInventory.discover({
            scope,
            identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
            evidenceSource: 'lan_discovery_protocol_identity',
            observedAt: device.discoveredAt,
            components: candidates.flatMap(candidate => {
              const key = candidate.metadata?.component
              return typeof key === 'string' ? [{ key, capabilities: candidate.capabilities ?? [] }] : []
            }),
            endpoint: {
              protocol: 'http',
              kind: 'rpc',
              address: String(first.metadata?.httpBaseUrl || first.target || ''),
            },
          })
          observations.push({
            physicalDeviceId: record.physicalDeviceId,
            ipAddress: device.ipAddress,
            ...(device.macAddress ? { macAddress: device.macAddress } : {}),
            ...(device.hostname ? { hostname: device.hostname } : {}),
            ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
            networkScope: `${device.gatewayId || 'gateway-unknown'}:${device.networkZoneId}`,
            observedAt: device.discoveredAt,
            evidenceSource: 'lan_discovery_protocol_match',
          })
        }
        const registeredDevices = this.registry.getSnapshot().devices
        for (const device of this.lastScan) {
          throwIfScanAborted(options.signal)
          const candidate = energridDiscoveryCandidate(device)
          if (!candidate) continue
          const enrolled = registeredDevices.find(item =>
            item.id === candidate.id && item.trustStatus === 'approved' &&
            item.metadata?.identityEvidenceSource === 'bounded GET /api/v1/identity',
          )
          if (!enrolled) continue
          const physical = await this.physicalInventory.forLogicalDevice(scope, enrolled.id)
          if (!physical) continue
          observations.push({
            physicalDeviceId: physical.physicalDeviceId,
            ipAddress: device.ipAddress,
            ...(device.macAddress ? { macAddress: device.macAddress } : {}),
            ...(device.hostname ? { hostname: device.hostname } : {}),
            ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
            networkScope: String(candidate.metadata?.networkScope || device.networkZoneId),
            observedAt: String(candidate.metadata?.networkObservedAt || device.discoveredAt),
            evidenceSource: 'bounded_http_identity',
          })
        }
        await this.physicalInventory.refreshNetworkObservations(
          scope,
          observations,
        )
      } catch (error) {
        this.logger.warn(
          `Could not refresh associated network identity evidence: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
        throw error
      }
    }
    throwIfScanAborted(options.signal)
    const collectorInterfaces = virtualLabResult?.collector.interfaces || [...new Set([
      ...interfacesForZones(zones),
      ...evidence.nmap.scopes.flatMap(scope => scope.interfaceName ? [scope.interfaceName] : []),
    ])].sort()
    const nmapScopeById = new Map(evidence.nmap.scopes.map(scope => [scope.scopeId, scope]))
    const snapshot: NetworkDiscoverySnapshot = {
      schemaVersion: 2,
      scanId,
      ownership,
      startedAt,
      completedAt: new Date().toISOString(),
      collector: virtualLabResult?.collector || {
        id: `${localHostname()}/${collectorInterfaces.join(',') || 'interface-unknown'}`,
        host: localHostname(),
        interfaces: collectorInterfaces,
      },
      scopes: zones.map(zone => ({
        id: zone.id,
        name: zone.name,
        ...(zone.cidr ? { cidr: zone.cidr } : {}),
        ...((nmapScopeById.get(zone.id)?.interfaceName || interfaceForZone(zone))
          ? { interfaceName: nmapScopeById.get(zone.id)?.interfaceName || interfaceForZone(zone) }
          : {}),
        ...(zone.role ? { role: zone.role } : {}),
        ...(zone.collectionSource ? { collectionSource: zone.collectionSource } : {}),
        ...(nmapScopeById.get(zone.id) ? { collectionStages: {
          hostDiscovery: toSnapshotStage(nmapScopeById.get(zone.id)!.hostDiscovery),
          serviceEnrichment: toSnapshotStage(nmapScopeById.get(zone.id)!.serviceEnrichment),
        } } : {}),
        complete: nmapHostDiscoverySelected
          ? (nmapScopeById.get(zone.id)?.complete === true)
          : scanScopeComplete(zone),
        gatewayIpsObserved: [...new Set(this.lastScan
          .filter(device => device.networkZoneId === zone.id && device.gatewayId && isIpv4Address(device.gatewayId))
          .map(device => device.gatewayId!))].sort(),
      })),
      methods: [...new Set([
        ...(virtualLabResult ? virtualLabMethods(virtualLabResult) : discoveryMethods(zones, !nmapHostDiscoverySelected)),
        ...evidence.nmap.methods,
      ])].sort(),
      successes: this.lastScan.length,
      failures: evidence.nmap.failures,
      limitations: [
        ...(virtualLabResult ? virtualLabLimitations(zones, virtualLabResult) : scanLimitations(zones)),
        ...evidence.nmap.limitations,
        ...(boundedEvidence.omitted ? [`Raw candidate evidence was bounded; ${boundedEvidence.omitted} record(s) omitted.`] : []),
      ],
      rawEvidence: boundedEvidence.records,
      rawEvidenceOmitted: boundedEvidence.omitted,
      endpoints: structuredClone(this.lastScan),
      topology: { relationships: [] },
      ...(virtualLabResult?.runtime ? { runtime: virtualLabResult.runtime } : evidence.runtime ? { runtime: evidence.runtime } : {}),
    }
    throwIfScanAborted(options.signal)
    await this.discoveryMemory.recordSnapshot(snapshot)
    const previousSnapshots = await this.discoveryMemory.listSnapshots(ownership, 100)
    const previous = previousSnapshots.find(item => item.scanId !== scanId &&
      item.scopes.some(previousScope => zones.some(zone => previousScope.id === zone.id && previousScope.cidr === zone.cidr)))
    const comparison = previous ? compareNetworkSnapshots(previous, snapshot) : null
    this.logger.log(`[LAN DISCOVERY] zones=${zones.length} devices=${this.lastScan.length}`)

    return {
      scannedAt: startedAt,
      zones,
      devices: this.lastScan,
      snapshot,
      comparison,
    }
  }
}

export function parseArpOutput(output: string): Array<{
  ipAddress: string
  macAddress?: string
  hostname?: string
  interfaceName?: string
}> {
  const devices: Array<{
    ipAddress: string
    macAddress?: string
    hostname?: string
    interfaceName?: string
  }> = []

  for (const line of output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)) {
    const mac = line.match(/(?:at|lladdr)\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i)?.[1]
    const ip = line.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)/)?.[1] ||
      line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s/)?.[1]
    const hostname = line.match(/^([^\s(]+)\s+\(/)?.[1]
    const interfaceName = line.match(/\bon\s+(\S+)/i)?.[1] ||
      line.match(/\bdev\s+(\S+)/i)?.[1]
    const cleanHostname = hostname && hostname !== '?' ? hostname : undefined

    if (!ip || !isUsefulLanIp(ip)) continue
    if (!mac && !cleanHostname) continue

    devices.push({
      ipAddress: ip,
      macAddress: mac?.split(':').map(octet => octet.padStart(2, '0')).join(':').toLowerCase(),
      hostname: cleanHostname,
      interfaceName,
    })
  }

  return devices
}

export function parseRouterClientsJson(value: string | undefined): NetworkCandidate[] {
  if (!value) return []

  try {
    const parsed = JSON.parse(value)
    const clients = Array.isArray(parsed) ? parsed : parsed?.clients || parsed?.devices || parsed?.leases
    if (!Array.isArray(clients)) return []

    return clients
      .map((item) => normalizeRouterClient(item))
      .filter((client): client is NetworkCandidate => !!client)
  } catch {
    return []
  }
}

async function readNeighborTable(includeConfiguredSeeds = true): Promise<Array<{
  ipAddress: string
  macAddress?: string
  hostname?: string
}>> {
  const commands: Array<[string, string[]]> = [
    ['arp', ['-a']],
    ['ip', ['neigh']],
  ]

  for (const [command, args] of commands) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 10000 })
      const devices = [
        ...parseArpOutput(stdout),
        ...(includeConfiguredSeeds ? configuredSeedHosts() : []),
      ]
      if (devices.length > 0) return devices
    } catch {
      // Try the next platform-specific command.
    }
  }

  return includeConfiguredSeeds ? configuredSeedHosts() : []
}

async function readRouterClientCandidates(): Promise<NetworkCandidate[]> {
  const inlineClients = parseRouterClientsJson(process.env.HOME_ROUTER_CLIENTS_JSON)
  const fileClients = process.env.HOME_ROUTER_CLIENTS_FILE
    ? await readRouterClientFile(process.env.HOME_ROUTER_CLIENTS_FILE)
    : []
  const commandClients = process.env.HOME_ROUTER_CLIENTS_COMMAND
    ? await readRouterClientCommand(
        process.env.HOME_ROUTER_CLIENTS_COMMAND,
        process.env.HOME_ROUTER_CLIENTS_COMMAND_ARGS,
      )
    : []

  return [
    ...inlineClients,
    ...fileClients,
    ...commandClients,
  ]
}

async function readRouterClientFile(filePath: string): Promise<NetworkCandidate[]> {
  try {
    return parseRouterClientsJson(await readFile(filePath, 'utf8'))
  } catch {
    return []
  }
}

async function readRouterClientCommand(command: string, argsValue: string | undefined): Promise<NetworkCandidate[]> {
  try {
    const args = String(argsValue || '')
      .split(' ')
      .map((item) => item.trim())
      .filter(Boolean)
    const { stdout } = await execFileAsync(command, args, { timeout: 15000 })
    return parseRouterClientsJson(stdout)
  } catch {
    return []
  }
}

function configuredSeedHosts(): Array<{
  ipAddress: string
  macAddress?: string
  hostname?: string
}> {
  return String(process.env.HOME_LAN_SCAN_IPS || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(item))
    .filter(isUsefulLanIp)
    .map((ipAddress) => ({ ipAddress }))
}

function configuredNetworkZones(): NetworkDiscoveryZone[] {
  const parsed = parseNetworkZones(process.env.HOME_NETWORK_ZONES_JSON)
  const configured = parsed.filter(zone =>
    zone.collectionSource !== 'virtual-lab' || process.env.HOME_VIRTUAL_LAB_ENABLED === 'true',
  )
  const virtualLab = process.env.HOME_VIRTUAL_LAB_ENABLED === 'true'
    ? parseNetworkZones(process.env.HOME_VIRTUAL_LAB_SCOPE_JSON).filter(zone => zone.collectionSource === 'virtual-lab')
    : []
  const configuredScopes = [...configured, ...virtualLab.filter(zone => !configured.some(item => item.id === zone.id))]
  if (configuredScopes.length > 0) return configuredScopes

  const cidrs = String(process.env.HOME_LAN_SCAN_SUBNETS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const inferredZones = inferNetworkZonesFromInterfaces()
  if (cidrs.length === 0) {
    const seedIps = configuredSeedHosts().map(host => host.ipAddress)
    return seedIps.length > 0 ? [{
      id: 'configured-endpoints',
      name: 'Configured endpoints',
      seedIps,
      role: 'primary',
    }] : []
  }

  return cidrs.map((cidr, index) => {
    const local = inferredZones.find(zone => zone.cidr === cidr)
    const fallbackId = index === 0 ? 'local-network' : `network-${index + 1}`
    return {
      id: local?.id || fallbackId,
      name: local?.name || (index === 0 ? 'Local network' : `Network ${index + 1}`),
      cidr,
      ...(local?.interfaceName ? { interfaceName: local.interfaceName } : {}),
      seedIps: index === 0 ? configuredSeedHosts().map(host => host.ipAddress) : [],
      role: index === 0 ? 'primary' as const : 'iot' as const,
    }
  })
}

function selectScanZones(zones: NetworkDiscoveryZone[], scopeIds?: string[]): NetworkDiscoveryZone[] {
  if (!scopeIds?.length) return zones
  const requested = [...new Set(scopeIds.map(id => id.trim()).filter(Boolean))]
  const selected = zones.filter(zone => requested.includes(zone.id))
  if (selected.length !== requested.length || selected.length === 0) {
    throw new BadRequestException('Select one or more configured network scopes')
  }
  return selected
}

function scanScopeComplete(zone: NetworkDiscoveryZone): boolean {
  if (process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false' || !zone.cidr) return false
  const prefix = Number(zone.cidr.split('/')[1])
  if (!Number.isInteger(prefix) || prefix < 24 || prefix > 30) return false
  return ipsInCidr(zone.cidr).length === (2 ** (32 - prefix)) - 2
}

function interfaceForZone(zone: NetworkDiscoveryZone): string | undefined {
  if (zone.interfaceName) return zone.interfaceName
  if (!zone.cidr) return undefined
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (addresses?.some(address => !address.internal && address.family === 'IPv4' && ipInCidr(address.address, zone.cidr!))) {
      return name
    }
  }
  return undefined
}

function interfacesForZones(zones: NetworkDiscoveryZone[]): string[] {
  return [...new Set(zones.map(interfaceForZone).filter((value): value is string => !!value))].sort()
}

function toSnapshotStage(stage: {
  durationMs: number; complete: boolean; targetCount: number; hostsReported: number; failure?: string;
}): NonNullable<NetworkDiscoverySnapshot['scopes'][number]['collectionStages']>['hostDiscovery'] {
  return {
    durationMs: stage.durationMs,
    complete: stage.complete,
    targetCount: stage.targetCount,
    hostsReported: stage.hostsReported,
    ...(stage.failure ? { failure: stage.failure } : {}),
  }
}

function discoveryMethods(zones: NetworkDiscoveryZone[], includeActiveProbes = true): string[] {
  const methods = ['neighbor_table', 'reverse_dns', 'tcp_service_probe', 'shelly_http_rpc']
  if (includeActiveProbes && process.env.HOME_LAN_ACTIVE_SCAN_ENABLED !== 'false') methods.push('icmp', 'tcp_reachability')
  if (process.env.HOME_ROUTER_CLIENTS_JSON || process.env.HOME_ROUTER_CLIENTS_FILE || process.env.HOME_ROUTER_CLIENTS_COMMAND) methods.push('router_clients')
  if (zones.some(zone => zone.seedIps.length > 0)) methods.push('seed_ip')
  return methods.sort()
}

function scanLimitations(zones: NetworkDiscoveryZone[]): string[] {
  const limitations = [
    'Neighbor-table evidence is local to the collector interface; routed segments require router or on-segment evidence for MAC attribution.',
    'No remote network observer is configured; visibility is limited to this runtime and its reachable routes.',
    'Router and neighbor-table source errors are not currently reported separately from empty results.',
    'Physical links and wired/Wi-Fi attachment are not collected; topology relationships remain unknown.',
  ]
  if (process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false') limitations.push('Active ICMP/TCP subnet probing is disabled.')
  for (const zone of zones) {
    if (zone.cidr && !scanScopeComplete(zone)) limitations.push(`Scope ${zone.id} was not fully enumerated within the supported bounded host limit.`)
  }
  if (!process.env.HOME_ROUTER_CLIENTS_JSON && !process.env.HOME_ROUTER_CLIENTS_FILE && !process.env.HOME_ROUTER_CLIENTS_COMMAND) {
    limitations.push('No router DHCP/client feed is configured for this collector.')
  }
  return [...new Set(limitations)]
}

function sanitizeCandidateEvidence(candidate: NetworkCandidate): Record<string, unknown> {
  const allowed = [
    'ipAddress', 'macAddress', 'hostname', 'hostnameEvidence', 'macEvidence',
    'vendor', 'model', 'protocol', 'confidence', 'status', 'firmwareVersion',
    'app', 'generation', 'components', 'deviceReportedMacAddress', 'reason',
    'networkZoneId', 'networkZoneName', 'interfaceName', 'evidenceSource', 'observedAt',
    'observations',
  ] as const
  return Object.fromEntries(allowed.flatMap(field =>
    candidate[field] === undefined ? [] : [[field, candidate[field]]],
  ))
}

function buildBoundedRawEvidence(
  candidates: NetworkCandidate[],
  devices: NetworkDiscoveredDevice[],
  fallbackObservedAt: string,
): { records: NetworkDiscoverySnapshot['rawEvidence']; omitted: number } {
  const records: NetworkDiscoverySnapshot['rawEvidence'] = []
  let bytes = 0
  let omitted = 0
  const evidenceRecords: NetworkDiscoverySnapshot['rawEvidence'] = candidates.map(candidate => ({
    observedAt: candidate.observedAt || fallbackObservedAt,
    source: candidate.evidenceSource || 'collector_result',
    scopeId: candidate.networkZoneId || 'unknown',
    evidence: sanitizeCandidateEvidence(candidate),
  }))
  for (const device of devices.filter(item => item.vendor === 'Shelly' && item.protocol === 'http')) {
    evidenceRecords.push({
      observedAt: device.discoveredAt,
      source: 'shelly_http_rpc',
      scopeId: device.networkZoneId,
      evidence: {
        protocolId: device.id,
        deviceReportedMacAddress: device.deviceReportedMacAddress,
        model: device.model,
        generation: device.generation,
        components: device.components,
        observations: device.observations,
      },
    })
  }
  for (const record of evidenceRecords) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record))
    if (records.length >= 2048 || bytes + recordBytes > 1024 * 1024) {
      omitted++
      continue
    }
    records.push(record)
    bytes += recordBytes
  }
  return { records, omitted }
}

function isIpv4Address(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}


export function configuredNetworkZoneForAddress(ipAddress: string): NetworkDiscoveryZone | null {
  const zones = configuredNetworkZones()
  if (!candidateBelongsToConfiguredZone({ ipAddress }, zones)) return null
  const zone = zones.find(candidate => candidateMatchesZone({ ipAddress }, candidate))
  if (!zone || zone.seedIps.includes(ipAddress) || zone.gatewayIps?.includes(ipAddress)) return null
  return zone
}

export function parseNetworkZones(value: string | undefined): NetworkDiscoveryZone[] {
  if (!value) return []

  try {
    const parsed = JSON.parse(value)
    const zones = Array.isArray(parsed) ? parsed : parsed?.zones
    if (!Array.isArray(zones)) return []

    return zones
      .map((item, index) => normalizeNetworkZone(item, index))
      .filter((zone): zone is NetworkDiscoveryZone => !!zone)
  } catch {
    return []
  }
}

function normalizeNetworkZone(item: unknown, index: number): NetworkDiscoveryZone | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as {
    id?: string
    name?: string
    cidr?: string
    interfaceName?: string
    interface?: string
    seedIps?: string[]
    seeds?: string[]
    gatewayIps?: string[]
    role?: NetworkDiscoveryZone['role']
    collectionSource?: NetworkDiscoveryZone['collectionSource']
  }

  const id = safeZoneId(raw.id || raw.name || `network-${index + 1}`)
  const seedIps = [...(raw.seedIps || []), ...(raw.seeds || [])]
    .filter((ipAddress) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipAddress))
    .filter(isUsefulLanIp)
  const configuredGateways = Array.isArray(raw.gatewayIps)
    ? raw.gatewayIps.filter((ipAddress): ipAddress is string => typeof ipAddress === 'string')
    : []
  const gatewayIps = [...new Set(configuredGateways)]
    .filter((ipAddress) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipAddress))
    .filter(isUsefulLanIp)

  return {
    id,
    name: raw.name || displayNameFromZoneId(id),
    cidr: raw.cidr,
    interfaceName: raw.interfaceName || raw.interface,
    seedIps,
    gatewayIps,
    role: raw.role,
    ...(raw.collectionSource === 'virtual-lab' ? { collectionSource: 'virtual-lab' as const } : {}),
  }
}

function virtualLabMethods(result: VirtualLabScanResult): string[] {
  const methods = [...result.nmap.methods]
  for (const observation of result.devices.flatMap(device => device.observations || [])) {
    if (observation.method && !methods.includes(observation.method)) methods.push(observation.method)
  }
  return methods
}

function virtualLabLimitations(zones: NetworkDiscoveryZone[], result: VirtualLabScanResult): string[] {
  return [
    ...scanLimitations(zones).filter(item => !item.startsWith('No remote network observer is configured')),
    `The remote observer queried only the ${zones[0].seedIps.length} explicitly configured virtual-device addresses; other addresses in ${zones[0].cidr} were not scanned.`,
    ...result.nmap.limitations,
  ]
}

function isBroadcastInZones(
  ipAddress: string,
  zones: NetworkDiscoveryZone[],
): boolean {
  return zones.some((zone) => {
    if (!zone.cidr) return false
    const [network, prefixText] = zone.cidr.split('/')
    const prefix = Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 30) return false

    const toNumber = (value: string): number | null => {
      const octets = value.split('.').map(Number)
      if (octets.length !== 4 || octets.some((part) =>
        !Number.isInteger(part) || part < 0 || part > 255
      )) return null
      return octets.reduce((result, part) => ((result << 8) | part) >>> 0, 0)
    }

    const networkNumber = toNumber(network)
    const ipNumber = toNumber(ipAddress)
    if (networkNumber === null || ipNumber === null) return false

    const mask = (0xffffffff << (32 - prefix)) >>> 0
    const broadcast = ((networkNumber & mask) | (~mask >>> 0)) >>> 0
    return ipNumber === broadcast
  })
}

function isUsefulLanIp(ipAddress: string): boolean {
  return !/^127\./.test(ipAddress) &&
    !/^169\.254\./.test(ipAddress) &&
    !/^224\./.test(ipAddress) &&
    !/^0\./.test(ipAddress) &&
    ipAddress !== '255.255.255.255'
}

export function mergeNeighborCandidates(
  candidates: NetworkCandidate[],
): NetworkCandidate[] {
  const byEndpoint = new Map<string, NetworkCandidate>()

  for (const candidate of candidates) {
    if (!isUsefulLanIp(candidate.ipAddress)) continue
    const key = `${candidate.networkZoneId || candidate.interfaceName || 'unassigned'}:${candidate.ipAddress}`
    const previous = byEndpoint.get(key)

    if (!previous) {
      byEndpoint.set(key, {
        ...candidate,
        hostnameEvidence: candidate.hostnameEvidence || (candidate.hostname ? [candidate.hostname] : []),
        macEvidence: candidate.macEvidence || (candidate.macAddress ? [candidate.macAddress] : []),
      })
      continue
    }

    const hostnameEvidence = [...new Set([
      ...(previous.hostnameEvidence || (previous.hostname ? [previous.hostname] : [])),
      ...(candidate.hostnameEvidence || (candidate.hostname ? [candidate.hostname] : [])),
    ])]
    const macEvidence = [...new Set([
      ...(previous.macEvidence || (previous.macAddress ? [previous.macAddress] : [])),
      ...(candidate.macEvidence || (candidate.macAddress ? [candidate.macAddress] : [])),
    ].map(mac => mac.trim().toLowerCase()).filter(mac => mac && mac !== 'ff:ff:ff:ff:ff:ff'))].sort()

    const merged: NetworkCandidate = {
      ...previous,
      ...Object.fromEntries(
        Object.entries(candidate).filter(([, value]) => value !== undefined),
      ),
      hostnameEvidence,
      macEvidence,
    }

    // Positive reachability evidence takes precedence over unknown status.
    if (previous.status === 'online' || candidate.status === 'online') {
      merged.status = 'online'
    }

    // Preserve the stronger confidence value.
    merged.confidence = Math.max(
      previous.confidence ?? 0,
      candidate.confidence ?? 0,
    )

    // Keep descriptive router evidence when ICMP only confirms reachability.
    if (
      candidate.reason === 'Host responded to an active ICMP probe.' &&
      previous.reason
    ) {
      merged.reason = previous.reason
    }

    // Case and trailing-dot variants are the same hostname for comparisons;
    // the original spellings remain in hostnameEvidence for provenance.
    if (previous.hostname && candidate.hostname &&
      normalizeNetworkHostname(previous.hostname) === normalizeNetworkHostname(candidate.hostname)) {
      merged.hostname = candidate.hostname
    }
    byEndpoint.set(key, merged)
  }

  return [...byEndpoint.values()]
}

function identityCandidatesForScan(
  candidates: NetworkCandidate[],
): NetworkCandidate[] {
  const byEndpoint = new Map<string, NetworkCandidate[]>()
  for (const candidate of candidates) {
    const endpoint = `${candidate.networkZoneId || candidate.interfaceName || 'unassigned'}:${candidate.ipAddress}`
    const group = byEndpoint.get(endpoint) || []
    group.push(candidate)
    byEndpoint.set(endpoint, group)
  }

  return [...byEndpoint.values()].flatMap(group => {
    const withMac = group.filter(candidate => {
      const mac = candidate.macAddress?.trim().toLowerCase()
      return !!mac && mac !== 'ff:ff:ff:ff:ff:ff'
    })
    if (withMac.length === 0) return mergeNeighborCandidates(group)

    const byMac = new Map<string, NetworkCandidate>()
    for (const candidate of withMac) {
      const mac = candidate.macAddress!.trim().toLowerCase()
      const previous = byMac.get(mac)
      byMac.set(mac, previous ? mergeSameIdentityCandidate(previous, candidate) : candidate)
    }
    return [...byMac.values()]
  })
}

function mergeSameIdentityCandidate(
  previous: NetworkCandidate,
  current: NetworkCandidate,
): NetworkCandidate {
  const merged = { ...previous }
  for (const [key, value] of Object.entries(current)) {
    if (value !== undefined) Object.assign(merged, { [key]: value })
  }
  if (previous.components || current.components) {
    merged.components = [...new Map(
      [...(previous.components || []), ...(current.components || [])]
        .map(component => [component.component, component]),
    ).values()]
  }
  return merged
}

async function enrichNetworkDevice(
  candidate: NetworkCandidate & {
    networkZoneId: string
    networkZoneName: string
  },
  discoveredAt: string,
  allowEndpointEnrichment = true,
  energridIdentityAdapter: EnergridHttpIdentityAdapter = new EnergridHttpIdentityAdapter(),
  allowIdentityProbe = true,
  signal?: AbortSignal,
): Promise<NetworkDiscoveredDevice> {
  const base: NetworkDiscoveredDevice = {
    id: candidate.macAddress || candidate.ipAddress,
    ipAddress: candidate.ipAddress,
    networkZoneId: candidate.networkZoneId,
    networkZoneName: candidate.networkZoneName,
    macAddress: candidate.macAddress,
    hostname: candidate.hostname,
    vendor: candidate.vendor || vendorFromCandidate(candidate),
    protocol: candidate.protocol || 'unknown',
    confidence: candidate.confidence ?? 0.25,
    status: candidate.status || 'unknown',
    discoveredAt,
    model: candidate.model,
    firmwareVersion: candidate.firmwareVersion,
    app: candidate.app,
    generation: candidate.generation,
    components: candidate.components,
    deviceReportedMacAddress: candidate.deviceReportedMacAddress,
    reason: candidate.reason || 'Visible in the local network neighbour table.',
    observations: candidate.observations || [],
    ...(candidate.macEvidence && new Set(candidate.macEvidence.map(mac => mac.toLowerCase())).size > 1 ? {
      identityConflict: {
        reason: 'multiple_macs_for_endpoint',
        macAddresses: [...new Set(candidate.macEvidence.map(mac => mac.toLowerCase()))].sort(),
      },
    } : {}),
  }

  const evidence = allowEndpointEnrichment
    ? await collectGenericHostEvidence(candidate.ipAddress, signal)
    : { services: [] }
  const networkEvidenceObservedAt = new Date().toISOString()

  if (evidence.hostname && !base.hostname) {
    base.hostname = evidence.hostname
  }

  base.observations = mergeNetworkObservations(candidate.observations || [], buildNetworkObservations(
    { ...candidate, hostnameEvidence: candidate.hostnameEvidence },
    evidence,
    networkEvidenceObservedAt,
  ))
  base.discoveredAt = networkEvidenceObservedAt

  if (allowEndpointEnrichment && allowIdentityProbe && evidence.services.includes('http')) {
    const identity = await energridIdentityAdapter.identify(candidate.ipAddress)
    if (identity) {
      base.id = identity.id
      base.vendor = 'Energrid'
      base.protocol = 'http'
      base.confidence = 0.95
      base.status = 'online'
      base.model = identity.model
      base.firmwareVersion = identity.firmwareVersion
      base.reason = 'Energrid firmware identity was verified over the read-only HTTP identity endpoint.'
      base.observations = mergeNetworkObservations(base.observations || [], [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: networkEvidenceObservedAt, scopeId: candidate.networkZoneId, method: 'GET /api/v1/identity' },
        { source: 'http_identity', attribute: 'identity.device_id', value: identity.id, observedAt: networkEvidenceObservedAt, scopeId: candidate.networkZoneId, method: 'GET /api/v1/identity' },
        { source: 'http_identity', attribute: 'device.model', value: identity.model, observedAt: networkEvidenceObservedAt, scopeId: candidate.networkZoneId, method: 'GET /api/v1/identity' },
        { source: 'http_identity', attribute: 'firmware.version', value: identity.firmwareVersion, observedAt: networkEvidenceObservedAt, scopeId: candidate.networkZoneId, method: 'GET /api/v1/identity' },
        ...identity.capabilities.map(capability => ({ source: 'http_identity' as const, attribute: 'device.capability', value: capability, observedAt: networkEvidenceObservedAt, scopeId: candidate.networkZoneId, method: 'GET /api/v1/identity' })),
      ])
      return base
    }
  }

  const shelly = allowEndpointEnrichment && !signal?.aborted
    ? await probeShelly(candidate.ipAddress)
    : null
  if (!shelly) return base

  const rpcObservedAt = new Date().toISOString()
  const rpcObservations: NonNullable<NetworkDiscoveredDevice['observations']> = [
    { source: 'http_rpc', attribute: 'shelly.device_id', value: shelly.id || '', observedAt: rpcObservedAt },
    ...(shelly.mac ? [{ source: 'http_rpc' as const, attribute: 'shelly.device_reported_mac', value: shelly.mac, observedAt: rpcObservedAt }] : []),
  ]

  const shellyDevice: NetworkDiscoveredDevice = {
    ...base,
    id: shelly.id || base.id,
    vendor: 'Shelly',
    protocol: 'http',
    confidence: 0.9,
    status: 'online',
    discoveredAt: rpcObservedAt,
    settingsUrl: `http://${candidate.ipAddress}`,
    model: shelly.model,
    app: shelly.app,
    generation: shelly.gen,
    ...(shelly.mac ? { deviceReportedMacAddress: shelly.mac } : {}),
    components: [],
    observations: [...(base.observations || []), ...rpcObservations],
    reason: 'Shelly HTTP API responded on the local network.',
  }
  if (shelly.gen && shelly.gen >= 2 && shelly.id) {
    const componentEvidence = await probeShellyComponentEvidence(
      candidate.ipAddress,
      candidate.networkZoneId,
      candidate.interfaceName,
    )
    shellyDevice.components = componentEvidence.components
    shellyDevice.observations = [...(shellyDevice.observations || []), ...componentEvidence.observations]
  }
  return shellyDevice
}

function assignNetworkZone(
  candidate: NetworkCandidate,
  zones: NetworkDiscoveryZone[],
): {
  ipAddress: string
  networkZoneId: string
  networkZoneName: string
  macAddress?: string
  hostname?: string
  } & NetworkCandidate {
  if (candidate.networkZoneId && candidate.networkZoneName) {
    return {
      ...candidate,
      networkZoneId: candidate.networkZoneId,
      networkZoneName: candidate.networkZoneName,
    }
  }

  const zone = zones.find((item) =>
    candidateMatchesZone(candidate, item),
  )

  return {
    ...candidate,
    networkZoneId: zone?.id || 'unassigned',
    networkZoneName: zone?.name || 'Unassigned scope',
  }
}

function candidateMatchesExplicitScope(
  candidate: Pick<NetworkCandidate, 'ipAddress' | 'networkZoneId'>,
  zones: NetworkDiscoveryZone[],
): boolean {
  const zone = zones.find(item => item.id === candidate.networkZoneId)
  if (!zone) return false
  return zone.cidr
    ? ipInCidr(candidate.ipAddress, zone.cidr)
    : zone.seedIps.includes(candidate.ipAddress)
}

export function candidateBelongsToConfiguredZone(
  candidate: Pick<NetworkCandidate, 'ipAddress' | 'networkZoneId' | 'interfaceName'>,
  zones: NetworkDiscoveryZone[],
): boolean {
  if (!isUsefulLanIp(candidate.ipAddress)) return false
  if (isBroadcastInZones(candidate.ipAddress, zones)) return false
  if (zones.length === 0) return true
  return zones.some((zone) => candidateMatchesZone(candidate, zone))
}

function candidateMatchesZone(
  candidate: Pick<NetworkCandidate, 'ipAddress' | 'networkZoneId' | 'interfaceName'>,
  zone: NetworkDiscoveryZone,
): boolean {
  return candidate.networkZoneId === zone.id ||
    (!!candidate.interfaceName && candidate.interfaceName === zone.interfaceName) ||
    zone.seedIps.includes(candidate.ipAddress) ||
    (zone.cidr ? ipInCidr(candidate.ipAddress, zone.cidr) : false)
}

function normalizeRouterClient(item: unknown): NetworkCandidate | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  const ipAddress = stringValue(raw.ipAddress) ||
    stringValue(raw.ip) ||
    stringValue(raw.address) ||
    stringValue(raw.host)
  if (!ipAddress || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipAddress) || !isUsefulLanIp(ipAddress)) {
    return null
  }

  const macAddress = stringValue(raw.macAddress) ||
    stringValue(raw.mac) ||
    stringValue(raw.hwaddr) ||
    stringValue(raw.hardwareAddress)

  return {
    ipAddress,
    macAddress: macAddress?.toLowerCase(),
    hostname: stringValue(raw.hostname) || stringValue(raw.name) || stringValue(raw.hostName),
    vendor: stringValue(raw.vendor) || stringValue(raw.manufacturer),
    model: stringValue(raw.model),
    firmwareVersion: stringValue(raw.firmwareVersion) || stringValue(raw.firmware),
    app: stringValue(raw.app),
    generation: numberValue(raw.generation),
    components: normalizeNetworkComponents(raw.components),
    deviceReportedMacAddress: stringValue(raw.deviceReportedMacAddress),
    networkZoneId: stringValue(raw.networkZoneId),
    networkZoneName: stringValue(raw.networkZoneName),
    protocol: parseCandidateProtocol(raw.protocol),
    confidence: 0.45,
    status: parseOnlineStatus(raw.status),
    reason: 'Router/client table reported this device on the site network.',
  }
}

function parseCandidateProtocol(value: unknown): NetworkDiscoveredDevice['protocol'] {
  const protocol = stringValue(value)
  const supported: NetworkDiscoveredDevice['protocol'][] = [
    'mqtt', 'http', 'zigbee', 'matter', 'modbus', 'simulated', 'none', 'unknown',
  ]
  return supported.find(item => item === protocol) || 'unknown'
}

function normalizeNetworkComponents(
  value: unknown,
): NetworkDiscoveredDevice['components'] {
  if (!Array.isArray(value)) return undefined
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const component = stringValue((item as Record<string, unknown>).component)
    const channel = numberValue((item as Record<string, unknown>).channel)
    return component && channel !== undefined && Number.isInteger(channel) && channel >= 0
      ? [{ component, channel }]
      : []
  })
}

export function ipInCidr(ipAddress: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/')
  const prefix = Number(prefixText)
  if (!network || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false

  const ipNumber = ipv4ToNumber(ipAddress)
  const networkNumber = ipv4ToNumber(network)
  if (ipNumber == null || networkNumber == null) return false

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipNumber & mask) === (networkNumber & mask)
}

export function ipsInCidr(cidr: string, maxHosts = configuredActiveScanMaxHosts()): string[] {
  const [network, prefixText] = cidr.split('/')
  const prefix = Number(prefixText)
  const networkNumber = network ? ipv4ToNumber(network) : null
  if (networkNumber == null || !Number.isInteger(prefix) || prefix < 24 || prefix > 30) return []

  const hostCount = Math.min((2 ** (32 - prefix)) - 2, maxHosts)
  if (hostCount <= 0) return []

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const firstHost = (networkNumber & mask) + 1

  return Array.from({ length: hostCount }, (_, index) => numberToIpv4(firstHost + index))
    .filter((ipAddress) => isUsefulLanIp(ipAddress))
}

export function icmpReachabilityCandidate(
  ipAddress: string,
  responded: boolean,
  zone?: Pick<NetworkDiscoveryZone, 'id' | 'name'>,
): NetworkCandidate | null {
  if (!responded) return null

  return {
    ipAddress,
    ...(zone ? { networkZoneId: zone.id, networkZoneName: zone.name } : {}),
    status: 'online',
    confidence: 0.6,
    reason: 'Host responded to an active ICMP probe.',
  }
}

async function activeScanZones(
  zones: NetworkDiscoveryZone[],
  signal?: AbortSignal,
): Promise<NetworkCandidate[]> {
  if (process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false') return []

  const targets = zones.flatMap(zone => [...new Set([
    ...zone.seedIps,
    ...(zone.cidr ? ipsInCidr(zone.cidr) : []),
  ])].map(ipAddress => ({ ipAddress, zone })))

  if (targets.length === 0) return []

  const reachable: NetworkCandidate[] = []

  await runPool(targets, activeScanConcurrency, async ({ ipAddress, zone }) => {
    if (signal?.aborted) return
    const candidate = icmpReachabilityCandidate(
      ipAddress,
      await pingHost(ipAddress),
      zone,
    )
    if (candidate) reachable.push(candidate)
  }, signal)

  return reachable
}

const tcpDiscoveryPorts = [80, 443, 22, 8080, 8443]

async function tcpDiscoverZones(
  zones: NetworkDiscoveryZone[],
  icmpDevices: NetworkCandidate[],
  signal?: AbortSignal,
): Promise<NetworkCandidate[]> {
  if (process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false') return []

  const alreadyReachable = new Set(
    icmpDevices.map((device) => `${device.networkZoneId || ''}:${device.ipAddress}`),
  )

  const targets = zones.flatMap(zone => [...new Set([
    ...zone.seedIps,
    ...(zone.cidr ? ipsInCidr(zone.cidr) : []),
  ])].map(ipAddress => ({ ipAddress, zone })))
    .filter(({ ipAddress, zone }) =>
      !alreadyReachable.has(`${zone.id}:${ipAddress}`),
    )

  const found: NetworkCandidate[] = []

  await runPool(targets, 24, async ({ ipAddress, zone }) => {
    for (const port of tcpDiscoveryPorts) {
      if (signal?.aborted) return
      if (await tcpPortOpen(ipAddress, port, 500, signal)) {
        found.push({
          ipAddress,
          networkZoneId: zone.id,
          networkZoneName: zone.name,
          status: 'online',
          confidence: 0.65,
          reason: `Host accepted a TCP connection on port ${port}.`,
        })
        return
      }
    }
  }, signal)

  return found
}

async function pingHost(ipAddress: string): Promise<boolean> {
  const args = process.platform === 'darwin'
    ? ['-c', '1', '-W', '1000', ipAddress]
    : ['-c', '1', '-W', '1', ipAddress]

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await execFileAsync('ping', args, { timeout: 2000 })
      return true
    } catch {
      // A single missed ICMP response is not proof that a host is offline.
    }
  }

  return false
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !signal?.aborted) {
      const item = items[cursor]
      cursor += 1
      if (item) await worker(item)
    }
  })

  await Promise.all(workers)
}

function inferNetworkZonesFromInterfaces(): NetworkDiscoveryZone[] {
  return inferConfiguredIpv4Scopes(
    networkInterfaces(),
    Math.min(configuredActiveScanMaxHosts(), 254),
    configuredActiveScanMaxZones(),
  ).map(zone => ({ ...zone, name: displayNameFromZoneId(zone.interfaceName) }))
}

function configuredActiveScanMaxHosts(): number {
  const value = Number(process.env.HOME_LAN_ACTIVE_SCAN_MAX_HOSTS || 254)
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 1024) : 254
}

function configuredActiveScanMaxZones(): number {
  const value = Number(process.env.HOME_LAN_ACTIVE_SCAN_MAX_ZONES || 4)
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 12) : 4
}

function ipv4ToNumber(ipAddress: string): number | null {
  const parts = ipAddress.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }

  return parts.reduce((total, part) => ((total << 8) + part) >>> 0, 0)
}

function numberToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.')
}

function safeZoneId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'network'
}

function displayNameFromZoneId(value: string): string {
  return value
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

export async function probeShelly(ipAddress: string): Promise<{
  id?: string
  mac?: string
  model?: string
  app?: string
  gen?: number
} | null> {
  const info = await readOnlyShellyDeviceInfo(ipAddress, 1000)
  if (!info) return null
  return {
    id: info.id || info.mac,
    mac: normalizeMacAddress(info.mac),
    model: info.model,
    app: info.app,
    gen: info.gen,
  }
}

function normalizeMacAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const hex = value.replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (hex.length !== 12) return undefined
  return hex.match(/.{2}/g)?.join(':')
}

export type ShellyComponentProbeEvidence = {
  components: NonNullable<NetworkDiscoveredDevice['components']>
  observations: NonNullable<NetworkDiscoveredDevice['observations']>
  failureReason?: string
}

const maxShellyComponents = 32
const shellyComponentProbeConcurrency = 4

export async function probeShellyComponents(ipAddress: string): Promise<NonNullable<NetworkDiscoveredDevice['components']>> {
  return (await probeShellyComponentEvidence(ipAddress)).components
}

export async function probeShellyComponentsWithEvidence(
  ipAddress: string,
  scopeId?: string,
  interfaceName?: string,
  externalSignal?: AbortSignal,
): Promise<ShellyComponentProbeEvidence> {
  return probeShellyComponentEvidence(ipAddress, scopeId, interfaceName, externalSignal)
}

async function probeShellyComponentEvidence(
  ipAddress: string,
  scopeId?: string,
  interfaceName?: string,
  externalSignal?: AbortSignal,
): Promise<ShellyComponentProbeEvidence> {
  let baseUrl: string
  try { baseUrl = privateShellyBaseUrl(`http://${ipAddress}`) }
  catch { return { components: [], observations: [], failureReason: 'The saved Shelly endpoint is not a safe HTTP RPC target.' } }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  const abort = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abort, { once: true })
  try {
    const componentsResponse = await readShellyRpcJson(baseUrl, 'Shelly.GetComponents', controller.signal)
    if (!componentsResponse) return { components: [], observations: [], failureReason: 'Shelly.GetComponents did not respond within 1.5 seconds.' }
    const reportedComponents = await componentKeysFromComponentsPages(baseUrl, componentsResponse, controller.signal)
    const statusComponents = reportedComponents === null
      ? componentKeysFromStatus(componentsResponse)
      : []
    const componentKeys = reportedComponents ?? (statusComponents.length > 0
      ? statusComponents
      : componentKeysFromStatus(await readShellyRpcJson(baseUrl, 'Shelly.GetStatus', controller.signal)))
    if (controller.signal.aborted) return { components: [], observations: [], failureReason: 'Shelly component RPC exceeded the 1.5-second deadline.' }

    const components = componentKeys.slice(0, maxShellyComponents)
    if (components.length === 0) return { components: [], observations: [], failureReason: 'Shelly RPC did not report supported switch or EM1 components.' }
    const confirmed: ShellyComponentProbeEvidence = { components: [], observations: [] }
    for (let offset = 0; offset < components.length && !controller.signal.aborted; offset += shellyComponentProbeConcurrency) {
      const batch = components.slice(offset, offset + shellyComponentProbeConcurrency)
      const results = await Promise.all(batch.map(async item => {
        const method = item.component.startsWith('switch:') ? 'Switch.GetStatus'
          : 'EM1.GetStatus'
        const body = await readShellyRpcJson(baseUrl, `${method}?id=${item.channel}`, controller.signal)
        const projection = projectShellyComponentStatus(item, body)
        if (!projection) return null
        return {
          ...projection,
          observedAt: new Date().toISOString(),
          method: `${method}?id=${item.channel}`,
        }
      }))
      for (const result of results) {
        if (!result) continue
        confirmed.components.push({ component: result.component, channel: result.channel })
        confirmed.observations.push({
          source: 'http_rpc',
          attribute: 'shelly.component_status',
          value: result.component,
          observedAt: result.observedAt,
          ...(scopeId ? { scopeId } : {}),
          ...(interfaceName ? { interfaceName } : {}),
          method: result.method,
        })
        for (const metric of result.measurementCapabilities) confirmed.observations.push({
            source: 'http_rpc',
            attribute: 'shelly.measurement_capability',
            value: `${result.component}:${metric}`,
            observedAt: result.observedAt,
            ...(scopeId ? { scopeId } : {}),
            ...(interfaceName ? { interfaceName } : {}),
            method: result.method,
          })
      }
    }
    const missing = components.filter(item => !confirmed.components.some(found => found.component === item.component))
    return missing.length
      ? { ...confirmed, failureReason: `Read-only status RPC did not confirm ${missing.map(item => item.component).join(', ')} within 1.5 seconds.` }
      : confirmed
  } catch (error) {
    return { components: [], observations: [], failureReason: error instanceof Error ? error.message : 'Shelly component RPC failed.' }
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abort)
  }
}

async function readShellyRpcJson(
  baseUrl: string,
  method: string,
  signal: AbortSignal,
): Promise<unknown | null> {
  try {
    const response = await fetch(`${baseUrl}/rpc/${method}`, {
      method: 'GET', signal, headers: { Accept: 'application/json' }, redirect: 'error',
    })
    return response.ok ? await response.json() as unknown : null
  } catch {
    return null
  }
}

async function componentKeysFromComponentsPages(
  baseUrl: string,
  firstPage: unknown,
  signal: AbortSignal,
): Promise<Array<{ component: string; channel: number }> | null> {
  const pageItems = (value: unknown): { keys: Array<{ component: string; channel: number }>; length: number; total?: number } | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as { components?: unknown; total?: unknown }
    if (!Array.isArray(record.components)) return null
    const keys = record.components.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const key = (item as { key?: unknown }).key
      return typeof key === 'string' ? parsedShellyComponentKey(key) : []
    })
    return { keys, length: record.components.length,
      ...(typeof record.total === 'number' && Number.isInteger(record.total) && record.total >= 0 ? { total: record.total } : {}) }
  }
  const first = pageItems(firstPage)
  if (!first) return null
  const keys = [...first.keys]
  let offset = first.length
  const total = Math.min(first.total ?? first.length, maxShellyComponents)
  while (offset < total && offset < maxShellyComponents && !signal.aborted) {
    const page = pageItems(await readShellyRpcJson(baseUrl, `Shelly.GetComponents?offset=${offset}`, signal))
    if (!page || page.length === 0) break
    keys.push(...page.keys)
    offset += page.length
  }
  return keys.slice(0, maxShellyComponents)
}

function componentKeysFromStatus(value: unknown): Array<{ component: string; channel: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).flatMap(parsedShellyComponentKey).slice(0, maxShellyComponents)
}

function parsedShellyComponentKey(component: string): Array<{ component: string; channel: number }> {
  const match = /^(switch|em1):(\d+)$/.exec(component)
  if (!match) return []
  const channel = Number(match[2])
  return Number.isInteger(channel) && channel >= 0 && channel <= 31
    ? [{ component, channel }]
    : []
}

function isConfirmedShellyComponentStatus(
  component: { component: string; channel: number },
  value: unknown,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  if (status.id !== component.channel) return false
  if (component.component.startsWith('switch:')) return typeof status.output === 'boolean'
  return typeof status.act_power === 'number' && Number.isFinite(status.act_power)
}

type ShellyComponentStatusProjection = {
  component: string
  channel: number
  measurementCapabilities: ShellyMeasurementCapability[]
}

type ShellyMeasurementCapability = 'power' | 'energy_import_total' | 'energy_export_total'

/** Pure interpretation shared by direct and remote read-only Shelly RPC responses. */
function projectShellyComponentStatus(
  component: { component: string; channel: number },
  value: unknown,
): ShellyComponentStatusProjection | undefined {
  if (!isConfirmedShellyComponentStatus(component, value)) return undefined
  const status = value as Record<string, unknown>
  const measurementCapabilities: ShellyMeasurementCapability[] = []
  if (numberValue(status.apower) !== undefined || numberValue(status.act_power) !== undefined) measurementCapabilities.push('power')
  if (numberValue(status.aenergy && typeof status.aenergy === 'object' ? (status.aenergy as Record<string, unknown>).total : undefined) !== undefined ||
      numberValue(status.total_act_energy) !== undefined) measurementCapabilities.push('energy_import_total')
  if (numberValue(status.ret_aenergy && typeof status.ret_aenergy === 'object' ? (status.ret_aenergy as Record<string, unknown>).total : undefined) !== undefined ||
      numberValue(status.total_act_ret_energy) !== undefined) measurementCapabilities.push('energy_export_total')
  return { ...component, measurementCapabilities }
}

function shellyComponentEvidenceFromRpcStatuses(
  componentKeys: string[],
  statuses: Array<{ componentKey: string; body: Record<string, unknown> }>,
  scopeId: string,
  interfaceName: string,
  observedAt: string,
  source: 'http_rpc' | 'site_local_http_rpc',
): ShellyComponentProbeEvidence {
  const components = componentKeys.flatMap(parsedShellyComponentKey)
  const observations: NonNullable<NetworkDiscoveredDevice['observations']> = []
  const statusByKey = new Map(statuses.map(item => [item.componentKey, item.body]))
  for (const component of components) {
    const body = statusByKey.get(component.component)
    const projection = projectShellyComponentStatus(component, body)
    if (!projection) {
      return { components: [], observations: [], failureReason: `Read-only status RPC did not confirm ${component.component}.` }
    }
    const methodName = component.component.startsWith('switch:') ? 'Switch' : 'EM1'
    const method = `${methodName}.GetStatus?id=${component.channel}`
    observations.push({ source, attribute: 'shelly.component_status', value: component.component, observedAt,
      scopeId, interfaceName, method })
    for (const metric of projection.measurementCapabilities) observations.push({
      source, attribute: 'shelly.measurement_capability', value: `${component.component}:${metric}`,
      observedAt, scopeId, interfaceName, method,
    })
  }
  return { components: components.map(item => ({ component: item.component, channel: item.channel })), observations }
}

function vendorFromCandidate(candidate: { macAddress?: string; hostname?: string }): string | undefined {
  const text = `${candidate.hostname || ''} ${candidate.macAddress || ''}`.toLowerCase()
  if (text.includes('shelly')) return 'Shelly'
  if (text.includes('espressif')) return 'Espressif'
  return undefined
}

export function dedupeNetworkDevices(
  devices: NetworkDiscoveredDevice[],
): NetworkDiscoveredDevice[] {
  return dedupeNetworkEndpoints(devices)
}

function addNmapEndpointEvidence(
  endpoints: NetworkDiscoveredDevice[],
  candidates: NetworkCandidate[],
): NetworkDiscoveredDevice[] {
  const byKey = new Map(endpoints.map(endpoint => [`${endpoint.networkZoneId}:${endpoint.ipAddress}`, endpoint]))
  for (const candidate of candidates) {
    if (!candidate.networkZoneId || !candidate.networkZoneName) continue
    const key = `${candidate.networkZoneId}:${candidate.ipAddress}`
    const endpoint = byKey.get(key)
    if (endpoint) {
      byKey.set(key, {
        ...endpoint,
        observations: mergeNetworkObservations(endpoint.observations || [], candidate.observations || []),
      })
      continue
    }
    byKey.set(key, {
      id: candidate.macAddress || candidate.ipAddress,
      ipAddress: candidate.ipAddress,
      networkZoneId: candidate.networkZoneId,
      networkZoneName: candidate.networkZoneName,
      ...(candidate.macAddress ? { macAddress: candidate.macAddress } : {}),
      ...(candidate.hostname ? { hostname: candidate.hostname } : {}),
      protocol: 'unknown',
      confidence: 0,
      status: candidate.status || 'unknown',
      discoveredAt: candidate.observedAt || new Date().toISOString(),
      reason: candidate.reason || 'Observed by a bounded TCP service scan.',
      observations: candidate.observations || [],
    })
  }
  return [...byKey.values()].sort((a, b) => a.networkZoneId.localeCompare(b.networkZoneId) || a.ipAddress.localeCompare(b.ipAddress))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseOnlineStatus(value: unknown): NetworkDiscoveredDevice['status'] {
  const text = stringValue(value)?.toLowerCase()
  if (!text) return 'unknown'
  if (['online', 'reachable', 'active', 'connected'].includes(text)) return 'online'
  if (['offline', 'inactive', 'disconnected'].includes(text)) return 'offline'
  return 'unknown'
}


type GenericHostEvidence = {
  hostname?: string
  services: string[]
}

export function buildNetworkObservations(
  candidate: Pick<NetworkCandidate, 'status' | 'reason' | 'hostname' | 'hostnameEvidence'>,
  evidence: GenericHostEvidence,
  observedAt: string,
): NonNullable<NetworkDiscoveredDevice['observations']> {
  const observations: NonNullable<NetworkDiscoveredDevice['observations']> = []

  if (
    candidate.status === 'online' &&
    candidate.reason === 'Host responded to an active ICMP probe.'
  ) {
    observations.push({
      source: 'icmp',
      attribute: 'reachable',
      value: true,
      observedAt,
    })
  }

  const hostnames = [...new Set([
    ...(candidate.hostnameEvidence || []),
    ...(candidate.hostname ? [candidate.hostname] : []),
    ...(evidence.hostname ? [evidence.hostname] : []),
  ])]
  for (const hostname of hostnames) {
    observations.push({
      source: 'dns',
      attribute: 'hostname',
      value: hostname,
      observedAt,
    })
  }

  for (const service of evidence.services) {
    const port = service === 'ssh' ? 22 : service === 'http' ? 80 : 443

    observations.push({
      source: 'tcp',
      attribute: `port.${port}.open`,
      value: true,
      observedAt,
    })
  }

  return observations
}

function mergeNetworkObservations(
  ...groups: NonNullable<NetworkDiscoveredDevice['observations']>[]
): NonNullable<NetworkDiscoveredDevice['observations']> {
  const unique = new Map<string, NonNullable<NetworkDiscoveredDevice['observations']>[number]>()
  for (const observation of groups.flat()) {
    unique.set(JSON.stringify(observation), observation)
  }
  return [...unique.values()]
}

async function collectGenericHostEvidence(
  ipAddress: string,
  signal?: AbortSignal,
): Promise<GenericHostEvidence> {
  const hostnamePromise = Promise.race([
    reverse(ipAddress)
      .then((names) => names[0]?.replace(/\\.$/, ''))
      .catch(() => undefined),
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 1000),
    ),
  ])

  const ports = [
    { port: 22, name: 'ssh' },
    { port: 80, name: 'http' },
    { port: 443, name: 'https' },
  ]

  const results = await Promise.all(
    ports.map(async ({ port, name }) => ({
      name,
      open: await tcpPortOpen(ipAddress, port, tcpConnectTimeoutMs, signal),
    })),
  )

  return {
    hostname: await hostnamePromise,
    services: results.filter((result) => result.open).map((result) => result.name),
  }
}

export function tcpPortOpen(
  ipAddress: string,
  port: number,
  timeoutMs = tcpConnectTimeoutMs,
  signal?: AbortSignal,
): Promise<boolean> {
  return probeTcpConnection(ipAddress, port, timeoutMs, signal).then(result => result.status === 'connected')
}

export function probeTcpConnection(
  ipAddress: string,
  port: number,
  timeoutMs = tcpConnectTimeoutMs,
  signal?: AbortSignal,
): Promise<{ status: 'connected' | 'timeout' | 'refused' | 'unreachable' | 'error' | 'aborted'; message: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ status: 'aborted', message: 'Verification was cancelled.' })
    const socket = new Socket()
    let settled = false
    const timeout = setTimeout(() => finish({
      status: 'timeout', message: `TCP connection to ${ipAddress}:${port} timed out after ${timeoutMs} ms; verify the observer route and network scope.`,
    }), timeoutMs)
    const abort = () => finish({ status: 'aborted', message: 'Verification was cancelled.' })

    const finish = (result: { status: 'connected' | 'timeout' | 'refused' | 'unreachable' | 'error' | 'aborted'; message: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      resolve(result)
    }

    signal?.addEventListener('abort', abort, { once: true })
    socket.once('connect', () => finish({ status: 'connected', message: '' }))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error?.code || 'UNKNOWN'
      const status = code === 'ECONNREFUSED' ? 'refused'
        : code === 'ENETUNREACH' || code === 'EHOSTUNREACH' ? 'unreachable' : 'error'
      const message = status === 'refused'
        ? `The observer reached ${ipAddress}, but TCP port ${port} refused the connection.`
        : status === 'unreachable'
          ? `The observer reports no route to ${ipAddress} (${code}). Check the authorized network scope.`
          : `TCP connection to ${ipAddress}:${port} failed (${code}).`
      finish({ status, message })
    })
    socket.connect(port, ipAddress)
  })
}

function ipIsInZone(ipAddress: string, zone: NetworkDiscoveryZone): boolean {
  if (isIP(ipAddress) !== 4) return false
  if (zone.cidr) {
    const [network, prefixText, extra] = zone.cidr.split('/')
    const prefix = Number(prefixText)
    if (!extra && isIP(network) === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
      const allowed = new BlockList()
      allowed.addSubnet(network, prefix, 'ipv4')
      if (allowed.check(ipAddress, 'ipv4')) return true
    }
  }
  return zone.seedIps.includes(ipAddress)
}

function throwIfScanAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Network scan was cancelled or exceeded its execution deadline')
}
