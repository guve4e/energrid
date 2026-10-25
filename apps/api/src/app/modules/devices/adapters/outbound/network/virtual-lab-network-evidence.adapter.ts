import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../../../device-registry.types'
import type { LocalNetworkRuntimeReport } from './local-network-runtime.adapter'
import type { NmapCapability, NmapScanResult } from './nmap-network-evidence.adapter'

const DOCKER_CONTEXT_ENV = 'HOME_VIRTUAL_LAB_DOCKER_CONTEXT'
const DOCKER_CONTEXT = 'energrid-lab-ssh'
const DOCKER_NETWORK = 'energrid-device-lab-vlan'
const SCANNER_IMAGE = 'energrid-device-lab-core-scan-m2:local'
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const SCAN_TIMEOUT_MS = 150_000
const HTTP_READ_TIMEOUT_MS = 10_000
const HTTP_READ_MAX_OUTPUT_BYTES = 32 * 1024

interface CommandOptions { timeout: number; maxBuffer: number; signal?: AbortSignal }
interface CommandResult { stdout: string; stderr: string }
type CommandRunner = (args: string[], options: CommandOptions) => Promise<CommandResult>
const runDocker: CommandRunner = (args, options) => new Promise((resolve, reject) => {
  execFile('docker', args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) {
      Object.assign(error, { stdout: String(stdout || ''), stderr: String(stderr || '') })
      reject(error)
      return
    }
    resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
  })
})

export interface VirtualLabScanResult {
  devices: NetworkDiscoveredDevice[]
  candidates: Array<Record<string, unknown>>
  nmap: NmapScanResult
  collector: { id: string; host: string; interfaces: string[] }
  runtime?: LocalNetworkRuntimeReport
}

export interface VirtualLabHttpResponse {
  status: number
  body: unknown | null
}

export interface VirtualLabEnergridHttpEvidence {
  identity: VirtualLabHttpResponse
  status: VirtualLabHttpResponse | null
}

type ScannerPayload = {
  schemaVersion: number
  scope: { id: string; name: string; configuredNetworkCidr: string; interfaceName: string; explicitTargets: string[] }
  collector?: { id: string; host: string; interfaces: string[] }
  nmap: {
    capability: NmapCapability
    hosts: NmapScanResult['hosts']
    methods: string[]
    scopes: NmapScanResult['scopes']
    failures: string[]
    limitations: string[]
    cancelled?: boolean
  }
  runtime?: LocalNetworkRuntimeReport
  normalizedCandidates: Array<Record<string, unknown>>
  networkDevices: NetworkDiscoveredDevice[]
  startedAt: string
  completedAt: string
}

/**
 * Runs only the prebuilt Device Lab scanner on its named private Docker network.
 * It never accepts a command, image, network, or address from a Portal request.
 */
export class VirtualLabNetworkEvidenceAdapter {
  constructor(private readonly run: CommandRunner = runDocker) {}

  /** Read the two fixed firmware GET endpoints from the isolated observer network. */
  async readEnergridHttpEvidence(
    zone: NetworkDiscoveryZone,
    targetIp: string,
    expectedPhysicalId: string,
    signal?: AbortSignal,
  ): Promise<VirtualLabEnergridHttpEvidence> {
    const { targets } = validateVirtualLabZone(zone)
    if (!targets.includes(targetIp) || !/^esp8266:[0-9a-f]{6}$/i.test(expectedPhysicalId)) {
      throw new Error('Virtual Lab HTTP poll target is not an explicitly configured Energrid device.')
    }
    const context = process.env[DOCKER_CONTEXT_ENV]
    const expectedHost = process.env.HOME_VIRTUAL_LAB_DOCKER_HOST
    if (context !== DOCKER_CONTEXT || !expectedHost || !isIpv4(expectedHost)) {
      throw new Error(`Virtual Lab polls require HOME_VIRTUAL_LAB_DOCKER_CONTEXT=${DOCKER_CONTEXT} and an explicitly configured Docker host.`)
    }
    const host = await this.remoteDockerHost(context, signal)
    if (host !== expectedHost) throw new Error('Virtual Lab Docker context host does not match the explicitly configured Lab host.')
    await this.assertInternalNetwork(context, signal)

    const result = await this.runFixedEnergridRead(context, targetIp, expectedPhysicalId, targets, signal)
    if (!validHttpEvidence(result)) throw new Error('Virtual Lab returned malformed bounded HTTP evidence.')
    return result
  }

