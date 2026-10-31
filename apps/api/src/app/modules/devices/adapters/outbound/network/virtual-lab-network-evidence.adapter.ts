import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../../../device-registry.types'
import type { LocalNetworkRuntimeReport } from './local-network-runtime.adapter'
import type { NmapCapability, NmapScanResult } from './nmap-network-evidence.adapter'

const DOCKER_CONTEXT_ENV = 'HOME_VIRTUAL_LAB_DOCKER_CONTEXT'
const DOCKER_CONTEXT = 'energrid-lab-ssh'
const DOCKER_NETWORK = 'energrid-device-lab-vlan'
const VIRTUAL_LAB_SCOPE_ID = 'device-lab-vlan'
const VIRTUAL_LAB_CIDR = '172.30.250.0/28'
const VIRTUAL_LAB_MAX_HOSTS = 14
const SCANNER_IMAGE = 'energrid-device-lab-core-scan-m2:local'
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const SCAN_TIMEOUT_MS = 150_000
const HTTP_READ_TIMEOUT_MS = 10_000
const HTTP_READ_MAX_OUTPUT_BYTES = 32 * 1024
const SHELLY_VERIFY_TIMEOUT_MS = 15_000
const SHELLY_VERIFY_MAX_OUTPUT_BYTES = 128 * 1024

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

export interface VirtualLabShellyRpcEvidence {
  identity: Record<string, unknown>
  componentKeys: string[]
  componentStatuses: Array<{ componentKey: string; body: Record<string, unknown>; observedAt: string }>
  observer: { id: string; host: string; interfaceName: string }
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
  private readonly logger = new Logger(VirtualLabNetworkEvidenceAdapter.name)

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

  /** Verify one saved Shelly endpoint through the configured isolated Lab observer. */
  async verifyShellyComponent(
    zone: NetworkDiscoveryZone,
    targetIp: string,
    expectedPhysicalId: string,
    expectedComponentKeys: string[],
    signal?: AbortSignal,
  ): Promise<VirtualLabShellyRpcEvidence> {
    const targets = authorizedVirtualLabScanTargets(zone)
    const components = [...new Set(expectedComponentKeys)].sort()
    if (!targets.includes(targetIp) || !/^shelly[a-z0-9._-]{1,114}$/i.test(expectedPhysicalId) ||
        components.length === 0 || components.length > 32 ||
        components.some(component => !/^(?:switch|em1):(?:[0-9]|[12][0-9]|3[01])$/.test(component))) {
      throw shellyAdapterError('Virtual Lab Shelly verification target is outside the authorized observer scope or has an unsupported identity/component set.', 'VIRTUAL_LAB_SHELLY_SCOPE_REJECTED', undefined)
    }
    const context = process.env[DOCKER_CONTEXT_ENV]
    const expectedHost = process.env.HOME_VIRTUAL_LAB_DOCKER_HOST
    if (context !== DOCKER_CONTEXT || !expectedHost || !isIpv4(expectedHost)) {
      throw shellyAdapterError(`Virtual Lab verification requires HOME_VIRTUAL_LAB_DOCKER_CONTEXT=${DOCKER_CONTEXT} and an explicitly configured Docker host.`, 'VIRTUAL_LAB_SHELLY_OBSERVER_UNAVAILABLE', undefined)
    }
    const host = await this.remoteDockerHost(context, signal)
    if (host !== expectedHost) throw shellyAdapterError('Virtual Lab Docker context host does not match the explicitly configured Lab host.', 'VIRTUAL_LAB_SHELLY_OBSERVER_MISMATCH', undefined)
    await this.assertInternalNetwork(context, signal)
    const payload = await this.runFixedShellyRead(context, targetIp, expectedPhysicalId, components, targets, signal)
    if (!validShellyRpcPayload(payload, components)) {
      throw shellyAdapterError('Virtual Lab returned malformed or incomplete bounded Shelly RPC evidence.', 'VIRTUAL_LAB_SHELLY_INVALID_OUTPUT', undefined)
    }
    return {
      identity: payload.identity,
      componentKeys: payload.componentKeys,
      componentStatuses: payload.componentStatuses,
      observer: { id: `virtual-lab-docker/${host}/${zone.interfaceName || 'eth0'}`, host,
        interfaceName: zone.interfaceName || 'eth0' },
    }
  }

