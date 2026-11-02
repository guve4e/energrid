import type { RegisteredDevice } from '../devices/device-registry.types';
import type { NetworkDiscoverySnapshot } from '../devices/network-discovery-snapshot';
import type { AuthorizedSiteLocalObserver } from '../devices/site-local-shelly-evidence-intake';
import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository';
import { projectShellyEndpointRecoveryProposals } from './shelly-endpoint-recovery-projection';

const owner = { tenantId: 'tenant-home', siteId: 'site-home' };
const physicalId = 'shellyplus1-8813bfcdc8bc';
const deviceId = `${physicalId}:switch:0`;
const inventoryId = 'physical-bathroom';
const observedAt = '2026-11-02T12:49:14.000Z';
const componentAt = '2026-11-02T12:49:15.000Z';

function snapshot(overrides: Partial<NetworkDiscoverySnapshot> = {}): NetworkDiscoverySnapshot {
  return {
    schemaVersion: 2, scanId: 'scan-home-001', ownership: owner, startedAt: observedAt, completedAt: componentAt,
    collector: { id: 'mac-eero-en0', host: 'mac-api', interfaces: ['en0'] }, scopes: [
      { id: 'upstream-lan', name: 'Upstream LAN', cidr: '192.168.1.0/24', complete: true, gatewayIpsObserved: [] },
    ], methods: ['http_rpc'], successes: 1, failures: [], limitations: [], rawEvidenceOmitted: 0, rawEvidence: [],
    endpoints: [{ id: physicalId, ipAddress: '192.168.1.219', networkZoneId: 'upstream-lan', networkZoneName: 'Upstream LAN',
      protocol: 'http', vendor: 'Shelly', status: 'online', discoveredAt: componentAt, reason: 'RPC identity', components: [{ component: 'switch:0', channel: 0 }],
      observations: [
        { source: 'http_rpc', attribute: 'shelly.device_id', value: physicalId, observedAt },
        { source: 'http_rpc', attribute: 'shelly.component_status', value: 'switch:0', observedAt: componentAt, scopeId: 'upstream-lan', method: 'Switch.GetStatus?id=0' },
      ],
    }], topology: { relationships: [] }, ...overrides,
  } as NetworkDiscoverySnapshot;
}

function device(overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
  return { id: deviceId, tenantId: owner.tenantId, siteId: owner.siteId, siteName: 'Home', displayName: 'Bathroom Shelly',
    kind: 'physical', zoneId: 'bathroom', zoneName: 'Bathroom', trustStatus: 'approved', capabilities: [],
    adapter: { protocol: 'http', driver: 'shelly-lan', target: '' } as RegisteredDevice['adapter'],
    state: {} as RegisteredDevice['state'], responseProfile: {} as RegisteredDevice['responseProfile'],
    policy: {} as RegisteredDevice['policy'], metadata: {}, ...overrides,
  } as RegisteredDevice;
}

function inventory(overrides: Partial<PhysicalDeviceInventoryRecord> = {}): PhysicalDeviceInventoryRecord {
  return { physicalDeviceId: inventoryId, scope: owner,
    identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId }, verificationStatus: 'protocol_observed',
    firstSeenAt: observedAt, lastSeenAt: componentAt, components: [{ key: 'switch:0', capabilities: [], firstSeenAt: observedAt, lastSeenAt: componentAt }],
    endpoints: [], networkObservations: [], assignments: [{ deviceId, physicalDeviceId: inventoryId, componentKey: 'switch:0', assignedAt: observedAt, assignedBy: 'installer' }],
    ...overrides,
  };
}

function observer(overrides: Partial<AuthorizedSiteLocalObserver> = {}): AuthorizedSiteLocalObserver {
  return { id: 'pi-upstream', host: 'pi-upstream', tenantId: owner.tenantId, siteId: owner.siteId,
    scopeId: 'upstream-lan', cidr: '192.168.1.0/24', interfaceName: 'eth0', expectedDeviceIds: [physicalId],
    expectedComponentKeys: ['switch:0'], ...overrides };
}