  async scan(zone: NetworkDiscoveryZone, signal?: AbortSignal): Promise<VirtualLabScanResult> {
    const config = validateVirtualLabZone(zone)
    const context = process.env[DOCKER_CONTEXT_ENV]
    const expectedHost = process.env.HOME_VIRTUAL_LAB_DOCKER_HOST
    if (context !== DOCKER_CONTEXT || !expectedHost || !isIpv4(expectedHost)) {
      throw new Error(`Virtual Lab scans require HOME_VIRTUAL_LAB_DOCKER_CONTEXT=${DOCKER_CONTEXT} and an explicitly configured Docker host.`)
    }
    const host = await this.remoteDockerHost(context, signal)
    if (host !== expectedHost) throw new Error('Virtual Lab Docker context host does not match the explicitly configured Lab host.')
    await this.assertInternalNetwork(context, signal)
    const payload = await this.runFixedScanner(context, zone, config.targets, host, signal)
    const validated = validateScannerPayload(payload, zone, config.targets)
    return {
      devices: validated.networkDevices,
      candidates: validated.normalizedCandidates,
      nmap: {
        capability: validated.nmap.capability,
        hosts: validated.nmap.hosts,
        scopes: validated.nmap.scopes,
        methods: validated.nmap.methods,
        failures: validated.nmap.failures,
        limitations: validated.nmap.limitations,
        cancelled: validated.nmap.cancelled === true,
      },
      collector: validated.collector || {
        id: `virtual-lab-docker/${host}/eth0`,
        host,
        interfaces: ['eth0'],
      },
      ...(validated.runtime ? { runtime: validated.runtime } : {}),
    }
  }

  private async remoteDockerHost(context: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.run([
        'context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}',
      ], { timeout: 5_000, maxBuffer: 16 * 1024, ...(signal ? { signal } : {}) })
      const endpoint = result.stdout.trim()
      const parsed = new URL(endpoint)
      if (parsed.protocol !== 'ssh:' || !parsed.hostname) throw new Error('not an SSH Docker context')
      return parsed.hostname
    } catch {
      throw new Error('Virtual Lab Docker context is unavailable or is not an SSH context.')
    }
  }

  private async assertInternalNetwork(context: string, signal?: AbortSignal): Promise<void> {
    try {
      const result = await this.run([
        '--context', context, 'network', 'inspect', DOCKER_NETWORK,
        '--format', '{{.Name}} {{.Driver}} {{.Internal}}',
      ], { timeout: 5_000, maxBuffer: 16 * 1024, ...(signal ? { signal } : {}) })
      if (result.stdout.trim() !== `${DOCKER_NETWORK} bridge true`) throw new Error('network isolation is not enabled')
    } catch {
      throw new Error('Virtual Lab Docker network failed its private internal-bridge check; no scan was run.')
    }
  }

  private async runFixedScanner(
    context: string,
    zone: NetworkDiscoveryZone,
    targets: string[],
    observerHost: string,
    signal?: AbortSignal,
  ): Promise<ScannerPayload> {
    const args = [
      '--context', context, 'run', '--rm', '--pull=never',
      '--name', `energrid-device-lab-scan-${randomUUID()}`,
      '--network', DOCKER_NETWORK,
      '--cap-drop', 'ALL', '--cap-add', 'NET_RAW',
      '--security-opt', 'no-new-privileges', '--read-only',
      '--tmpfs', '/tmp:size=32m,noexec,nosuid,nodev', '--dns', '127.0.0.1',
      '--env', `M2_LAB_CIDR=${zone.cidr}`,
      '--env', `M2_LAB_SCOPE_ID=${zone.id}`,
      '--env', `M2_LAB_SCOPE_NAME=${zone.name}`,
      '--env', `M2_OBSERVER_HOST=${observerHost}`,
      '--env', `M2_MAX_HOSTS=${targets.length}`,
      '--env', `M2_SCAN_TARGETS_JSON=${JSON.stringify(targets)}`,
      SCANNER_IMAGE,
    ]
    try {
      const result = await this.run(args, {
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
      })
      return JSON.parse(String(result.stdout || '')) as ScannerPayload
    } catch (error) {
      if (signal?.aborted) throw new Error('Virtual Lab scan was cancelled by the operator.')
      if (isTimeout(error)) throw new Error('Virtual Lab scan exceeded its 150-second execution limit.')
      if (error instanceof SyntaxError) throw new Error('Virtual Lab scanner returned malformed JSON evidence.')
      throw new Error('Virtual Lab scanner failed. Confirm the two configured devices and scanner image are available.')
    }
  }

  private async runFixedEnergridRead(
    context: string,
    targetIp: string,
    expectedPhysicalId: string,
    targets: string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = [
      '--context', context, 'run', '--rm', '--pull=never',
      '--name', `energrid-device-lab-http-read-${randomUUID()}`,
      '--network', DOCKER_NETWORK,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
      '--tmpfs', '/tmp:size=8m,noexec,nosuid,nodev',
      '--env', `M5_TARGET_IP=${targetIp}`,
      '--env', `M5_EXPECTED_PHYSICAL_ID=${expectedPhysicalId}`,
      '--env', `M5_ALLOWED_TARGETS_JSON=${JSON.stringify(targets)}`,
      '--entrypoint', 'node', SCANNER_IMAGE,
      '-e', FIXED_ENERGRID_HTTP_READ_SCRIPT,
    ]
    try {
      const result = await this.run(args, {
        timeout: HTTP_READ_TIMEOUT_MS,
        maxBuffer: HTTP_READ_MAX_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
      })
      if (Buffer.byteLength(result.stdout) > HTTP_READ_MAX_OUTPUT_BYTES) {
        throw new Error('Virtual Lab HTTP evidence exceeded its output limit.')
      }
      return JSON.parse(String(result.stdout || '')) as unknown
    } catch (error) {
      if (signal?.aborted) throw new Error('Virtual Lab HTTP poll was cancelled.')
      if (isTimeout(error)) throw new Error('Virtual Lab HTTP poll exceeded its 10-second limit.')
      if (error instanceof SyntaxError) throw new Error('Virtual Lab HTTP poll returned malformed JSON evidence.')
      throw new Error('Virtual Lab bounded HTTP poll failed.')
    }
  }
}