  async scan(zone: NetworkDiscoveryZone, signal?: AbortSignal): Promise<VirtualLabScanResult> {
    const targets = authorizedVirtualLabScanTargets(zone)
    const context = process.env[DOCKER_CONTEXT_ENV]
    const expectedHost = process.env.HOME_VIRTUAL_LAB_DOCKER_HOST
    if (context !== DOCKER_CONTEXT || !expectedHost || !isIpv4(expectedHost)) {
      throw new Error(`Virtual Lab scans require HOME_VIRTUAL_LAB_DOCKER_CONTEXT=${DOCKER_CONTEXT} and an explicitly configured Docker host.`)
    }
    const host = await this.remoteDockerHost(context, signal)
    if (host !== expectedHost) {
      this.logScanFailure('ssh_docker_failure', 'configured_observer_mismatch', zone.id)
      throw new Error('Virtual Lab Docker context host does not match the explicitly configured Lab host.')
    }
    await this.assertInternalNetwork(context, signal)
    const payload = await this.runFixedScanner(context, zone, targets, host, signal)
    let validated: ScannerPayload
    try {
      validated = validateScannerPayload(payload, zone, targets)
    } catch (error) {
      this.logScanFailure('invalid_output', 'scanner_payload_validation', zone.id)
      throw error
    }
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
    } catch (error) {
      this.logScanFailure('ssh_docker_failure', 'docker_context_inspect', undefined, error)
      throw shellyAdapterError('Virtual Lab Docker context is unavailable or is not an SSH context.', 'VIRTUAL_LAB_SHELLY_OBSERVER_UNAVAILABLE', error)
    }
  }

  private async assertInternalNetwork(context: string, signal?: AbortSignal): Promise<void> {
    try {
      const result = await this.run([
        '--context', context, 'network', 'inspect', DOCKER_NETWORK,
        '--format', '{{.Name}} {{.Driver}} {{.Internal}}',
      ], { timeout: 5_000, maxBuffer: 16 * 1024, ...(signal ? { signal } : {}) })
      if (result.stdout.trim() !== `${DOCKER_NETWORK} bridge true`) throw new Error('network isolation is not enabled')
    } catch (error) {
      this.logScanFailure('ssh_docker_failure', 'private_network_inspect', undefined, error)
      throw shellyAdapterError('Virtual Lab Docker network failed its private internal-bridge check; no scan was run.', 'VIRTUAL_LAB_SHELLY_NETWORK_CHECK_FAILED', error)
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
      try {
        return JSON.parse(String(result.stdout || '')) as ScannerPayload
      } catch {
        this.logScanFailure('invalid_output', 'scanner_json_parse', zone.id)
        throw new Error('Virtual Lab scanner returned malformed bounded evidence; no snapshot was saved.')
      }
    } catch (error) {
      if (signal?.aborted) throw new Error('Virtual Lab scan was cancelled by the operator.')
      if (isTimeout(error)) {
        this.logScanFailure('runner_failure', 'scanner_execution_deadline', zone.id)
        throw new Error('Virtual Lab scan exceeded its 150-second execution limit.')
      }
      if (error instanceof Error && error.message === 'Virtual Lab scanner returned malformed bounded evidence; no snapshot was saved.') throw error
      this.logScanFailure(isSshOrDockerFailure(error) ? 'ssh_docker_failure' : 'runner_failure', 'scanner_container_run', zone.id, error)
      throw new Error('Virtual Lab scanner failed within the authorized bounded scope; no snapshot was saved. Check the scanner image, observer connectivity, and Nmap coverage diagnostics.')
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

  private async runFixedShellyRead(
    context: string,
    targetIp: string,
    expectedPhysicalId: string,
    componentKeys: string[],
    targets: string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = [
      '--context', context, 'run', '--rm', '--pull=never',
      '--name', `energrid-device-lab-shelly-verify-${randomUUID()}`,
      '--network', DOCKER_NETWORK,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
      '--user', '65534:65534',
      '--env', `M6_TARGET_IP=${targetIp}`,
      '--env', `M6_EXPECTED_PHYSICAL_ID=${expectedPhysicalId}`,
      '--env', `M6_ALLOWED_TARGETS_JSON=${JSON.stringify(targets)}`,
      '--env', `M6_EXPECTED_COMPONENTS_JSON=${JSON.stringify(componentKeys)}`,
      '--entrypoint', 'node', SCANNER_IMAGE,
      '-e', FIXED_SHELLY_READ_SCRIPT,
    ]
    try {
      const result = await this.run(args, {
        timeout: SHELLY_VERIFY_TIMEOUT_MS,
        maxBuffer: SHELLY_VERIFY_MAX_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
      })
      if (Buffer.byteLength(result.stdout) > SHELLY_VERIFY_MAX_OUTPUT_BYTES) {
        throw new Error('Virtual Lab Shelly RPC evidence exceeded its output limit.')
      }
      return JSON.parse(String(result.stdout || '')) as unknown
    } catch (error) {
      if (signal?.aborted) throw shellyAdapterError('Virtual Lab Shelly verification was cancelled.', 'VIRTUAL_LAB_SHELLY_CANCELLED', error)
      if (isTimeout(error)) throw shellyAdapterError('Virtual Lab Shelly verification exceeded its 15-second execution limit.', 'VIRTUAL_LAB_SHELLY_EXECUTION_TIMEOUT', error)
      if (error instanceof SyntaxError) throw shellyAdapterError('Virtual Lab Shelly observer returned malformed RPC evidence.', 'VIRTUAL_LAB_SHELLY_INVALID_OUTPUT', error)
      throw shellyAdapterError('Virtual Lab bounded Shelly RPC verification failed.', 'VIRTUAL_LAB_SHELLY_EXECUTION_FAILED', error)
    }
  }

  private logScanFailure(
    category: 'ssh_docker_failure' | 'runner_failure' | 'invalid_output',
    stage: string,
    scopeId?: string,
    error?: unknown,
  ): void {
    const record: Record<string, string | number> = { event: 'virtual_lab_scan_failure', category, stage }
    if (scopeId) record.scopeId = scopeId
    const code = safeProcessErrorCode(error)
    if (code !== undefined) record.exitCode = code
    this.logger.warn(JSON.stringify(record))
  }
}

function shellyAdapterError(message: string, code: string, cause: unknown): Error {
  const error = new Error(message, { cause }) as Error & { code: string }
  error.code = code
  return error
}

function safeProcessErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined
}

