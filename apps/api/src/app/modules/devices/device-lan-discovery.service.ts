import { Injectable, Logger } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import type {
  NetworkDiscoveredDevice,
  NetworkDiscoveryZone,
} from './device-registry.types'

const execFileAsync = promisify(execFile)
const activeScanConcurrency = 64

type NetworkCandidate = {
  ipAddress: string
  macAddress?: string
  hostname?: string
  vendor?: string
  model?: string
  protocol?: NetworkDiscoveredDevice['protocol']
  confidence?: number
  status?: NetworkDiscoveredDevice['status']
  reason?: string
  networkZoneId?: string
  networkZoneName?: string
}

@Injectable()
export class DeviceLanDiscoveryService {
  private readonly logger = new Logger(DeviceLanDiscoveryService.name)
  private lastScan: NetworkDiscoveredDevice[] = []
  private lastZones: NetworkDiscoveryZone[] = []

  getLastScan(): NetworkDiscoveredDevice[] {
    return this.lastScan
  }

  getZones(): NetworkDiscoveryZone[] {
    return this.lastZones.length > 0 ? this.lastZones : configuredNetworkZones()
  }

  async scanNow(): Promise<{
    scannedAt: string
    zones: NetworkDiscoveryZone[]
    devices: NetworkDiscoveredDevice[]
  }> {
    const scannedAt = new Date().toISOString()
    const zones = configuredNetworkZones()
    await activeScanZones(zones)
    const arpDevices = await readNeighborTable()
    const routerClients = await readRouterClientCandidates()
    const candidates = mergeNeighborCandidates([
      ...arpDevices,
      ...routerClients,
      ...zones.flatMap((zone) =>
        zone.seedIps.map((ipAddress) => ({
          ipAddress,
          networkZoneId: zone.id,
          networkZoneName: zone.name,
        })),
      ),
    ]).filter((candidate) => candidateBelongsToConfiguredZone(candidate, zones))
    const devices = await Promise.all(
      candidates.map(async (candidate) =>
        enrichNetworkDevice(assignNetworkZone(candidate, zones), scannedAt),
      ),
    )

    this.lastZones = zones
    this.lastScan = dedupeNetworkDevices(devices)
    this.logger.log(`[LAN DISCOVERY] zones=${zones.length} devices=${this.lastScan.length}`)

    return {
      scannedAt,
      zones,
      devices: this.lastScan,
    }
  }
}

export function parseArpOutput(output: string): Array<{
  ipAddress: string
  macAddress?: string
  hostname?: string
}> {
  const devices: Array<{
    ipAddress: string
    macAddress?: string
    hostname?: string
  }> = []

  for (const line of output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)) {
    const mac = line.match(/(?:at|lladdr)\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i)?.[1]
    const ip = line.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)/)?.[1] ||
      line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s/)?.[1]
    const hostname = line.match(/^([^\s(]+)\s+\(/)?.[1]
    const cleanHostname = hostname && hostname !== '?' ? hostname : undefined

    if (!ip || !isUsefulLanIp(ip)) continue
    if (!mac && !cleanHostname) continue

    devices.push({
      ipAddress: ip,
      macAddress: mac?.toLowerCase(),
      hostname: cleanHostname,
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
      const devices = mergeNeighborCandidates([
        ...parseArpOutput(stdout),
        ...configuredSeedHosts(),
      ])
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

  return mergeNeighborCandidates([
    ...inlineClients,
    ...fileClients,
    ...commandClients,
  ])
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
  const defaultCidrs = cidrs.length > 0
    ? cidrs
    : inferredZones.map((zone) => zone.cidr).filter((cidr): cidr is string => !!cidr)

  return [
    {
      id: 'local-lan',
      name: 'Local LAN',
      cidr: defaultCidrs[0],
      interfaceName: inferredZones[0]?.interfaceName,
      seedIps: configuredSeedHosts().map((host) => host.ipAddress),
      role: 'primary' as const,
    },
    ...defaultCidrs.slice(1).map((cidr, index) => ({
      id: `network-${index + 2}`,
      name: `Network ${index + 2}`,
      cidr,
      interfaceName: inferredZones[index + 1]?.interfaceName,
      seedIps: [],
      role: 'iot' as const,
    })),
  ]
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
    role?: NetworkDiscoveryZone['role']
  }

  const id = safeZoneId(raw.id || raw.name || `network-${index + 1}`)
  const seedIps = [...(raw.seedIps || []), ...(raw.seeds || [])]
    .filter((ipAddress) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipAddress))
    .filter(isUsefulLanIp)

  return {
    id,
    name: raw.name || displayNameFromZoneId(id),
    cidr: raw.cidr,
    interfaceName: raw.interfaceName || raw.interface,
    seedIps,
    role: raw.role,
  }
}

function isUsefulLanIp(ipAddress: string): boolean {
  return !/^127\./.test(ipAddress) &&
    !/^169\.254\./.test(ipAddress) &&
    !/^224\./.test(ipAddress) &&
    !/^0\./.test(ipAddress) &&
    ipAddress !== '255.255.255.255'
}

function mergeNeighborCandidates(
  candidates: NetworkCandidate[],
): NetworkCandidate[] {
  const byIp = new Map<string, NetworkCandidate>()

  for (const candidate of candidates) {
    byIp.set(candidate.ipAddress, {
      ...byIp.get(candidate.ipAddress),
      ...candidate,
    })
  }

  return [...byIp.values()]
}

async function enrichNetworkDevice(
  candidate: NetworkCandidate & {
    networkZoneId: string
    networkZoneName: string
  },
  discoveredAt: string,
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
    reason: candidate.reason || 'Visible in the local network neighbour table.',
  }

  const shelly = await probeShelly(candidate.ipAddress)
  if (!shelly) return base

  return {
    ...base,
    id: shelly.id || base.id,
    vendor: 'Shelly',
    protocol: 'http',
    confidence: 0.9,
    status: 'online',
    settingsUrl: `http://${candidate.ipAddress}`,
    model: shelly.model,
    app: shelly.app,
    generation: shelly.gen,
    reason: 'Shelly HTTP API responded on the local network.',
  }
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
  ) || zones[0]

  return {
    ...candidate,
    networkZoneId: zone?.id || 'local-lan',
    networkZoneName: zone?.name || 'Local LAN',
  }
}

