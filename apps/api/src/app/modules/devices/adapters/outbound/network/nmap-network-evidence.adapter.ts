import { SaxesParser } from 'saxes';
import { networkInterfaces } from 'node:os';
import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../../../device-registry.types';

export const NMAP_TCP_PORTS = [22, 53, 80, 443, 445, 554, 1883, 3000, 5000, 8008, 8080, 8443, 9000, 9100] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 240_000;
const MAX_HOSTS = 254;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const NMAP_EXECUTABLE = 'nmap';

export interface NmapCommandOptions {
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export interface NmapCommandResult {
  stdout: string;
  stderr: string;
}

export type NmapCommandRunner = (
  command: string,
  args: string[],
  options: NmapCommandOptions,
) => Promise<NmapCommandResult>;

export interface NmapCapability {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface NmapHostEvidence {
  scopeId: string;
  ipAddress: string;
  macAddress?: string;
  hostname?: string;
  status: NetworkDiscoveredDevice['status'];
  observedAt: string;
  interfaceName?: string;
  reason: string;
  observations: NonNullable<NetworkDiscoveredDevice['observations']>;
}

export interface NmapScopeResult {
  scopeId: string;
  complete: boolean;
  targetCount: number;
  hostsReported: number;
  interfaceName?: string;
  failure?: string;
}

export interface RouteInterfaceEvidence {
  interfaceName?: string;
}
export type RouteInterfaceResolver = (target: string) => Promise<RouteInterfaceEvidence>;

export interface NmapScanResult {
  capability: NmapCapability;
  hosts: NmapHostEvidence[];
  scopes: NmapScopeResult[];
  methods: string[];
  failures: string[];
  limitations: string[];
  cancelled: boolean;
}

export interface NmapParseOptions {
  scopeId: string;
  scopeCidr?: string;
  targets?: readonly string[];
  observedAt: string;
  interfaceName?: string;
  onLink: boolean;
}

export interface ParsedNmapXml {
  hosts: NmapHostEvidence[];
  complete: boolean;
  hostsTotal: number | null;
  exitStatus: string | null;
}

type LocalInterface = ReturnType<typeof networkInterfaces>;

interface WorkingHost {
  ipAddress?: string;
  observedMacAddress?: string;
  hostname?: string;
  observedAt?: string;
  status?: string;
  ports: Array<{ protocol: string; port: number; state: string; service?: string }>;
}

const defaultRunner: NmapCommandRunner = async (command, args, options) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout: String(stdout || ''), stderr: String(stderr || '') });
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
};

export class NmapNetworkEvidenceAdapter {
  constructor(
    private readonly runCommand: NmapCommandRunner = defaultRunner,
    private readonly readInterfaces: () => LocalInterface = networkInterfaces,
    private readonly now: () => Date = () => new Date(),
    private readonly resolveRoute: RouteInterfaceResolver = defaultRouteInterface,
  ) {}

  async getCapability(signal?: AbortSignal): Promise<NmapCapability> {
    try {
      const result = await this.runCommand(NMAP_EXECUTABLE, ['--version'], {
        timeout: 3_000,
        maxBuffer: 64 * 1024,
        ...(signal ? { signal } : {}),
      });
      const version = /^Nmap version\s+([^\s]+)/m.exec(result.stdout)?.[1];
      return version
        ? { available: true, version }
        : { available: false, reason: 'Nmap version output was not recognized.' };
    } catch {
      return { available: false, reason: 'Nmap executable is unavailable or could not be started.' };
    }
  }