function isSshOrDockerFailure(error: unknown): boolean {
  if (safeProcessErrorCode(error) === 125) return true
  if (!error || typeof error !== 'object') return false
  const record = error as { code?: unknown; stderr?: unknown; message?: unknown }
  if (typeof record.code === 'string' && /^(?:ECONN[A-Z]+|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|ENOENT)$/.test(record.code)) return true
  const diagnostic = `${typeof record.message === 'string' ? record.message : ''} ${typeof record.stderr === 'string' ? record.stderr : ''}`
  return /(?:ssh: connect to host|connection timed out|connection refused|could not resolve hostname|docker daemon|error response from daemon|error during connect|operation not permitted)/i.test(diagnostic)
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

// Fixed selected-target RPC read. It cannot accept a command, image, network,
// or target beyond the server-supplied authorized Lab scope.
const FIXED_SHELLY_READ_SCRIPT = String.raw`
const allowed = JSON.parse(process.env.M6_ALLOWED_TARGETS_JSON || 'null');
const expectedComponents = JSON.parse(process.env.M6_EXPECTED_COMPONENTS_JSON || 'null');
const ip = process.env.M6_TARGET_IP || '';
const expectedId = (process.env.M6_EXPECTED_PHYSICAL_ID || '').toLowerCase();
if (!Array.isArray(allowed) || allowed.length !== ${VIRTUAL_LAB_MAX_HOSTS} || !allowed.includes(ip) ||
    !/^shelly[a-z0-9._-]{1,114}$/.test(expectedId) || !Array.isArray(expectedComponents) ||
    expectedComponents.length < 1 || expectedComponents.length > 32 ||
    expectedComponents.some(key => !/^(switch|em1):(0|[1-9]|[12][0-9]|3[01])$/.test(key))) throw Error('target rejected');
async function get(path, maxBytes = 16384) {
  const response = await fetch('http://' + ip + path, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(1500),
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  if (response.status >= 300 && response.status < 400) throw Error('redirect rejected');
  if (!response.ok) throw Error('RPC request failed');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw Error('response too large'); }
    chunks.push(Buffer.from(item.value));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid RPC response');
  return value;
}
(async () => {
  const identity = await get('/rpc/Shelly.GetDeviceInfo', 8192);
  if (typeof identity.id !== 'string' || identity.id.toLowerCase() !== expectedId ||
      typeof identity.gen !== 'number' || identity.gen < 2) throw Error('identity mismatch');
  const keys = []; let offset = 0; let total = null;
  while (offset < 32) {
    const page = await get('/rpc/Shelly.GetComponents' + (offset ? '?offset=' + offset : ''), 16384);
    if (!Array.isArray(page.components) || !Number.isInteger(page.total) || page.total < 0 || page.total > 32 ||
        page.offset !== offset || (total !== null && page.total !== total)) throw Error('invalid component list');
    total = page.total;
    for (const item of page.components) if (item && typeof item.key === 'string' && /^(switch|em1):(0|[1-9]|[12][0-9]|3[01])$/.test(item.key)) keys.push(item.key);
    if (page.components.length === 0 && offset < total) throw Error('incomplete component list');
    offset += page.components.length;
    if (offset >= total) break;
    if (page.components.length === 0 || offset > total) throw Error('invalid component paging');
  }
  if (total === null || offset !== total || keys.length !== new Set(keys).size ||
      expectedComponents.some(key => !keys.includes(key))) throw Error('component profile mismatch');
  const statuses = [];
  for (let start = 0; start < expectedComponents.length; start += 4) {
    const batch = expectedComponents.slice(start, start + 4);
    const results = await Promise.all(batch.map(async componentKey => {
      const [kind, idText] = componentKey.split(':'); const id = Number(idText);
      const body = await get('/rpc/' + (kind === 'switch' ? 'Switch' : 'EM1') + '.GetStatus?id=' + id);
      if (body.id !== id || (kind === 'switch' ? typeof body.output !== 'boolean' : typeof body.act_power !== 'number'))
        throw Error('component status mismatch');
      return { componentKey, body, observedAt: new Date().toISOString() };
    }));
    statuses.push(...results);
  }
  process.stdout.write(JSON.stringify({ identity, componentKeys: keys, componentStatuses: statuses }));
})().catch(error => { process.stderr.write(error.name || 'read_failed'); process.exitCode = 1; });
`;

function validShellyRpcPayload(
  value: unknown,
  expectedComponents: string[],
): value is { identity: Record<string, unknown>; componentKeys: string[]; componentStatuses: Array<{ componentKey: string; body: Record<string, unknown>; observedAt: string }> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!record.identity || typeof record.identity !== 'object' || Array.isArray(record.identity) ||
      !Array.isArray(record.componentKeys) || record.componentKeys.length > 32 ||
      record.componentKeys.some(key => typeof key !== 'string' || !/^(?:switch|em1):(?:[0-9]|[12][0-9]|3[01])$/.test(key)) ||
      new Set(record.componentKeys).size !== record.componentKeys.length ||
      !Array.isArray(record.componentStatuses) || record.componentStatuses.length !== expectedComponents.length) return false
  const componentKeys = record.componentKeys as string[]
  const statuses = record.componentStatuses as unknown[]
  return expectedComponents.every(key => componentKeys.includes(key)) && expectedComponents.every(key => statuses.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const status = item as Record<string, unknown>
    return status.componentKey === key && !!status.body && typeof status.body === 'object' && !Array.isArray(status.body) &&
      typeof status.observedAt === 'string' && Number.isFinite(Date.parse(status.observedAt))
  }))
}

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
  const config = validateVirtualLabScope(zone)
  if (config.targets.length !== 2) {
    throw new Error('Virtual Lab single-device reads require exactly two in-scope configured seed addresses.')
  }
  return { targets: config.targets }
}

