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
      observations: [{ source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-21T10:00:00.000Z' }],
    });
    const currentShelly = endpoint({
      id: 'shellyplus1-a', vendor: 'Shelly', protocol: 'http', ipAddress: '192.168.7.12',
      macAddress: '00:00:00:00:00:0b', deviceReportedMacAddress: '00:00:00:00:00:0a',
      observations: [{ source: 'tcp', attribute: 'port.443.open', value: true, observedAt: '2026-10-21T11:00:00.000Z' }],
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
      notDetectedEndpoints: [expect.objectContaining({ ipAddress: '192.168.7.10' })],
      verifiedAddressChanges: [{ identity: 'shellyplus1-a', from: '192.168.7.10', to: '192.168.7.12' }],
      ipReuse: [{ ipAddress: '192.168.7.11' }],
      macChanges: [{ identity: 'shellyplus1-a', previousObservedMac: '00:00:00:00:00:0a', currentObservedMac: '00:00:00:00:00:0b' }],
      serviceChanges: [{ scopeId: 'eero', ipAddress: '192.168.7.12', added: ['port.443.open=true'], removed: ['port.80.open=true'] }],
    });
  });

  it('does not describe non-detected endpoints when the current scope is incomplete', () => {
    const previous = snapshot('scan-1', [endpoint()]);
    const current = snapshot('scan-2', [], false);

    expect(compareNetworkSnapshots(previous, current).notDetectedEndpoints).toEqual([]);
    expect(compareNetworkSnapshots(previous, current).incompleteScopes).toEqual(['eero']);
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
});
