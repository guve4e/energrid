import { accessSync, constants } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetworkDiscoveryZone } from '../../../device-registry.types';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 2_000;
const IPV4_SCAN_HOST_LIMIT = 254;
const MAX_ROUTE_OBSERVATIONS = 512;

export type NetworkAddressFamily = 'IPv4' | 'IPv6';

export interface NetworkInterfaceObservation {
  name: string;
  internal: boolean;
  macAddress?: string;
  addresses: Array<{
    family: NetworkAddressFamily;
    address: string;
    netmask?: string;
    prefixLength?: number;
    cidr?: string;
  }>;
}

export interface NetworkRouteObservation {
  destination: string;
  family: NetworkAddressFamily;
  gateway?: string;
  interfaceName?: string;
  sourceAddress?: string;
  evidence: string;
}

export interface ConfiguredScopeReachability {
  id: string;
  name: string;
  cidr?: string;
  interfaceName?: string;
  reachability: 'on_link' | 'routed' | 'no_route' | 'unscoped';
  route?: NetworkRouteObservation;
  boundedScanEligible: boolean;
  reason: string;
}

export interface NetworkRuntimeCapability {
  id: string;
  available: boolean;
  detail: string;
}

export interface LocalNetworkRuntimeReport {
  observedAt: string;
  observer: { id: string; host: string; platform: string };
  interfaces: NetworkInterfaceObservation[];
  routes: NetworkRouteObservation[];
  localScopes: Array<{ cidr: string; interfaceName: string }>;
  configuredScopes: ConfiguredScopeReachability[];
  capabilities: NetworkRuntimeCapability[];
  limitations: string[];
}

type NetworkInterfaceTable = ReturnType<typeof networkInterfaces>;
type CommandRunner = (command: string, args: string[]) => Promise<string>;

const runCommand: CommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 256 * 1024 });
  return String(result.stdout || '');
};

export class LocalNetworkRuntimeAdapter {
  constructor(
    private readonly platformName: string = process.platform,
    private readonly readInterfaces: () => NetworkInterfaceTable = networkInterfaces,
    private readonly readHostname: () => string = hostname,
    private readonly run: CommandRunner = runCommand,
    private readonly now: () => Date = () => new Date(),
    private readonly pathValue: string | undefined = process.env.PATH,
  ) {}

  async inspect(configuredScopes: readonly NetworkDiscoveryZone[] = []): Promise<LocalNetworkRuntimeReport> {
    const host = this.readHostname();
    const interfaces = normalizeInterfaces(this.readInterfaces());
    const routesResult = await this.readRoutes();
    const routes = routesResult.routes;
    const localScopes = localIpv4Scopes(interfaces);
    const capabilities = this.capabilities(routesResult.available);
    const ipv6NeighborAvailable = capabilities.some(item => item.id === 'neighbor_table_ipv6' && item.available);
    const mdnsAvailable = capabilities.some(item => item.id === 'mdns' && item.available);
    const scoped = configuredScopes.map(scope => evaluateConfiguredScope(scope, interfaces, routes));
    const limitations = [
      'A route-table entry indicates a path is configured; it does not prove end-to-end endpoint reachability.',
      'Only configured scopes are eligible for operator-approved scans; discovered interface scopes are informational until selected.',
      ...(!routesResult.available ? ['Route-table inspection is unavailable in this runtime; scope reachability is unknown.'] : []),
      ...(routesResult.truncated ? [`Route observations were bounded to ${MAX_ROUTE_OBSERVATIONS} records.`] : []),
      ...(ipv6NeighborAvailable ? ['An IPv6 neighbor tool is available, but IPv6 neighbor entries are not yet normalized into endpoints.'] : []),
      ...(mdnsAvailable ? ['An mDNS tool is available, but mDNS browsing is not yet an active discovery collector.'] : []),
      ...(scoped.some(scope => scope.reachability === 'no_route') ? ['One or more configured scopes have no matching local route.'] : []),
      ...(scoped.some(scope => scope.reachability === 'routed') ? ['Routed scope observations cannot establish remote Layer-2 MAC addresses.'] : []),
    ];
    return {
      observedAt: this.now().toISOString(),
      observer: { id: `${host}/${this.platformName}`, host, platform: this.platformName },
      interfaces,
      routes,
      localScopes,
      configuredScopes: scoped,
      capabilities,
      limitations: [...new Set(limitations)],
    };
  }