  async scan(
    scopes: readonly NetworkDiscoveryZone[],
    options: { enabled?: boolean; maxHosts?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<NmapScanResult> {
    const maxHosts = boundedInteger(options.maxHosts, MAX_HOSTS, 1, MAX_HOSTS);
    const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
    const plans = scopes.map(scope => ({ scope, ...targetsForScope(scope, maxHosts) }));
    if (plans.length && plans.every(plan => !!plan.failure)) {
      return {
        capability: { available: false, reason: 'Nmap scopes failed validation.' },
        hosts: [], scopes: plans.map(plan => ({ scopeId: plan.scope.id, complete: false, targetCount: 0, hostsReported: 0, failure: plan.failure })),
        methods: [], failures: plans.map(plan => `${plan.scope.id}: ${plan.failure}`),
        limitations: plans.map(plan => `${plan.scope.id}: ${plan.failure}`), cancelled: false,
      };
    }
    const capability = await this.getCapability(options.signal);
    const result: NmapScanResult = {
      capability,
      hosts: [],
      scopes: [],
      methods: capability.available ? ['nmap_tcp_connect_service_scan'] : [],
      failures: [],
      limitations: [],
      cancelled: false,
    };

    if (options.enabled !== true) {
      result.limitations.push('Nmap scanning is disabled; set HOME_NMAP_ENABLED=true before an operator-approved scan.');
      result.scopes = plans.map(plan => ({
        scopeId: plan.scope.id, complete: false, targetCount: plan.targets.length, hostsReported: 0,
        ...(plan.failure ? { failure: plan.failure } : { failure: 'Nmap scanning is disabled.' }),
      }));
      return result;
    }

    if (!capability.available) {
      result.failures.push(capability.reason || 'Nmap is unavailable.');
      result.limitations.push('Nmap is unavailable; install Nmap to collect bounded TCP service evidence.');
      result.scopes = scopes.map(scope => ({
        scopeId: scope.id,
        complete: false,
        targetCount: 0,
        hostsReported: 0,
        failure: 'Nmap did not run because its executable is unavailable.',
      }));
      return result;
    }

    for (const plan of plans) {
      const { scope } = plan;
      if (options.signal?.aborted) {
        result.cancelled = true;
        break;
      }

      if (plan.failure) {
        result.failures.push(`${scope.id}: ${plan.failure}`);
        result.limitations.push(`${scope.id}: ${plan.failure}`);
        result.scopes.push({ scopeId: scope.id, complete: false, targetCount: 0, hostsReported: 0, failure: plan.failure });
        continue;
      }

      const targetInfo = plan;
      const interfaceInfo = localInterfaceForScope(scope, this.readInterfaces());
      const routeInfo = interfaceInfo ? {} : await this.resolveRoute(targetInfo.targets[0]);
      const observingInterface = interfaceInfo?.name || routeInfo.interfaceName;
      const observedAt = this.now().toISOString();
      const args = buildNmapArguments(targetInfo.targets, observingInterface);
      try {
        const commandResult = await this.runCommand(NMAP_EXECUTABLE, args, {
          timeout: timeoutMs,
          maxBuffer: MAX_XML_BYTES + 64 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const parsed = parseNmapXml(commandResult.stdout, {
          scopeId: scope.id,
          ...(scope.cidr ? { scopeCidr: scope.cidr } : {}),
          targets: targetInfo.targets,
          observedAt,
          ...(observingInterface ? { interfaceName: observingInterface } : {}),
          onLink: !!interfaceInfo,
        });
        const complete = parsed.complete && parsed.hostsTotal === targetInfo.targets.length;
        result.hosts.push(...parsed.hosts);
        result.scopes.push({
          scopeId: scope.id,
          complete,
          targetCount: targetInfo.targets.length,
          hostsReported: parsed.hostsTotal || 0,
          ...(observingInterface ? { interfaceName: observingInterface } : {}),
          ...(!complete ? { failure: 'Nmap did not report successful results for every selected address.' } : {}),
        });
        if (!complete) {
          result.failures.push(`${scope.id}: Nmap coverage was incomplete.`);
          result.limitations.push(`${scope.id}: Nmap coverage was incomplete; unreported endpoints remain unknown.`);
        }
      } catch (error) {
        const cancelled = options.signal?.aborted === true || isAbortError(error);
        const failure = cancelled
          ? 'Nmap scan was cancelled by the operator.'
          : isTimeoutError(error)
            ? 'Nmap scan reached its time limit.'
            : error instanceof Error && error.message === 'Invalid Nmap XML document.'
              ? error.message
              : 'Nmap failed before complete structured results were available.';
        result.cancelled ||= cancelled;
        result.failures.push(`${scope.id}: ${failure}`);
        result.limitations.push(`${scope.id}: ${failure} Unreported endpoints remain unknown.`);
        result.scopes.push({
          scopeId: scope.id,
          complete: false,
          targetCount: targetInfo.targets.length,
          hostsReported: 0,
          ...(observingInterface ? { interfaceName: observingInterface } : {}),
          failure,
        });
        if (cancelled) break;
      }
    }

    if (result.cancelled) {
      result.failures.push('Nmap scan was cancelled by the operator.');
      result.limitations.push('Cancelled Nmap scopes are incomplete; absence from this snapshot is not evidence that a host is offline.');
      for (const scope of scopes) {
        if (!result.scopes.some(item => item.scopeId === scope.id)) {
          result.scopes.push({ scopeId: scope.id, complete: false, targetCount: 0, hostsReported: 0, failure: 'Nmap scope was not started because the scan was cancelled.' });
        }
      }
    }

    return result;
  }
}

export function buildNmapArguments(targets: readonly string[], interfaceName?: string): string[] {
  return createNmapArguments(targets, interfaceName);
}

export function parseNmapXml(xml: string, options: NmapParseOptions): ParsedNmapXml {
  if (!xml || Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES || /<!ENTITY\b/i.test(xml)) {
    throw new Error('Invalid Nmap XML document.');
  }
  const targetSet = options.targets ? new Set(options.targets) : undefined;
  let rootSeen = false;
  let currentHost: WorkingHost | null = null;
  let currentPort: WorkingHost['ports'][number] | null = null;
  let hostsTotal: number | null = null;
  let exitStatus: string | null = null;
  const hosts: NmapHostEvidence[] = [];
  let parseError: Error | null = null;
  const parser = new SaxesParser({ xmlns: false });

  parser.on('error', error => { parseError ||= error; });
  parser.on('opentag', tag => {
    const attrs = tag.attributes as Record<string, string>;
    if (!rootSeen) {
      rootSeen = tag.name === 'nmaprun';
      if (!rootSeen) parseError = new Error('Invalid Nmap XML document.');
      return;
    }
    if (tag.name === 'host') {
      currentHost = { ports: [], observedAt: timestampFromEpoch(attrs.endtime) || options.observedAt };
    } else if (currentHost && tag.name === 'address') {
      const address = attrs.addr;
      if (attrs.addrtype === 'ipv4' && isIpv4(address)) currentHost.ipAddress = address;
      if (attrs.addrtype === 'mac' && validUnicastMac(address)) currentHost.observedMacAddress = normalizeMac(address);
    } else if (currentHost && tag.name === 'status') {
      currentHost.status = attrs.state;
    } else if (currentHost && tag.name === 'hostname' && attrs.name && !currentHost.hostname) {
      currentHost.hostname = attrs.name;
    } else if (currentHost && tag.name === 'port') {
      const port = Number(attrs.portid);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        currentPort = { protocol: attrs.protocol === 'udp' ? 'udp' : 'tcp', port, state: 'unknown' };
      }
    } else if (currentPort && tag.name === 'state') {
      currentPort.state = attrs.state || 'unknown';
    } else if (currentPort && tag.name === 'service') {
      currentPort.service = [attrs.name, attrs.product, attrs.version].filter(Boolean).join(' ').slice(0, 120);
    } else if (tag.name === 'hosts') {
      const total = Number(attrs.total);
      if (Number.isInteger(total) && total >= 0) hostsTotal = total;
    } else if (tag.name === 'finished') {
      exitStatus = attrs.exit || null;
    }
  });
  parser.on('closetag', tag => {
    const name = tag.name;
    if (name === 'port' && currentHost && currentPort) {
      currentHost.ports.push(currentPort);
      currentPort = null;
    } else if (name === 'host' && currentHost) {
      const host = normalizeHost(currentHost, options, targetSet);
      if (host) hosts.push(host);
      currentHost = null;
    }
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    parseError ||= error instanceof Error ? error : new Error('Invalid Nmap XML document.');
  }
  if (parseError || !rootSeen || hostsTotal === null || exitStatus === null) {
    throw new Error('Invalid Nmap XML document.');
  }
  return { hosts, complete: exitStatus === 'success', hostsTotal, exitStatus };
}

function normalizeHost(
  source: WorkingHost,
  options: NmapParseOptions,
  targetSet?: ReadonlySet<string>,
): NmapHostEvidence | null {
  const ipAddress = source.ipAddress;
  if (!ipAddress || !ipInScope(ipAddress, options.scopeCidr, targetSet)) return null;
  const observedAt = source.observedAt || options.observedAt;
  const observations: NmapHostEvidence['observations'] = [];
  for (const port of source.ports) {
    const inRange = port.port >= 1 && port.port <= 65535;
    if (!inRange || !['tcp', 'udp'].includes(port.protocol)) continue;
    observations.push(nmapObservation(options, observedAt, `port.${port.port}.${port.state}`, port.state === 'open'));
    if (port.state === 'open' && port.service) {
      observations.push(nmapObservation(options, observedAt, `port.${port.port}.service`, port.service));
    }
  }
  const openPorts = source.ports.filter(port => port.state === 'open');
  const hasResponsivePort = source.ports.some(port => port.state === 'open' || port.state === 'closed');
  if (!hasResponsivePort && !(options.onLink && source.observedMacAddress)) return null;
  return {
    scopeId: options.scopeId,
    ipAddress,
    ...(options.onLink && source.observedMacAddress ? { macAddress: source.observedMacAddress } : {}),
    ...(source.hostname ? { hostname: source.hostname.slice(0, 253) } : {}),
    status: openPorts.length ? 'online' : 'unknown',
    observedAt,
    ...(options.interfaceName ? { interfaceName: options.interfaceName } : {}),
    reason: openPorts.length
      ? `Nmap observed ${openPorts.length} open TCP/UDP service port(s).`
      : 'Nmap did not observe an open service; endpoint reachability remains unknown.',
    observations,
  };
}

function nmapObservation(
  options: NmapParseOptions,
  observedAt: string,
  attribute: string,
  value: string | boolean,
): NonNullable<NetworkDiscoveredDevice['observations']>[number] {
  return {
    source: 'tcp',
    attribute,
    value,
    observedAt,
    scopeId: options.scopeId,
    method: 'nmap_tcp_connect_service_scan',
    ...(options.interfaceName ? { interfaceName: options.interfaceName } : {}),
  };
}

function targetsForScope(
  scope: NetworkDiscoveryZone,
  maxHosts: number,
): { targets: string[]; failure?: string } {
  if (scope.cidr) {
    const parsed = parseCidr(scope.cidr);
    if (!parsed) return { targets: [], failure: 'Network scope is not a valid IPv4 CIDR.' };
    const { network, prefix } = parsed;
    const size = 2 ** (32 - prefix);
    const first = prefix <= 30 ? network + 1 : network;
    const last = prefix <= 30 ? network + size - 2 : network + size - 1;
    const count = last - first + 1;
    if (count <= 0) return { targets: [], failure: 'Network scope has no usable IPv4 addresses.' };
    if (count > maxHosts) return { targets: [], failure: `Network scope exceeds the ${maxHosts}-host Nmap limit; select a narrower scope.` };
    return { targets: Array.from({ length: count }, (_, index) => ipv4FromNumber(first + index)) };
  }
  const targets = [...new Set(scope.seedIps.filter(isIpv4))].sort(compareIpv4);
  if (!targets.length) return { targets: [], failure: 'Scope has no valid IPv4 CIDR or seed address.' };
  if (targets.length > maxHosts) return { targets: [], failure: `Seed list exceeds the ${maxHosts}-host Nmap limit.` };
  return { targets };
}

function localInterfaceForScope(
  scope: NetworkDiscoveryZone,
  interfaces: LocalInterface,
): { name: string } | undefined {
  const targets = targetsForScope(scope, MAX_HOSTS).targets;
  if (!targets.length) return undefined;
  const match = Object.entries(interfaces).find(([name, addresses]) =>
    (!scope.interfaceName || scope.interfaceName === name) &&
    !!addresses?.some(address => address.family === 'IPv4' && !address.internal &&
      targets.some(target => isIpv4InCidr(target, address.cidr || cidrFromNetmask(address.address, address.netmask)))),
  );
  return match ? { name: match[0] } : undefined;
}

async function defaultRouteInterface(target: string): Promise<RouteInterfaceEvidence> {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'route' : platform === 'linux' ? 'ip' : undefined;
  if (!command) return {};
  const args = platform === 'darwin' ? ['-n', 'get', target] : ['-j', 'route', 'get', target];
  try {
    const result = await defaultRunner(command, args, { timeout: 2_000, maxBuffer: 16 * 1024 });
    const interfaceName = platform === 'darwin'
      ? /^\s*interface:\s*(\S+)/m.exec(result.stdout)?.[1]
      : (JSON.parse(result.stdout) as Array<{ dev?: string }>)[0]?.dev;
    return interfaceName && /^[a-zA-Z0-9_.:-]{1,32}$/.test(interfaceName) ? { interfaceName } : {};
  } catch {
    return {};
  }
}

function createNmapArguments(targets: readonly string[], interfaceName?: string): string[] {
  if (!targets.length || targets.length > MAX_HOSTS || new Set(targets).size !== targets.length || targets.some(target => !isIpv4(target))) {
    throw new Error(`Nmap requires between 1 and ${MAX_HOSTS} unique validated IPv4 targets.`);
  }
  if (interfaceName && !/^[a-zA-Z0-9_.:-]{1,32}$/.test(interfaceName)) throw new Error('Nmap interface name is invalid.');
  return [
    '-oX', '-', '-n', '-Pn', '-sT', '-sV', '--version-light',
    '-p', NMAP_TCP_PORTS.join(','), '--max-parallelism', '16',
    '--max-retries', '1', '--host-timeout', '20s', '--max-rate', '100',
    ...(interfaceName ? ['-e', interfaceName] : []),
    ...targets,
  ];
}

function ipInScope(ip: string, cidr?: string, targets?: ReadonlySet<string>): boolean {
  if (targets) return targets.has(ip);
  return cidr ? isIpv4InCidr(ip, cidr) : true;
}

function isIpv4InCidr(ip: string, cidr?: string): boolean {
  if (!cidr) return false;
  const [interfaceIp, prefixText, extra] = cidr.split('/');
  const number = ipv4Number(ip);
  const interfaceNumber = ipv4Number(interfaceIp || '');
  const prefix = Number(prefixText);
  if (extra !== undefined || number === null || interfaceNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((number & mask) >>> 0) === ((interfaceNumber & mask) >>> 0);
}

function cidrFromNetmask(ip: string, netmask: string): string | undefined {
  const address = ipv4Number(ip);
  const mask = ipv4Number(netmask);
  if (address === null || mask === null) return undefined;
  const prefix = mask.toString(2).split('1').length - 1;
  if (mask !== (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)) return undefined;
  return `${ipv4FromNumber((address & mask) >>> 0)}/${prefix}`;
}

function parseCidr(cidr: string): { network: number; prefix: number } | null {
  const [ip, prefixText, extra] = cidr.split('/');
  const network = ipv4Number(ip || '');
  const prefix = Number(prefixText);
  if (extra !== undefined || network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if (((network & mask) >>> 0) !== network) return null;
  return { network, prefix };
}

function isIpv4(ip: string | undefined): ip is string {
  return typeof ip === 'string' && ipv4Number(ip) !== null;
}

function ipv4Number(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some(part => part < 0 || part > 255)) return null;
  return octets.reduce((total, part) => ((total << 8) | part) >>> 0, 0);
}

function ipv4FromNumber(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function compareIpv4(left: string, right: string): number {
  return (ipv4Number(left) || 0) - (ipv4Number(right) || 0);
}

function validUnicastMac(value: string | undefined): value is string {
  if (!value || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) return false;
  const octets = value.split(':').map(part => parseInt(part, 16));
  return !(octets[0] & 1) && octets.some(octet => octet !== 0);
}

function normalizeMac(value: string): string {
  return value.toLowerCase();
}

function timestampFromEpoch(value: string | undefined): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value!)) : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|cancelled/i.test(error.message));
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timed out|timeout/i.test(error.message) || ('killed' in error && Boolean(error.killed));
}