export function candidateBelongsToConfiguredZone(
  candidate: Pick<NetworkCandidate, 'ipAddress' | 'networkZoneId'>,
  zones: NetworkDiscoveryZone[],
): boolean {
  if (zones.length === 0) return true
  return zones.some((zone) => candidateMatchesZone(candidate, zone))
}

function candidateMatchesZone(
  candidate: Pick<NetworkCandidate, 'ipAddress' | 'networkZoneId'>,
  zone: NetworkDiscoveryZone,
): boolean {
  return candidate.networkZoneId === zone.id ||
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
    protocol: 'unknown',
    confidence: 0.45,
    status: parseOnlineStatus(raw.status),
    reason: 'Router/client table reported this device on the site network.',
  }
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

async function activeScanZones(zones: NetworkDiscoveryZone[]): Promise<void> {
  if (process.env.HOME_LAN_ACTIVE_SCAN_ENABLED === 'false') return

  const targets = [
    ...new Set(zones.flatMap((zone) => [
      ...zone.seedIps,
      ...(zone.cidr ? ipsInCidr(zone.cidr) : []),
    ])),
  ]

  if (targets.length === 0) return

  await runPool(targets, activeScanConcurrency, pingHost)
}

async function pingHost(ipAddress: string): Promise<void> {
  const args = process.platform === 'darwin'
    ? ['-c', '1', '-W', '450', ipAddress]
    : ['-c', '1', '-W', '1', ipAddress]

  try {
    await execFileAsync('ping', args, { timeout: 1200 })
  } catch {
    // Many IoT devices ignore ICMP; the attempt can still populate ARP.
  }
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
  const byCidr = new Map<string, NetworkDiscoveryZone>()

  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses || shouldIgnoreInterface(interfaceName)) continue

    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal || !isUsefulLanIp(address.address)) continue
      if (!isPrivateIpv4(address.address)) continue

      const cidr = `${address.address.split('.').slice(0, 3).join('.')}.0/24`
      byCidr.set(cidr, {
        id: safeZoneId(interfaceName || cidr),
        name: displayNameFromZoneId(interfaceName || 'Local LAN'),
        cidr,
        interfaceName,
        seedIps: [],
        role: 'primary',
      })
    }
  }

  return [...byCidr.values()]
    .sort((a, b) => zoneSortRank(a.cidr || '') - zoneSortRank(b.cidr || ''))
    .slice(0, configuredActiveScanMaxZones())
}

function shouldIgnoreInterface(interfaceName: string): boolean {
  return /^(lo|docker|br-|veth|utun|awdl|llw|bridge|tailscale|zt)/i.test(interfaceName)
}

function isPrivateIpv4(ipAddress: string): boolean {
  return /^10\./.test(ipAddress) ||
    /^192\.168\./.test(ipAddress) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ipAddress)
}

function zoneSortRank(cidr: string): number {
  if (cidr.startsWith('192.168.')) return 0
  if (cidr.startsWith('10.')) return 1
  if (cidr.startsWith('172.')) return 2
  return 3
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

async function probeShelly(ipAddress: string): Promise<{
  id?: string
  model?: string
  app?: string
  gen?: number
} | null> {
  const baseUrl = `http://${ipAddress}`
  const candidates = [`${baseUrl}/rpc/Shelly.GetDeviceInfo`, `${baseUrl}/shelly`]

  for (const url of candidates) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1000)

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })

      if (!response.ok) continue

      const body = await response.json() as Record<string, unknown>
      if (!looksLikeShelly(body)) continue

      return {
        id: stringValue(body.id) || stringValue(body.mac),
        model: stringValue(body.model) || stringValue(body.type),
        app: stringValue(body.app) || stringValue(body.app_name),
        gen: numberValue(body.gen),
      }
    } catch {
      // Most LAN devices will not be Shelly. Silence is useful here.
    } finally {
      clearTimeout(timeout)
    }
  }

  return null
}

function looksLikeShelly(body: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(body.id)?.toLowerCase().includes('shelly') ||
      stringValue(body.model)?.toLowerCase().includes('shelly') ||
      stringValue(body.type)?.toLowerCase().includes('shelly') ||
      stringValue(body.app)?.toLowerCase().includes('shelly') ||
      body.gen,
  )
}

function vendorFromCandidate(candidate: { macAddress?: string; hostname?: string }): string | undefined {
  const text = `${candidate.hostname || ''} ${candidate.macAddress || ''}`.toLowerCase()
  if (text.includes('shelly')) return 'Shelly'
  if (text.includes('espressif')) return 'Espressif'
  return undefined
}

function dedupeNetworkDevices(devices: NetworkDiscoveredDevice[]): NetworkDiscoveredDevice[] {
  const byKey = new Map<string, NetworkDiscoveredDevice>()

  for (const device of devices) {
    byKey.set(device.macAddress || device.ipAddress, device)
  }

  return [...byKey.values()].sort((a, b) => a.ipAddress.localeCompare(b.ipAddress))
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