function validateVirtualLabScope(zone: NetworkDiscoveryZone): { targets: string[] } {
  const cidr = parseCidr(zone.cidr)
  const seedIps = Array.isArray(zone.seedIps) ? zone.seedIps : []
  const targets = [...new Set(seedIps)]
  if (zone.collectionSource !== 'virtual-lab' || !cidr || cidr.prefix < 28 || cidr.prefix > 29 ||
      targets.length > VIRTUAL_LAB_MAX_HOSTS || targets.some(target => !isIpv4(target) || !insideCidr(target, zone.cidr!))) {
    throw new Error('Virtual Lab scope must define one private /28 or /29 and only in-scope seed addresses.')
  }
  return { targets: targets.sort(compareIpv4) }
}

function authorizedVirtualLabScanTargets(zone: NetworkDiscoveryZone): string[] {
  validateVirtualLabScope(zone)
  if (zone.id !== VIRTUAL_LAB_SCOPE_ID || zone.cidr !== VIRTUAL_LAB_CIDR ||
      (zone.interfaceName && zone.interfaceName !== 'eth0')) {
    throw new Error(`Virtual Lab subnet scans are restricted to the configured ${VIRTUAL_LAB_SCOPE_ID} scope (${VIRTUAL_LAB_CIDR}) on eth0.`)
  }
  const parsed = parseCidr(zone.cidr)
  if (!parsed) throw new Error('Virtual Lab scope must be a valid authorized IPv4 network.')
  const addressCount = 2 ** (32 - parsed.prefix)
  const targets = Array.from({ length: addressCount - 2 }, (_, index) => ipv4FromNumber(parsed.network + index + 1))
  if (targets.length !== VIRTUAL_LAB_MAX_HOSTS || targets.some(target => !insideCidr(target, VIRTUAL_LAB_CIDR))) {
    throw new Error('Virtual Lab scope exceeded its fixed bounded target limit.')
  }
  return targets
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

function ipv4FromNumber(value: number): string {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join('.')
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