// This program is fixed in the API source and passed as one argv value (never a
// shell command). It permits only the two firmware GET paths, the configured
// seed IPs, exact identity confirmation before status, bounded bodies and no
// redirects. The Docker network is independently required to be internal.
const FIXED_ENERGRID_HTTP_READ_SCRIPT = String.raw`
const allowed = JSON.parse(process.env.M5_ALLOWED_TARGETS_JSON || 'null');
const ip = process.env.M5_TARGET_IP || '';
const expected = (process.env.M5_EXPECTED_PHYSICAL_ID || '').toLowerCase();
if (!Array.isArray(allowed) || allowed.length !== 2 || !allowed.includes(ip) ||
    !/^esp8266:[0-9a-f]{6}$/.test(expected)) throw Error('target rejected');
async function get(path, maxBytes) {
  const response = await fetch('http://' + ip + path, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(2500),
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  if (response.status >= 300 && response.status < 400) throw Error('redirect rejected');
  if (!response.ok) return { status: response.status, body: null };
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw Error('response too large'); }
    chunks.push(Buffer.from(item.value));
  }
  return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
(async () => {
  const identity = await get('/api/v1/identity', 4096);
  const id = identity.body && typeof identity.body.id === 'string' ? identity.body.id.toLowerCase() : '';
  const capabilities = identity.body && Array.isArray(identity.body.capabilities) ? identity.body.capabilities : [];
  const matches = identity.status === 200 && identity.body.schemaVersion === 1 && id === expected &&
    typeof identity.body.model === 'string' && identity.body.model.startsWith('Energrid ESP8266') &&
    typeof identity.body.firmwareVersion === 'string' && capabilities.includes('temperature') && capabilities.includes('humidity');
  const status = matches ? await get('/api/v1/status', 16384) : null;
  process.stdout.write(JSON.stringify({ identity, status }));
})().catch(error => { process.stderr.write(error.name || 'read_failed'); process.exitCode = 1; });
`;

function validHttpEvidence(value: unknown): value is VirtualLabEnergridHttpEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return validHttpResponse(record.identity) &&
    (record.status === null || validHttpResponse(record.status))
}

function validHttpResponse(value: unknown): value is VirtualLabHttpResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return Number.isInteger(response.status) && (response.status as number) >= 100 && (response.status as number) <= 599 &&
    (response.body === null || (typeof response.body === 'object' && !Array.isArray(response.body)))
}

function validateVirtualLabZone(zone: NetworkDiscoveryZone): { targets: string[] } {
  const cidr = parseCidr(zone.cidr)
  const targets = [...new Set(zone.seedIps)]
  if (zone.collectionSource !== 'virtual-lab' || !cidr || cidr.prefix < 28 || cidr.prefix > 29 ||
      targets.length !== 2 || targets.some(target => !isIpv4(target) || !insideCidr(target, zone.cidr!))) {
    throw new Error('Virtual Lab scope must define one private /28 or /29 and exactly two in-scope seed addresses.')
  }
  return { targets: targets.sort(compareIpv4) }
}