  private async readRoutes(): Promise<{ available: boolean; routes: NetworkRouteObservation[]; truncated: boolean }> {
    try {
      if (this.platformName === 'linux') {
        const [ipv4, ipv6] = await Promise.all([
          this.run('ip', ['-4', '-j', 'route', 'show', 'table', 'main']).catch(() => ''),
          this.run('ip', ['-6', '-j', 'route', 'show', 'table', 'main']).catch(() => ''),
        ]);
        const routes = [
          ...parseLinuxIpRoutes(ipv4, 'IPv4'),
          ...parseLinuxIpRoutes(ipv6, 'IPv6'),
        ];
        return boundedRoutes(routes);
      }
      if (this.platformName === 'darwin') {
        const [ipv4, ipv6] = await Promise.all([
          this.run('netstat', ['-rn', '-f', 'inet']).catch(() => ''),
          this.run('netstat', ['-rn', '-f', 'inet6']).catch(() => ''),
        ]);
        const routes = [
          ...parseMacNetstatRoutes(ipv4, 'IPv4'),
          ...parseMacNetstatRoutes(ipv6, 'IPv6'),
        ];
        return boundedRoutes(routes);
      }
      return { available: false, routes: [], truncated: false };
    } catch {
      return { available: false, routes: [], truncated: false };
    }
  }

  private capabilities(routeAvailable: boolean): NetworkRuntimeCapability[] {
    const has = (name: string) => executableOnPath(name, this.pathValue);
    const ipv4NeighborAvailable = this.platformName === 'linux' ? has('ip') : this.platformName === 'darwin' && has('arp');
    const ipv6NeighborAvailable = this.platformName === 'linux' ? has('ip') : this.platformName === 'darwin' && has('ndp');
    const mdnsCommand = this.platformName === 'darwin' ? 'dns-sd' : 'avahi-browse';
    const mdnsAvailable = has(mdnsCommand);
    return [
      { id: 'route_table', available: routeAvailable, detail: routeAvailable ? 'Operating-system route table read successfully.' : 'Route table unavailable.' },
      { id: 'neighbor_table_ipv4', available: ipv4NeighborAvailable, detail: ipv4NeighborAvailable ? 'IPv4 neighbor-table utility detected; observations remain limited to this host and interface.' : 'No supported IPv4 neighbor-table utility detected.' },
      { id: 'neighbor_table_ipv6', available: ipv6NeighborAvailable, detail: ipv6NeighborAvailable ? 'IPv6 neighbor utility detected; its entries are not yet normalized by this collector.' : 'No supported IPv6 neighbor-table utility detected.' },
      { id: 'dns_resolution', available: true, detail: 'Node system resolver is available.' },
      { id: 'mdns', available: mdnsAvailable, detail: mdnsAvailable ? `${mdnsCommand} is available; mDNS browsing is not yet an active collector.` : `No supported mDNS command (${mdnsCommand}) detected.` },
      { id: 'router_client_feed', available: !!(process.env.HOME_ROUTER_CLIENTS_JSON || process.env.HOME_ROUTER_CLIENTS_FILE || process.env.HOME_ROUTER_CLIENTS_COMMAND), detail: 'Configured router/DHCP evidence source.' },
    ];
  }
}

function boundedRoutes(routes: NetworkRouteObservation[]): { available: boolean; routes: NetworkRouteObservation[]; truncated: boolean } {
  return {
    available: routes.length > 0,
    routes: routes.slice(0, MAX_ROUTE_OBSERVATIONS),
    truncated: routes.length > MAX_ROUTE_OBSERVATIONS,
  };
}

export function normalizeInterfaces(table: NetworkInterfaceTable): NetworkInterfaceObservation[] {
  return Object.entries(table).flatMap(([name, records]) => {
    if (!records?.length) return [];
    const addresses = records.map(record => {
      const family: NetworkAddressFamily = record.family === 'IPv6' ? 'IPv6' : 'IPv4';
      const prefixLength = family === 'IPv4' ? prefixLengthFromNetmask(record.netmask) : undefined;
      return {
        family,
        address: record.address,
        ...(record.netmask ? { netmask: record.netmask } : {}),
        ...(prefixLength !== undefined ? { prefixLength } : {}),
        ...(record.cidr ? { cidr: record.cidr } : family === 'IPv4' && prefixLength !== undefined
          ? { cidr: `${networkAddress(record.address, prefixLength)}/${prefixLength}` } : {}),
      };
    });
    return [{
      name,
      internal: records.every(record => record.internal),
      ...(records[0].mac && records[0].mac !== '00:00:00:00:00:00' ? { macAddress: records[0].mac.toLowerCase() } : {}),
      addresses,
    }];
  });
}

