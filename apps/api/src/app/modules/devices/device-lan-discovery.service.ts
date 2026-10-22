import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  dedupeNetworkEndpoints,
  DeviceDiscoveryMemoryStore,
  normalizeNetworkHostname,
} from './device-discovery-memory.store'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { hostname as localHostname, networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import { reverse } from 'node:dns/promises'
import { Socket } from 'node:net'
import { promisify } from 'node:util'
import { privateShellyBaseUrl } from '@energrid/domain-devices'
import type {
  NetworkDiscoveredDevice,
  NetworkDiscoveryZone,
} from './device-registry.types'
import { DeviceRegistryService } from './device-registry.service'
import {
  PHYSICAL_DEVICE_INVENTORY_SERVICE,
} from './enrollment/device-enrollment.module'
import type { PhysicalDeviceInventoryService } from './enrollment/physical-device-inventory.service'
import type { PhysicalLanObservation } from './enrollment/physical-device-inventory.repository'
import { shellyLanCandidates } from './adapters/inbound/shelly/shelly-lan-candidates'
import { readOnlyShellyDeviceInfo } from './adapters/inbound/shelly/read-only-shelly-rpc'
import { compareNetworkSnapshots, type NetworkDiscoverySnapshot, type NetworkDiscoverySnapshotDiff } from './network-discovery-snapshot'
import { NmapNetworkEvidenceAdapter, type NmapCapability, type NmapScanResult } from './adapters/outbound/network/nmap-network-evidence.adapter'
import {
  inferConfiguredIpv4Scopes,
  LocalNetworkRuntimeAdapter,
  type LocalNetworkRuntimeReport,
} from './adapters/outbound/network/local-network-runtime.adapter'

const execFileAsync = promisify(execFile)
const activeScanConcurrency = 24

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

@Injectable()
export class DeviceLanNetworkEvidenceCollector {
  constructor(
    @Optional() private readonly nmapAdapter?: NmapNetworkEvidenceAdapter,
    @Optional() private readonly runtimeAdapter?: LocalNetworkRuntimeAdapter,
  ) {}

  async getNmapCapability(): Promise<NmapCapability & { enabled: boolean }> {
    const capability = await (this.nmapAdapter || new NmapNetworkEvidenceAdapter()).getCapability()
    return { ...capability, enabled: process.env.HOME_NMAP_ENABLED === 'true' }
  }

  async collectEvidence(zones: NetworkDiscoveryZone[], signal?: AbortSignal): Promise<{
    candidates: NetworkCandidate[]
    nmap: NmapScanResult
    runtime?: LocalNetworkRuntimeReport
  }> {
    const nmapEnabled = process.env.HOME_NMAP_ENABLED === 'true'
    const nmapAdapter = this.nmapAdapter || new NmapNetworkEvidenceAdapter()
    const runtimePromise = this.runtimeAdapter?.inspect(zones)
    const nmap = await nmapAdapter.scan(zones, {
      enabled: nmapEnabled,
      maxHosts: Number(process.env.HOME_NMAP_MAX_HOSTS) || 254,
      timeoutMs: Number(process.env.HOME_NMAP_TIMEOUT_MS) || 120_000,
      signal,
    })
    const nmapHostDiscoveryUsed = nmapEnabled && nmap.capability.available
    const reachableDevices = nmapHostDiscoveryUsed ? [] : await activeScanZones(zones)
    const tcpDevices = nmapHostDiscoveryUsed ? [] : await tcpDiscoverZones(zones, reachableDevices)
    const [arpDevices, routerClients] = await Promise.all([readNeighborTable(), readRouterClientCandidates()])
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
        available: process.env.HOME_LAN_ACTIVE_SCAN_ENABLED !== 'false',
        detail: process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false' ? 'Active ICMP/TCP subnet probes are disabled.' : 'Bounded active probes are available and require explicit operator approval.',
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
  ): Promise<NetworkDiscoveredDevice> {
    return enrichNetworkDevice(candidate, observedAt, allowEndpointEnrichment)
  }
}

@Injectable()
export class DeviceLanDiscoveryService {
  private readonly logger = new Logger(DeviceLanDiscoveryService.name)
  private lastScan: NetworkDiscoveredDevice[] = []
  private lastZones: NetworkDiscoveryZone[] = []

  constructor(
    private readonly discoveryMemory: DeviceDiscoveryMemoryStore,
    private readonly registry: DeviceRegistryService,
    private readonly evidenceCollector: DeviceLanNetworkEvidenceCollector,
    @Optional()
    @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
  ) {}

  getLastScan(): NetworkDiscoveredDevice[] {
    return this.lastScan
  }

  getZones(): NetworkDiscoveryZone[] {
    return this.lastZones.length > 0 ? this.lastZones : configuredNetworkZones()
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
    const configuredZones = configuredNetworkZones()
    if (configuredZones.length === 0) {
      throw new BadRequestException('No network scan scopes are configured')
    }
    const zones = selectScanZones(configuredZones, options.scopeIds)
    if (zones.some(zone => zone.cidr) && options.fullSubnetConfirmed !== true) {
      throw new BadRequestException('Full-subnet discovery requires explicit operator confirmation')
    }
    const evidence = await this.evidenceCollector.collectEvidence(zones, options.signal)
    const nmapHostDiscoverySelected = process.env.HOME_NMAP_ENABLED === 'true' && evidence.nmap.capability.available
    const discoveredCandidates = evidence.candidates
    const endpointCandidates = mergeNeighborCandidates(discoveredCandidates)
    const identityCandidates = identityCandidatesForScan(discoveredCandidates)
    const conflictingEndpoints = new Set(endpointCandidates
      .filter(candidate => (candidate.macEvidence || []).length > 1)
      .map(candidate => `${candidate.networkZoneId}:${candidate.ipAddress}`))
    const devices = await Promise.all(
      identityCandidates.map(async (candidate) =>
        this.evidenceCollector.enrichCandidate(candidate as NetworkCandidate & {
          networkZoneId: string
          networkZoneName: string
        }, startedAt, !conflictingEndpoints.has(`${candidate.networkZoneId}:${candidate.ipAddress}`)),
      ),
    )

    this.lastZones = configuredZones
    this.lastScan = addNmapEndpointEvidence(
      dedupeNetworkDevices(devices),
      discoveredCandidates.filter(candidate => candidate.evidenceSource === 'nmap'),
    )
    const boundedEvidence = buildBoundedRawEvidence(discoveredCandidates, this.lastScan, startedAt)
    const completedAt = new Date().toISOString()
    await this.discoveryMemory.recordScan(completedAt, devices.map(device => {
      const observations = (device.observations || []).filter(item => item.method !== 'nmap_tcp_connect_service_scan')
      return { ...device, ...(observations.length ? { observations } : { observations: undefined }) }
    }))
    if (this.physicalInventory) {
      const { tenant, site } = this.registry.getSnapshot()
      try {
        const scope = { tenantId: tenant.id, siteId: site.id }
        const observations: PhysicalLanObservation[] = []
        for (const device of this.lastScan) {
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
    const collectorInterfaces = [...new Set([
      ...interfacesForZones(zones),
      ...evidence.nmap.scopes.flatMap(scope => scope.interfaceName ? [scope.interfaceName] : []),
    ])].sort()
    const nmapScopeById = new Map(evidence.nmap.scopes.map(scope => [scope.scopeId, scope]))
    const snapshot: NetworkDiscoverySnapshot = {
      schemaVersion: 2,
      scanId,
      startedAt,
      completedAt: new Date().toISOString(),
      collector: {
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
        ...(nmapScopeById.get(zone.id) ? { collectionStages: {
          hostDiscovery: toSnapshotStage(nmapScopeById.get(zone.id)!.hostDiscovery),
          serviceEnrichment: toSnapshotStage(nmapScopeById.get(zone.id)!.serviceEnrichment),
        } } : {}),
        complete: nmapHostDiscoverySelected
          ? nmapScopeById.get(zone.id)?.complete === true
          : scanScopeComplete(zone),
        gatewayIpsObserved: [...new Set(this.lastScan
          .filter(device => device.networkZoneId === zone.id && device.gatewayId && isIpv4Address(device.gatewayId))
          .map(device => device.gatewayId!))].sort(),
      })),
      methods: [...new Set([...discoveryMethods(zones, !nmapHostDiscoverySelected), ...evidence.nmap.methods])].sort(),
      successes: this.lastScan.length,
      failures: evidence.nmap.failures,
      limitations: [
        ...scanLimitations(zones),
        ...evidence.nmap.limitations,
        ...(boundedEvidence.omitted ? [`Raw candidate evidence was bounded; ${boundedEvidence.omitted} record(s) omitted.`] : []),
      ],
      rawEvidence: boundedEvidence.records,
      rawEvidenceOmitted: boundedEvidence.omitted,
      endpoints: structuredClone(this.lastScan),
      topology: { relationships: [] },
      ...(evidence.runtime ? { runtime: evidence.runtime } : {}),
    }
    await this.discoveryMemory.recordSnapshot(snapshot)
    const previousSnapshots = await this.discoveryMemory.listSnapshots(100)
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

async function readNeighborTable(): Promise<Array<{
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
        ...configuredSeedHosts(),
      ]
      if (devices.length > 0) return devices
    } catch {
      // Try the next platform-specific command.
    }
  }

  return configuredSeedHosts()
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
  if (parsed.length > 0) return parsed

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
  }
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
    ? await collectGenericHostEvidence(candidate.ipAddress)
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

  const shelly = allowEndpointEnrichment
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
): Promise<NetworkCandidate[]> {
  if (process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false') return []

  const targets = zones.flatMap(zone => [...new Set([
    ...zone.seedIps,
    ...(zone.cidr ? ipsInCidr(zone.cidr) : []),
  ])].map(ipAddress => ({ ipAddress, zone })))

  if (targets.length === 0) return []

  const reachable: NetworkCandidate[] = []

  await runPool(targets, activeScanConcurrency, async ({ ipAddress, zone }) => {
    const candidate = icmpReachabilityCandidate(
      ipAddress,
      await pingHost(ipAddress),
      zone,
    )
    if (candidate) reachable.push(candidate)
  })

  return reachable
}

const tcpDiscoveryPorts = [80, 443, 22, 8080, 8443]

async function tcpDiscoverZones(
  zones: NetworkDiscoveryZone[],
  icmpDevices: NetworkCandidate[],
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
      if (await tcpDiscoveryPortOpen(ipAddress, port)) {
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
  })

  return found
}