function validateScannerPayload(
  payload: ScannerPayload,
  zone: NetworkDiscoveryZone,
  targets: string[],
): ScannerPayload {
  if (!payload || payload.schemaVersion !== 2 ||
      payload.scope?.id !== zone.id || payload.scope?.name !== zone.name ||
      payload.scope?.interfaceName !== 'eth0' || payload.scope?.configuredNetworkCidr !== zone.cidr ||
      !Array.isArray(payload.scope?.explicitTargets) ||
      JSON.stringify([...payload.scope.explicitTargets].sort(compareIpv4)) !== JSON.stringify(targets) ||
      !Array.isArray(payload.networkDevices) || payload.networkDevices.length > targets.length ||
      !Array.isArray(payload.normalizedCandidates) || !payload.nmap ||
      !validNmapCapability(payload.nmap.capability) ||
      !Array.isArray(payload.nmap.hosts) || !Array.isArray(payload.nmap.methods) || !Array.isArray(payload.nmap.scopes) ||
      !Array.isArray(payload.nmap.failures) || !Array.isArray(payload.nmap.limitations)) {
    throw new Error('Virtual Lab scanner evidence did not match the configured scope.')
  }
  const seen = new Set<string>()
  for (const device of payload.networkDevices) {
    if (!targets.includes(device.ipAddress) || seen.has(device.ipAddress) ||
        device.networkZoneId !== zone.id || device.networkZoneName !== zone.name ||
        !validIsoTime(device.discoveredAt) || typeof device.id !== 'string' ||
        !Array.isArray(device.observations)) {
      throw new Error('Virtual Lab scanner returned an endpoint outside the configured identities or scope.')
    }
    seen.add(device.ipAddress)
    const protocolIdentity = device.observations.find(item =>
      item.source === 'http_identity' && item.attribute === 'identity.device_id' && item.value === device.id &&
      device.observations?.some(verified => verified.source === 'http_identity' && verified.attribute === 'identity.verified' && verified.value === true),
    ) || device.observations.find(item =>
      item.source === 'http_rpc' && item.attribute === 'shelly.device_id' && item.value === device.id,
    )
    if (device.protocol !== 'unknown' && !protocolIdentity) {
      throw new Error('Virtual Lab scanner returned an identified device without matching protocol evidence.')
    }
  }
  for (const candidate of payload.normalizedCandidates) {
    if (!candidate || typeof candidate !== 'object' || !targets.includes(String(candidate.ipAddress)) ||
        candidate.networkZoneId !== zone.id || candidate.networkZoneName !== zone.name) {
      throw new Error('Virtual Lab scanner returned raw evidence outside the configured target list.')
    }
  }
  if (!validIsoTime(payload.startedAt) || !validIsoTime(payload.completedAt) ||
      Date.parse(payload.completedAt) < Date.parse(payload.startedAt)) {
    throw new Error('Virtual Lab scanner returned invalid observation timestamps.')
  }
  return payload
}

function validNmapCapability(value: unknown): value is NmapCapability {
  return !!value && typeof value === 'object' && typeof (value as NmapCapability).available === 'boolean'
}

function parseCidr(value: string | undefined): { network: number; prefix: number } | null {
  const match = value?.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (!match || !isIpv4(match[1])) return null
  const prefix = Number(match[2])
  if (prefix < 0 || prefix > 32) return null
  const first = Number(match[1].split('.')[0])
  const second = Number(match[1].split('.')[1])
  if (!(first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168))) return null
  const network = ipv4Number(match[1])
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  if (((network & mask) >>> 0) !== network) return null
  return { network, prefix }
}

function insideCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr)
  if (!parsed) return false
  const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0
  return (ipv4Number(ip) & mask) === (parsed.network & mask)
}

function isIpv4(value: string): boolean {
  const octets = value.split('.')
  return octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function ipv4Number(value: string): number {
  return value.split('.').reduce((sum, part) => (sum * 256 + Number(part)) >>> 0, 0)
}

function compareIpv4(left: string, right: string): number {
  return ipv4Number(left) - ipv4Number(right)
}

function validIsoTime(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isTimeout(error: unknown): boolean {
  return !!error && typeof error === 'object' &&
    ('code' in error && (error as { code?: unknown }).code === 'ETIMEDOUT')
}