export function localIpv4Scopes(interfaces: NetworkInterfaceObservation[]): Array<{ cidr: string; interfaceName: string }> {
  const scopes = new Map<string, { cidr: string; interfaceName: string }>();
  for (const networkInterface of interfaces) {
    if (networkInterface.internal) continue;
    for (const address of networkInterface.addresses) {
      if (address.family !== 'IPv4' || !address.address || address.prefixLength === undefined) continue;
      const cidr = `${networkAddress(address.address, address.prefixLength)}/${address.prefixLength}`;
      scopes.set(`${cidr}:${networkInterface.name}`, { cidr, interfaceName: networkInterface.name });
    }
  }
  return [...scopes.values()].sort((a, b) => a.cidr.localeCompare(b.cidr) || a.interfaceName.localeCompare(b.interfaceName));
}

export function parseLinuxIpRoutes(value: string, family: NetworkAddressFamily = 'IPv4'): NetworkRouteObservation[] {
  try {
    const rows = JSON.parse(value) as Array<{ dst?: string; gateway?: string; dev?: string; prefsrc?: string; src?: string }>;
    return rows.flatMap(row => {
      const destination = family === 'IPv4' ? normalizeIpv4RouteDestination(row.dst) : row.dst || '::/0';
      if (!destination) return [];
      return [{
        destination,
        family,
        ...(row.gateway ? { gateway: row.gateway } : {}),
        ...(row.dev ? { interfaceName: row.dev } : {}),
        ...(row.prefsrc || row.src ? { sourceAddress: row.prefsrc || row.src } : {}),
        evidence: 'ip_route_table',
      }];
    });
  } catch {
    return [];
  }
}

export function parseMacNetstatRoutes(value: string, family: NetworkAddressFamily = 'IPv4'): NetworkRouteObservation[] {
  const routes: NetworkRouteObservation[] = [];
  for (const line of value.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || columns[0] === 'Destination' || columns[0] === 'Routing' || columns[0] === 'Internet:' || columns[0] === 'Internet6:') continue;
    const flags = columns[2] || '';
    if (flags.includes('H') && !flags.includes('G')) continue;
    const destination = family === 'IPv4' ? normalizeMacIpv4Destination(columns[0]) : normalizeMacIpv6Destination(columns[0]);
    if (!destination) continue;
    const gateway = family === 'IPv4' && isIpv4(columns[1]) && !columns[1].startsWith('127.') ? columns[1] : undefined;
    if (isNonNetworkRoute(destination, family, gateway)) continue;
    routes.push({
      destination,
      family,
      ...(gateway ? { gateway } : {}),
      interfaceName: columns[3],
      evidence: 'netstat_route_table',
    });
  }
  return routes;
}

export function inferConfiguredIpv4Scopes(
  interfaces: NetworkInterfaceTable,
  maxHosts = IPV4_SCAN_HOST_LIMIT,
  maxScopes = 4,
): Array<{ id: string; name: string; cidr: string; interfaceName: string; seedIps: string[]; role: 'primary' }> {
  const eligible = localIpv4Scopes(normalizeInterfaces(interfaces))
    .filter(scope => hostCount(scope.cidr) <= maxHosts && hostCount(scope.cidr) > 0)
    .slice(0, maxScopes);
  return eligible.map((scope, index) => ({
    id: safeScopeId(scope.interfaceName, scope.cidr),
    name: `Local network ${index + 1}`,
    cidr: scope.cidr,
    interfaceName: scope.interfaceName,
    seedIps: [],
    role: 'primary',
  }));
}

