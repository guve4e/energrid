import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../devices/device-registry.types';
import { NetworkEndpointIdentityRefresh, type NeighborIdentityObservation } from './network-endpoint-identity-refresh';

describe('NetworkEndpointIdentityRefresh', () => {
  const target: NetworkDiscoveredDevice = {
    id: 'unknown-device', ipAddress: '192.168.7.48', networkZoneId: 'eero', networkZoneName: 'Eero',
    macAddress: '3c:71:bf:32:4b:44', protocol: 'unknown', confidence: 0.5, status: 'unknown',
    discoveredAt: '2026-10-20T10:00:00.000Z', reason: 'Historical snapshot',
  };
  const zones: NetworkDiscoveryZone[] = [
    { id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', seedIps: [] },
    { id: 'house', name: 'HouseNet', cidr: '192.168.1.0/24', seedIps: [] },
  ];
  const currentMac = '3c:71:bf:32:4b:44';
  const now = () => Date.parse('2026-10-21T10:00:00.000Z');
  const observation = (overrides: Partial<NeighborIdentityObservation> = {}): NeighborIdentityObservation => ({
    reachable: true, macAddress: currentMac, interfaceName: 'en0', ...overrides,
  });

  it('refreshes a stale snapshot and verifies identity only when fresh scoped MAC evidence matches', async () => {
    const collect = jest.fn().mockResolvedValue(observation());
    const service = new NetworkEndpointIdentityRefresh(collect, now);

    const result = await service.refresh(target, zones, true);

    expect(result).toMatchObject({ outcome: 'verified', action: 'http_head_root', source: 'direct_arp_reply', method: 'single_target_nmap_arp_ping', historicalMac: currentMac, observedMac: currentMac, scopeId: 'eero', interfaceName: 'en0' });
    expect(result).toHaveProperty('refreshId');
    expect(collect).toHaveBeenCalledWith(target.ipAddress);
  });

  it('reports changed identity and never issues a refresh authorization for a reused address', async () => {
    const service = new NetworkEndpointIdentityRefresh(async () => observation({ macAddress: 'aa:bb:cc:dd:ee:ff' }), now);

    await expect(service.refresh(target, zones, true)).resolves.toMatchObject({ outcome: 'changed', reasonCode: 'identity_changed' });
  });

  it('fails closed when historical or fresh MAC evidence is missing', async () => {
    const noCurrentMac = new NetworkEndpointIdentityRefresh(async () => observation({ macAddress: undefined }), now);
    const noHistoricalMac = new NetworkEndpointIdentityRefresh(async () => observation(), now);

    await expect(noCurrentMac.refresh(target, zones, true)).resolves.toMatchObject({ outcome: 'failed', reasonCode: 'mac_evidence_unavailable' });
    await expect(noHistoricalMac.refresh({ ...target, macAddress: undefined }, zones, true)).resolves.toMatchObject({ outcome: 'failed', reasonCode: 'historical_identity_not_established' });
  });

  it('does no network work when operator approval is denied', async () => {
    const collect = jest.fn();
    const service = new NetworkEndpointIdentityRefresh(collect, now);

    await expect(service.refresh(target, zones, false)).resolves.toMatchObject({ outcome: 'rejected', reasonCode: 'operator_approval_required' });
    expect(collect).not.toHaveBeenCalled();
  });

  it('rejects a mismatched configured scope before refreshing', async () => {
    const collect = jest.fn();
    const service = new NetworkEndpointIdentityRefresh(collect, now);

    await expect(service.refresh({ ...target, networkZoneId: 'house' }, zones, true))
      .resolves.toMatchObject({ outcome: 'rejected', reasonCode: 'network_target_out_of_scope' });
    expect(collect).not.toHaveBeenCalled();
  });

  it('rejects scope network and broadcast addresses instead of treating them as one endpoint', async () => {
    const collect = jest.fn();
    const service = new NetworkEndpointIdentityRefresh(collect, now);

    await expect(service.refresh({ ...target, ipAddress: '192.168.7.255' }, zones, true))
      .resolves.toMatchObject({ outcome: 'rejected', reasonCode: 'network_target_out_of_scope' });
    expect(collect).not.toHaveBeenCalled();
  });

  it('fails closed when the bounded refresh operation fails', async () => {
    const service = new NetworkEndpointIdentityRefresh(async () => { throw new Error('unavailable'); }, now);

    await expect(service.refresh(target, zones, true)).resolves.toMatchObject({ outcome: 'failed', reasonCode: 'identity_refresh_unavailable' });
  });

  it('permits one separate approved HTTP check only for the exact freshly verified endpoint', async () => {
    const service = new NetworkEndpointIdentityRefresh(async () => observation(), now);
    const result = await service.refresh(target, zones, true);
    if (result.outcome !== 'verified' || !result.refreshId) throw new Error('Expected verified refresh fixture');

    expect(service.consumeVerifiedRefresh(result.refreshId, target, zones)).toMatchObject({
      id: target.id, ipAddress: target.ipAddress, macAddress: currentMac, status: 'online',
    });
    expect(service.consumeVerifiedRefresh(result.refreshId, target, zones)).toBeNull();
  });

  it('does not authorize HTTP identity refreshes for another scope or endpoint', async () => {
    const service = new NetworkEndpointIdentityRefresh(async () => observation(), now);
    const result = await service.refresh(target, zones, true);
    if (result.outcome !== 'verified' || !result.refreshId) throw new Error('Expected verified refresh fixture');

    expect(service.consumeVerifiedRefresh(result.refreshId, { ...target, ipAddress: '192.168.1.48' }, zones)).toBeNull();
    expect(service.consumeVerifiedRefresh(result.refreshId, { ...target, networkZoneId: 'house' }, zones)).toBeNull();
  });

  it('atomically consumes an authorization attempt and binds it to the selected endpoint', async () => {
    const service = new NetworkEndpointIdentityRefresh(async () => observation(), now);
    const result = await service.refresh(target, zones, true);
    if (result.outcome !== 'verified' || !result.refreshId) throw new Error('Expected verified refresh fixture');

    expect(service.consumeVerifiedRefresh(result.refreshId, { ...target, id: 'other-endpoint' }, zones)).toBeNull();
    expect(service.consumeVerifiedRefresh(result.refreshId, target, zones)).toBeNull();
  });

  it('expires the one-use HTTP authorization after the existing observation freshness window', async () => {
    let clock = now();
    const service = new NetworkEndpointIdentityRefresh(async () => observation(), () => clock);
    const result = await service.refresh(target, zones, true);
    if (result.outcome !== 'verified' || !result.refreshId) throw new Error('Expected verified refresh fixture');
    clock += 120_001;

    expect(service.consumeVerifiedRefresh(result.refreshId, target, zones)).toBeNull();
  });
});
