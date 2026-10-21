import {
  inferConfiguredIpv4Scopes,
  LocalNetworkRuntimeAdapter,
  normalizeInterfaces,
  parseLinuxIpRoutes,
  parseMacNetstatRoutes,
} from './local-network-runtime.adapter';
import type { NetworkDiscoveryZone } from '../../../device-registry.types';

const interfaceTable = {
  eth0: [{ address: '10.42.6.35', netmask: '255.255.255.192', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '10.42.6.35/26' }],
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
} as ReturnType<typeof import('node:os').networkInterfaces>;

describe('LocalNetworkRuntimeAdapter', () => {
  it('normalizes interface masks into the actual connected subnet without assuming /24', () => {
    const interfaces = normalizeInterfaces(interfaceTable);
    expect(interfaces).toContainEqual(expect.objectContaining({
      name: 'eth0',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      addresses: [expect.objectContaining({ address: '10.42.6.35', netmask: '255.255.255.192', prefixLength: 26 })],
    }));
    expect(inferConfiguredIpv4Scopes(interfaceTable)).toEqual([expect.objectContaining({
      id: 'eth0-10-42-6-0-26', cidr: '10.42.6.0/26', interfaceName: 'eth0',
    })]);
  });

  it('does not make oversized interface networks scan scopes by default', () => {
    const broad = { eth0: [{ ...interfaceTable.eth0[0], address: '10.1.2.3', netmask: '255.255.0.0', cidr: '10.1.2.3/16' }] } as typeof interfaceTable;
    expect(inferConfiguredIpv4Scopes(broad)).toEqual([]);
  });

  it('does not assume local networks use RFC1918 addresses', () => {
    const assigned = { en0: [{ ...interfaceTable.eth0[0], address: '198.51.100.3', netmask: '255.255.255.248', cidr: '198.51.100.3/29' }] } as typeof interfaceTable;
    expect(inferConfiguredIpv4Scopes(assigned)).toEqual([expect.objectContaining({ cidr: '198.51.100.0/29', interfaceName: 'en0' })]);
  });

  it('normalizes Linux route JSON and distinguishes directly connected and routed configured scopes', async () => {
    const parsed = parseLinuxIpRoutes(JSON.stringify([
      { dst: 'default', gateway: '10.42.6.1', dev: 'eth0', prefsrc: '10.42.6.35' },
      { dst: '10.42.6.0/26', dev: 'eth0', prefsrc: '10.42.6.35' },
    ]));
    expect(parsed).toEqual([
      expect.objectContaining({ destination: '0.0.0.0/0', gateway: '10.42.6.1', interfaceName: 'eth0', evidence: 'ip_route_table' }),
      expect.objectContaining({ destination: '10.42.6.0/26', interfaceName: 'eth0' }),
    ]);
    const zones: NetworkDiscoveryZone[] = [
      { id: 'local', name: 'Local', cidr: '10.42.6.0/26', seedIps: [] },
      { id: 'remote', name: 'Remote', cidr: '10.44.2.0/24', seedIps: [] },
      { id: 'unrouted', name: 'Unrouted', cidr: '192.0.2.0/24', seedIps: [] },
    ];
    const runtime = new LocalNetworkRuntimeAdapter('linux', () => interfaceTable, () => 'observer', async (_command, args) => args.includes('-6') ? '[]' : JSON.stringify([
      { dst: '10.44.0.0/16', gateway: '10.42.6.1', dev: 'eth0', prefsrc: '10.42.6.35' },
      { dst: '10.42.6.0/26', dev: 'eth0', prefsrc: '10.42.6.35' },
    ]), () => new Date('2026-10-21T00:00:00Z'), '/usr/bin');
    const report = await runtime.inspect(zones);
    expect(report.configuredScopes.map(scope => scope.reachability)).toEqual(['on_link', 'routed', 'no_route']);
    expect(report.configuredScopes[1].reason).toContain('not established');
    expect(report.observer).toEqual({ id: 'observer/linux', host: 'observer', platform: 'linux' });
  });

  it('parses macOS route table entries without treating link-layer routes as gateways', () => {
    const routes = parseMacNetstatRoutes([
      'Routing tables',
      'Internet:',
      'Destination        Gateway            Flags        Netif Expire',
      'default            192.168.7.1        UGScg        en0',
      '192.168.7          link#14            UCS          en0',
      '192.168.7.42       link#14            UHRLWI       en0      !',
    ].join('\n'));
    expect(routes).toEqual([
      expect.objectContaining({ destination: '0.0.0.0/0', gateway: '192.168.7.1', interfaceName: 'en0' }),
      expect.objectContaining({ destination: '192.168.7.0/24', interfaceName: 'en0' }),
    ]);
    expect(routes[1].gateway).toBeUndefined();
  });
});
