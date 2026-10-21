import type { NetworkDiscoverySnapshot } from './network-discovery-snapshot';
import { projectNetworkRoles } from './network-role-evidence';

const baseSnapshot = (overrides: Partial<NetworkDiscoverySnapshot> = {}): NetworkDiscoverySnapshot => ({
  schemaVersion: 2,
  scanId: 'scan-housenet-1',
  startedAt: '2026-10-21T10:00:00.000Z',
  completedAt: '2026-10-21T10:01:00.000Z',
  collector: { id: 'pi/eth0', host: 'energrid-pi', interfaces: ['eth0'] },
  scopes: [{ id: 'housenet', name: 'HouseNet', cidr: '192.168.1.0/24', interfaceName: 'eth0', complete: true, gatewayIpsObserved: [] }],
  methods: ['nmap'], successes: 1, failures: [], limitations: [], rawEvidenceOmitted: 0, rawEvidence: [],
  topology: { relationships: [] },
  runtime: {
    observedAt: '2026-10-21T10:01:00.000Z',
    observer: { id: 'observer/pi', host: 'energrid-pi', platform: 'linux' },
    interfaces: [],
    routes: [{ destination: '0.0.0.0/0', family: 'IPv4', gateway: '192.168.1.1', interfaceName: 'eth0', evidence: 'ip_route_table' }],
    localScopes: [{ cidr: '192.168.1.0/24', interfaceName: 'eth0' }],
    configuredScopes: [{ id: 'housenet', name: 'HouseNet', cidr: '192.168.1.0/24', interfaceName: 'eth0', reachability: 'on_link', boundedScanEligible: true, reason: 'Direct route observed.' }],
    capabilities: [], limitations: [],
  },
  endpoints: [{ id: 'unknown-gateway', ipAddress: '192.168.1.1', networkZoneId: 'housenet', networkZoneName: 'HouseNet', protocol: 'unknown', confidence: 0.5, status: 'online', discoveredAt: '2026-10-21T10:00:30.000Z', reason: 'TCP and ICMP response', observations: [] }],
  ...overrides,
});

describe('projectNetworkRoles', () => {
  it('classifies the HouseNet gateway from Pi default-route evidence with observer and time provenance', () => {
    expect(projectNetworkRoles(baseSnapshot())).toEqual([expect.objectContaining({
      role: 'default_gateway', label: 'Observed default gateway', scopeId: 'housenet', ipAddress: '192.168.1.1',
      observer: { id: 'observer/pi', host: 'energrid-pi', interfaceName: 'eth0' },
      routeDestination: '0.0.0.0/0', routeEvidence: 'ip_route_table', observedAt: '2026-10-21T10:01:00.000Z',
    })]);
  });

  it('classifies the Eero gateway from Mac route evidence without using address numbering', () => {
    const snapshot = baseSnapshot({
      scanId: 'scan-eero-1',
      collector: { id: 'mac/en0', host: 'macbook', interfaces: ['en0'] },
      scopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', interfaceName: 'en0', complete: true, gatewayIpsObserved: [] }],
      runtime: { ...baseSnapshot().runtime!, observedAt: '2026-10-21T11:00:00.000Z', observer: { id: 'observer/mac', host: 'macbook', platform: 'darwin' },
        routes: [{ destination: '0.0.0.0/0', family: 'IPv4', gateway: '192.168.7.1', interfaceName: 'en0', evidence: 'netstat_route_table' }],
        localScopes: [{ cidr: '192.168.7.0/24', interfaceName: 'en0' }],
        configuredScopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', interfaceName: 'en0', reachability: 'on_link', boundedScanEligible: true, reason: 'Direct route.' }] },
      endpoints: [{ id: 'gw', ipAddress: '192.168.7.1', networkZoneId: 'eero', networkZoneName: 'Eero', protocol: 'unknown', confidence: 0.5, status: 'online', discoveredAt: '2026-10-21T10:59:00.000Z', reason: 'Responded during scan' }],
    });
    expect(projectNetworkRoles(snapshot)[0]).toMatchObject({ ipAddress: '192.168.7.1', observer: { host: 'macbook', interfaceName: 'en0' } });
  });

  it('does not infer a gateway from .1 numbering, another scope, or a routed interface mismatch', () => {
    const noRoute = baseSnapshot({ runtime: { ...baseSnapshot().runtime!, routes: [] } });
    const wrongInterface = baseSnapshot({ runtime: { ...baseSnapshot().runtime!, routes: [{ destination: '0.0.0.0/0', family: 'IPv4', gateway: '192.168.1.1', interfaceName: 'wlan9', evidence: 'route' }] } });
    const wrongScope = baseSnapshot({ endpoints: [{ ...baseSnapshot().endpoints[0], networkZoneId: 'other' }] });
    const outsideObservedLink = baseSnapshot({ runtime: { ...baseSnapshot().runtime!, routes: [{ destination: '0.0.0.0/0', family: 'IPv4', gateway: '192.168.2.1', interfaceName: 'eth0', evidence: 'ip_route_table' }] } });
    const futureDated = baseSnapshot({ runtime: { ...baseSnapshot().runtime!, observedAt: '2999-01-01T00:00:00.000Z' } });
    expect(projectNetworkRoles(noRoute)).toEqual([]);
    expect(projectNetworkRoles(wrongInterface)).toEqual([]);
    expect(projectNetworkRoles(wrongScope)).toEqual([]);
    expect(projectNetworkRoles(outsideObservedLink)).toEqual([]);
    expect(projectNetworkRoles(futureDated)).toEqual([]);
  });

  it('keeps historical network role observations address-scoped and does not treat Espressif as identity', () => {
    const snapshot = baseSnapshot({ endpoints: [{ ...baseSnapshot().endpoints[0], ipAddress: '192.168.7.48', networkZoneId: 'eero', macAddress: '3c:71:bf:32:4b:44' }] });
    expect(projectNetworkRoles(snapshot)).toEqual([]);
  });
});
