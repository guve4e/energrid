import { compareNetworkSnapshots, type NetworkDiscoverySnapshot } from './network-discovery-snapshot';
import type { NetworkDiscoveredDevice } from './device-registry.types';

function endpoint(overrides: Partial<NetworkDiscoveredDevice> = {}): NetworkDiscoveredDevice {
  return {
    id: 'host-1',
    ipAddress: '192.168.7.10',
    networkZoneId: 'eero',
    networkZoneName: 'Eero',
    protocol: 'unknown',
    confidence: 0.5,
    status: 'online',
    discoveredAt: '2026-10-21T10:00:00.000Z',
    reason: 'TCP response',
    ...overrides,
  };
}

function snapshot(scanId: string, devices: NetworkDiscoveredDevice[], complete = true): NetworkDiscoverySnapshot {
  return {
    schemaVersion: 1,
    ownership: { tenantId: 'tenant-demo', siteId: 'site-home' },
    scanId,
    startedAt: '2026-10-21T10:00:00.000Z',
    completedAt: '2026-10-21T10:00:05.000Z',
    collector: { id: 'mac/en0', host: 'mac', interfaces: ['en0'] },
    scopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', complete }],
    methods: ['icmp', 'tcp', 'neighbor_table', 'shelly_rpc'],
    failures: [],
    limitations: [],
    rawEvidenceOmitted: 0,
    rawEvidence: [],
    endpoints: devices,
    topology: { relationships: [] },
  };
}

describe('network discovery snapshot comparison', () => {
  it('detects endpoint additions, non-detection, exact-identity address changes and IP reuse without merging identities', () => {
    const previousShelly = endpoint({
      id: 'shellyplus1-a', vendor: 'Shelly', protocol: 'http', ipAddress: '192.168.7.10',
      macAddress: '00:00:00:00:00:0a', deviceReportedMacAddress: '00:00:00:00:00:0a',
      observations: [
        { source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-21T10:00:00.000Z' },
        { source: 'http_rpc', attribute: 'shelly.device_id', value: 'shellyplus1-a', observedAt: '2026-10-21T10:00:00.000Z' },
      ],
    });
    const currentShelly = endpoint({
      id: 'shellyplus1-a', vendor: 'Shelly', protocol: 'http', ipAddress: '192.168.7.12',
      hostname: 'relay-new-name',
      macAddress: '00:00:00:00:00:0b', deviceReportedMacAddress: '00:00:00:00:00:0a',
      observations: [
        { source: 'tcp', attribute: 'port.443.open', value: true, observedAt: '2026-10-21T11:00:00.000Z' },
        { source: 'http_rpc', attribute: 'shelly.device_id', value: 'shellyplus1-a', observedAt: '2026-10-21T11:00:00.000Z' },
      ],
    });
    const previous = snapshot('scan-1', [
      previousShelly,
      endpoint({ id: 'unknown-old', ipAddress: '192.168.7.11', macAddress: '00:00:00:00:00:11' }),
    ]);
    const current = snapshot('scan-2', [
      { ...currentShelly, discoveredAt: '2026-10-21T11:00:00.000Z' },
      endpoint({ id: 'new-at-reused-ip', ipAddress: '192.168.7.11', macAddress: '00:00:00:00:00:ff', discoveredAt: '2026-10-21T11:00:00.000Z' }),
    ]);

    expect(compareNetworkSnapshots(previous, current)).toMatchObject({
      comparableScopes: ['eero'],
      addedEndpoints: [],
      notDetectedEndpoints: [],
      verifiedAddressChanges: [{ identity: 'shellyplus1-a', from: '192.168.7.10', to: '192.168.7.12' }],
      ipReuse: [{ ipAddress: '192.168.7.11' }],
      macChanges: [{ identity: 'shellyplus1-a', previousObservedMac: '00:00:00:00:00:0a', currentObservedMac: '00:00:00:00:00:0b' }],
      hostnameChanges: [],
      serviceChanges: [{ scopeId: 'eero', ipAddress: '192.168.7.12', added: ['port.443.open=true'], removed: [] }],
    });
  });

  it('does not describe non-detected endpoints when the current scope is incomplete', () => {
    const previous = snapshot('scan-1', [endpoint()]);
    const current = snapshot('scan-2', [], false);

    expect(compareNetworkSnapshots(previous, current).notDetectedEndpoints).toEqual([]);
    expect(compareNetworkSnapshots(previous, current).comparableScopes).toEqual([]);
  });

  it('does not compare endpoints across different coverage grades or collector interfaces', () => {
    const previous = snapshot('scan-1', [endpoint()]);
    const current = {
      ...snapshot('scan-2', []),
      scopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', interfaceName: 'en1', complete: false }],
    };
    expect(compareNetworkSnapshots(previous, current).comparableScopes).toEqual([]);
    expect(compareNetworkSnapshots(previous, current).notDetectedEndpoints).toEqual([]);
  });

  it('compares only matching scope IDs and CIDRs', () => {
    const previous = snapshot('scan-1', [endpoint()]);
    const current = {
      ...snapshot('scan-2', []),
      scopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.9.0/24', complete: true }],
    };

    expect(compareNetworkSnapshots(previous, current).comparableScopes).toEqual([]);
    expect(compareNetworkSnapshots(previous, current).notDetectedEndpoints).toEqual([]);
  });

  it('refuses to correlate or diff snapshots owned by different sites', () => {
    const home = snapshot('home-scan', [endpoint()]);
    const lab = { ...snapshot('lab-scan', []), ownership: { tenantId: 'tenant-demo', siteId: 'site-virtual-lab' } };
    const diff = compareNetworkSnapshots(home, lab);
    expect(diff.comparableScopes).toEqual([]);
    expect(diff.notDetectedEndpoints).toEqual([]);
    expect(diff.addedEndpoints).toEqual([]);
  });

  it('follows a verified device identity across IP changes without reporting a false addition or disappearance', () => {
    const previous = snapshot('scan-1', [endpoint({
      id: 'esp8266:324864', ipAddress: '192.168.7.40', vendor: 'Energrid', protocol: 'http',
      observations: [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: '2026-10-21T10:00:00.000Z' },
        { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt: '2026-10-21T10:00:00.000Z' },
      ],
    })]);
    const current = snapshot('scan-2', [endpoint({
      id: 'ESP8266:324864', ipAddress: '192.168.7.42', vendor: 'Energrid', protocol: 'http',
      observations: [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: '2026-10-21T11:00:00.000Z' },
        { source: 'http_identity', attribute: 'identity.device_id', value: 'ESP8266:324864', observedAt: '2026-10-21T11:00:00.000Z' },
      ],
    })]);

    expect(compareNetworkSnapshots(previous, current)).toMatchObject({
      addedEndpoints: [],
      notDetectedEndpoints: [],
      verifiedAddressChanges: [{ identity: 'esp8266:324864', from: '192.168.7.40', to: '192.168.7.42' }],
    });
  });
});