function evaluateConfiguredScope(
  scope: NetworkDiscoveryZone,
  interfaces: NetworkInterfaceObservation[],
  routes: NetworkRouteObservation[],
): ConfiguredScopeReachability {
  if (!scope.cidr) return { id: scope.id, name: scope.name, reachability: 'unscoped', boundedScanEligible: false, reason: 'No CIDR is configured for this scope.' };
  const local = localIpv4Scopes(interfaces).find(item => item.cidr === scope.cidr);
  const covering = routes.filter(route => route.family === 'IPv4' && routeCoversScope(route.destination, scope.cidr!))
    .sort((a, b) => (prefixOf(b.destination) ?? -1) - (prefixOf(a.destination) ?? -1));
  const route = covering[0];
  const onLink = !!local || (!!route && !route.gateway && interfaces.some(item => !item.internal && item.name === route.interfaceName));
  const reachability: ConfiguredScopeReachability['reachability'] = onLink ? 'on_link' : route ? 'routed' : 'no_route';
  const prefix = prefixOf(scope.cidr);
  const isSupportedIpv4Cidr = isIpv4(scope.cidr.split('/')[0] || '') && prefix !== null && prefix >= 0 && prefix <= 30;
  const eligible = isSupportedIpv4Cidr && hostCount(scope.cidr) <= IPV4_SCAN_HOST_LIMIT;
  const interfaceName = scope.interfaceName || local?.interfaceName || route?.interfaceName;
  return {
    id: scope.id,
    name: scope.name,
    cidr: scope.cidr,
    ...(interfaceName ? { interfaceName } : {}),
    reachability,
    ...(route ? { route } : {}),
    boundedScanEligible: eligible,
    reason: !isSupportedIpv4Cidr ? 'The configured scope is not a valid IPv4 CIDR supported by the current scanner.'
      : !eligible ? `Configured scope exceeds the bounded IPv4 scan size (${IPV4_SCAN_HOST_LIMIT} hosts) or has no usable host addresses.`
      : reachability === 'on_link' ? 'An interface or direct route covers this scope; scan still requires operator confirmation.'
        : reachability === 'routed' ? 'A route-table entry covers this scope; endpoint reachability and remote MAC evidence are not established.'
          : 'No matching route was observed from this runtime.',
  };
}

function executableOnPath(name: string, pathValue?: string): boolean {
  const systemPaths = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const directories = [...new Set([...(pathValue || '').split(':').filter(Boolean), ...systemPaths])];
  return directories.some(directory => {
    try { accessSync(`${directory}/${name}`, constants.X_OK); return true; } catch { return false; }
  });
}

function prefixLengthFromNetmask(value: string): number | undefined {
  if (!isIpv4(value)) return undefined;
  const bits = value.split('.').map(Number).map(octet => octet.toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(bits)) return undefined;
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

function networkAddress(address: string, prefix: number): string {
  const value = ipv4ToNumber(address);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return numberToIpv4((value & mask) >>> 0);
}

function normalizeIpv4RouteDestination(value?: string): string | null {
  if (!value || value === 'default') return '0.0.0.0/0';
  const [address, prefixText] = value.split('/');
  if (!address || !isIpv4(address)) return null;
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return `${address}/${prefix}`;
}

function normalizeMacIpv4Destination(value: string): string | null {
  if (value === 'default') return '0.0.0.0/0';
  const [address, prefixText] = value.split('/');
  if (!address) return null;
  const expanded = address.split('.');
  const shorthandPrefix = expanded.length < 4 ? expanded.length * 8 : 32;
  if (expanded.length < 4 && expanded.every(part => /^\d{1,3}$/.test(part))) {
    while (expanded.length < 4) expanded.push('0');
  }
  const full = expanded.join('.');
  if (!isIpv4(full)) return null;
  const prefix = prefixText ? Number(prefixText) : shorthandPrefix;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return `${full}/${prefix}`;
}

function normalizeMacIpv6Destination(value: string): string | null {
  if (value === 'default') return '::/0';
  return value.includes(':') ? value : null;
}

function isNonNetworkRoute(destination: string, family: NetworkAddressFamily, gateway?: string): boolean {
  if (family === 'IPv4') {
    const address = destination.split('/')[0] || '';
    const prefix = prefixOf(destination);
    return address.startsWith('224.') || address === '255.255.255.255' || (prefix === 32 && !gateway);
  }
  const normalized = destination.toLowerCase();
  return normalized.startsWith('ff') || (prefixOf(destination) === 128 && !gateway);
}

function routeCoversScope(routeCidr: string, scopeCidr: string): boolean {
  const routePrefix = prefixOf(routeCidr);
  const scopePrefix = prefixOf(scopeCidr);
  const routeIp = routeCidr.split('/')[0];
  const scopeIp = scopeCidr.split('/')[0];
  if (routePrefix === null || scopePrefix === null || routePrefix > scopePrefix || !isIpv4(routeIp) || !isIpv4(scopeIp)) return false;
  return networkAddress(routeIp, routePrefix) === networkAddress(scopeIp, routePrefix);
}

function prefixOf(cidr: string): number | null {
  const prefix = Number(cidr.split('/')[1]);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32 ? prefix : null;
}

function hostCount(cidr: string): number {
  const prefix = prefixOf(cidr);
  if (prefix === null || prefix >= 31) return 0;
  return 2 ** (32 - prefix) - 2;
}

function ipv4ToNumber(address: string): number {
  return address.split('.').map(Number).reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
}

function numberToIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function safeScopeId(interfaceName: string, cidr: string): string {
  return `${interfaceName}-${cidr.replaceAll('.', '-').replace('/', '-')}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