describe('projectShellyEndpointRecoveryProposals', () => {
  it('projects an exact enrolled stable-identity match but blocks it when no observer is authorized', () => {
    const [proposal] = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner, devices: [device()], inventories: [inventory()], observers: [], now: Date.parse('2026-11-02T12:50:00Z') });
    expect(proposal).toMatchObject({ deviceId, physicalInventoryId: inventoryId, endpoint: '192.168.1.219', scopeId: 'upstream-lan', status: 'observer_required', observerStatus: 'missing', evidenceFresh: true, currentEndpoint: null });
  });

  it('requires a fresh exact site, scope, identity, and component allowlist before marking observer configured', () => {
    const [proposal] = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner, devices: [device()], inventories: [inventory()], observers: [observer()], now: Date.parse('2026-11-02T12:50:00Z') });
    expect(proposal).toMatchObject({ status: 'verification_required', observerStatus: 'authorized', observerId: 'pi-upstream', evidenceFresh: true });
    const unauthorized = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner, devices: [device()], inventories: [inventory()], observers: [observer({ expectedComponentKeys: ['switch:1'] })] });
    expect(unauthorized[0].observerStatus).toBe('missing');
    expect(unauthorized[0].status).toBe('observer_required');
    const invalid = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner, devices: [device()], inventories: [inventory()], observers: null });
    expect(invalid[0]).toMatchObject({ observerStatus: 'invalid', status: 'observer_configuration_invalid' });
  });

  it('does not correlate a wrong-site scan or mismatched protocol identity', () => {
    expect(projectShellyEndpointRecoveryProposals({ snapshot: snapshot({ ownership: { tenantId: 'other', siteId: owner.siteId } }), owner, devices: [device()], inventories: [inventory()], observers: [] })).toEqual([]);
    const wrongIdentity = snapshot({ endpoints: snapshot().endpoints.map(endpoint => ({ ...endpoint,
      observations: endpoint.observations?.map(item => item.attribute === 'shelly.device_id' ? { ...item, value: 'shellyplus1-000000000001' } : item),
    })) });
    expect(projectShellyEndpointRecoveryProposals({ snapshot: wrongIdentity, owner, devices: [device()], inventories: [inventory()], observers: [] })).toEqual([]);
  });

  it('surfaces duplicate endpoint observations as a conflict and never selects the newer address', () => {
    const original = snapshot().endpoints[0];
    const duplicate = { ...original, ipAddress: '192.168.1.220' };
    const proposals = projectShellyEndpointRecoveryProposals({ snapshot: snapshot({ endpoints: [original, duplicate] }), owner,
      devices: [device()], inventories: [inventory()], observers: [observer()], now: Date.parse('2026-11-02T12:50:00Z') });
    expect(proposals).toHaveLength(2);
    expect(proposals.map(item => item.status)).toEqual(['conflict', 'conflict']);
    expect(proposals.map(item => item.endpoint)).toEqual(['192.168.1.219', '192.168.1.220']);
  });

  it('surfaces a different current Physical Inventory endpoint without choosing between it and the scan match', () => {
    const [proposal] = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner, devices: [device()],
      inventories: [inventory({ networkObservations: [{ id: 'old-route', physicalDeviceId: inventoryId, ipAddress: '192.168.1.88',
        networkScope: 'upstream-lan:192.168.1.0/24', observedAt, evidenceSource: 'prior-observation',
        verificationStatus: 'protocol_observed', associatedAt: observedAt, associatedBy: 'operator', isCurrent: true }] })],
      observers: [observer()] });
    expect(proposal.status).toBe('conflict');
    expect(proposal.conflictEndpoints).toEqual(['upstream-lan:192.168.1.219', 'upstream-lan:192.168.1.88']);
  });

  it('keeps stale scan evidence as a proposal but marks it stale and does not bypass inventory conflicts', () => {
    const [proposal] = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner, devices: [device()], inventories: [inventory()], observers: [observer()], now: Date.parse('2026-11-02T13:10:00Z') });
    expect(proposal.evidenceFresh).toBe(false);
    expect(proposal.status).toBe('verification_required');
    const [conflict] = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner, devices: [device()], inventories: [inventory({ assignments: [] })], observers: [observer()] });
    expect(conflict.status).toBe('inventory_conflict');
    const [unavailable] = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner, devices: [device()], inventories: [], inventoryAvailable: false, observers: [observer()] });
    expect(unavailable.status).toBe('inventory_unavailable');
  });

  it('marks an already matching installed route without changing it', () => {
    const [proposal] = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner,
      devices: [device({ metadata: { ipAddress: '192.168.1.219', networkScope: 'pi-upstream:upstream-lan:192.168.1.0/24' } })],
      inventories: [inventory()], observers: [observer()] });
    expect(proposal.status).toBe('already_current');
    const [scopeMismatch] = projectShellyEndpointRecoveryProposals({ snapshot: snapshot(), owner,
      devices: [device({ metadata: { ipAddress: '192.168.1.219', networkScope: 'upstream-lan:192.168.2.0/24' } })],
      inventories: [inventory()], observers: [observer()] });
    expect(scopeMismatch.status).toBe('verification_required');
  });
});