function tcpDiscoveryPortOpen(
  ipAddress: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false

    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }

    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, ipAddress)
  })
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
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
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

type ShellyComponentProbeEvidence = {
  components: NonNullable<NetworkDiscoveredDevice['components']>
  observations: NonNullable<NetworkDiscoveredDevice['observations']>
}

const maxShellyComponents = 32
const shellyComponentProbeConcurrency = 4

export async function probeShellyComponents(ipAddress: string): Promise<NonNullable<NetworkDiscoveredDevice['components']>> {
  return (await probeShellyComponentEvidence(ipAddress)).components
}

async function probeShellyComponentEvidence(
  ipAddress: string,
  scopeId?: string,
  interfaceName?: string,
): Promise<ShellyComponentProbeEvidence> {
  let baseUrl: string
  try { baseUrl = privateShellyBaseUrl(`http://${ipAddress}`) }
  catch { return { components: [], observations: [] } }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const componentsResponse = await readShellyRpcJson(baseUrl, 'Shelly.GetComponents', controller.signal)
    const reportedComponents = componentKeysFromComponents(componentsResponse)
    const statusComponents = reportedComponents === null
      ? componentKeysFromStatus(componentsResponse)
      : []
    const componentKeys = reportedComponents ?? (statusComponents.length > 0
      ? statusComponents
      : componentKeysFromStatus(await readShellyRpcJson(baseUrl, 'Shelly.GetStatus', controller.signal)))
    if (controller.signal.aborted) return { components: [], observations: [] }

    const components = componentKeys.slice(0, maxShellyComponents)
    const confirmed: ShellyComponentProbeEvidence = { components: [], observations: [] }
    for (let offset = 0; offset < components.length && !controller.signal.aborted; offset += shellyComponentProbeConcurrency) {
      const batch = components.slice(offset, offset + shellyComponentProbeConcurrency)
      const results = await Promise.all(batch.map(async item => {
        const method = item.component.startsWith('switch:') ? 'Switch.GetStatus' : 'EM1.GetStatus'
        const body = await readShellyRpcJson(baseUrl, `${method}?id=${item.channel}`, controller.signal)
        if (!isConfirmedShellyComponentStatus(item, body)) return null
        return {
          component: item.component,
          channel: item.channel,
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
      }
    }
    return confirmed
  } catch {
    return { components: [], observations: [] }
  } finally {
    clearTimeout(timeout)
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

function componentKeysFromComponents(value: unknown): Array<{ component: string; channel: number }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const components = (value as { components?: unknown }).components
  if (!Array.isArray(components)) return null
  return components.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const key = (item as { key?: unknown }).key
    return typeof key === 'string' ? parsedShellyComponentKey(key) : []
  }).slice(0, maxShellyComponents)
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
      open: await tcpPortOpen(ipAddress, port),
    })),
  )

  return {
    hostname: await hostnamePromise,
    services: results.filter((result) => result.open).map((result) => result.name),
  }
}

function tcpPortOpen(ipAddress: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false

    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }

    socket.setTimeout(1500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, ipAddress)
  })
}
