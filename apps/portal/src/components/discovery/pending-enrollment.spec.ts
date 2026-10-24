import { describe, expect, it } from 'vitest';
import { buildPendingEnrollmentCards, type PendingCandidateInput, type PendingIdentityInput } from './pending-enrollment';

const physicalId = 'shellyproem50-8c4f00dbd258';
function candidate(id: string, component: string, name = id): PendingCandidateInput {
  return {
    id, tenantId: 'tenant-a', siteId: 'site-a', displayName: name,
    trustStatus: 'discovered', kind: 'physical',
    capabilities: [{ kind: 'power', actions: ['read'] }],
    adapter: { protocol: 'mqtt', target: `${physicalId}/rpc` },
    discovery: { source: 'mqtt', confidence: 0.8, reason: 'Shelly telemetry' },
    metadata: { physicalId, component },
  };
}
function identity(candidateId: string, componentId: string, extra: Partial<PendingIdentityInput> = {}): PendingIdentityInput {
  return {
    logicalCandidateId: candidateId, physicalDeviceId: 'physical-a', physicalHardwareId: physicalId,
    deviceReportedMacAddress: null, componentId, ipAddress: null, macAddress: null, currentOccupantMacAddress: null, hostname: null, gatewayId: null, networkId: null,
    discoverySource: 'mqtt', protocol: 'mqtt', endpoint: `${physicalId}/rpc`,
    evidenceSource: 'mqtt_protocol_message', lastObservedAt: '2026-10-20T09:00:00.000Z',
    lastObservedIpAddress: null, lastObservedMacAddress: null, lastObservedDeviceReportedMacAddress: null, lastObservedHostname: null,
    lastObservedGatewayId: null, lastObservedNetworkId: null,
    brokerObservedPeerIpAddress: null, brokerObservedAt: null, brokerIdentityVerification: null,
    verificationStatus: 'protocol_observed', status: 'protocol_observed', networkAddressStatus: null, reason: 'Protocol identity recorded.',
    ...extra,
  };
}

describe('Pending Enrollment presentation', () => {
  it('marks an Energrid candidate for explicit room enrollment with separate measurement approval', () => {
    const device: PendingCandidateInput = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'tenant-a', siteId: 'site-a',
      displayName: 'Energrid ESP8266 DHT22', trustStatus: 'discovered', kind: 'physical',
      capabilities: [{ kind: 'temperature', actions: ['read'] }, { kind: 'humidity', actions: ['read'] }],
      adapter: { protocol: 'http', target: 'http://192.168.1.198/api/v1/status' },
      discovery: { source: 'http', confidence: 1, reason: 'Verified firmware identity' },
      metadata: { observationApprovalRequired: true },
    };
    const [card] = buildPendingEnrollmentCards([device], {});
    expect(card.capabilities).toEqual(['temperature', 'humidity']);
    expect(card.details[0].requiresEnrollmentPlacement).toBe(true);
  });

  it('groups Shelly ProEM channels with shared historical network identity', () => {
    const first = candidate(`${physicalId}:em1:0`, 'em1:0', 'Shelly ProEM');
    const second = candidate(`${physicalId}:em1:1`, 'em1:1', 'Shelly ProEM');
    const cards = buildPendingEnrollmentCards([first, second], {
      [first.id]: identity(first.id, 'em1:0', { lastObservedIpAddress: '192.168.1.204', lastObservedMacAddress: '08:f9:e0:e8:49:13', lastObservedNetworkId: 'Upstream LAN' }),
      [second.id]: identity(second.id, 'em1:1', { lastObservedIpAddress: '192.168.1.204', lastObservedMacAddress: '08:f9:e0:e8:49:13', lastObservedNetworkId: 'Upstream LAN' }),
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: 'Shelly ProEM', typeLabel: 'power', networkLabel: 'Last observed',
      networkObservedAt: '2026-10-20T09:00:00.000Z',
      ipAddress: '192.168.1.204', macAddress: '08:f9:e0:e8:49:13',
      network: 'Upstream LAN', networkEvidenceStatus: 'Historical · not recently confirmed',
      components: ['em1:0', 'em1:1'],
    });
    expect(cards[0].details.map(item => item.candidateId)).toEqual([first.id, second.id]);
  });

  it('does not treat the network display name as a second scope for live Shelly channels', () => {
    const first = candidate(`${physicalId}:em1:0`, 'em1:0', 'Shelly ProEM');
    const second = candidate(`${physicalId}:em1:1`, 'em1:1', 'Shelly ProEM');
    const currentIdentity = (id: string, componentId: string) => identity(id, componentId, {
      ipAddress: '192.168.1.204', macAddress: '08:f9:e0:e8:49:13',
      deviceReportedMacAddress: '08:f9:e0:e8:49:10',
      gatewayId: 'gateway-home', networkId: 'upstream-lan', lastObservedNetworkId: 'Upstream LAN',
      status: 'correlated', networkAddressStatus: 'current', lastObservedIpAddress: '192.168.1.204',
      lastObservedMacAddress: '08:f9:e0:e8:49:13', lastObservedDeviceReportedMacAddress: '08:f9:e0:e8:49:10',
    });

    const cards = buildPendingEnrollmentCards([first, second], {
      [first.id]: currentIdentity(first.id, 'em1:0'),
      [second.id]: currentIdentity(second.id, 'em1:1'),
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      ipAddress: '192.168.1.204', macAddress: '08:f9:e0:e8:49:13',
      deviceReportedMacAddress: '08:f9:e0:e8:49:10', network: 'upstream-lan · gateway-home',
      networkLabel: 'Recently confirmed',
      networkObservedAt: '2026-10-20T09:00:00.000Z',
      networkEvidenceStatus: null, unknownNetworkMessage: null, components: ['em1:0', 'em1:1'],
    });
  });

  it('keeps MQTT-only kitchen identity unknown and states why', () => {
    const kitchen: PendingCandidateInput = {
      ...candidate('temp-kitchen', 'temperature', 'Kitchen temperature sensor'),
      adapter: { protocol: 'mqtt', target: 'devices/temp-kitchen/data' },
      metadata: {}, capabilities: [{ kind: 'temperature', actions: ['read'] }, { kind: 'humidity', actions: ['read'] }],
    };
    const cards = buildPendingEnrollmentCards([kitchen], {
      [kitchen.id]: identity(kitchen.id, 'temperature', {
        physicalDeviceId: null, physicalHardwareId: null, componentId: null,
        status: 'not_identified', verificationStatus: 'not_identified',
      }),
    });

    expect(cards[0]).toMatchObject({
      title: 'Kitchen temperature sensor',
      unknownNetworkMessage: 'MQTT source — network address not established',
      networkLabel: 'Not established',
      networkObservedAt: null,
      ipAddress: null,
      capabilities: ['temperature', 'humidity'],
    });
  });

  it('shows broker peer evidence separately without treating it as a verified LAN address', () => {
    const device = candidate(`${physicalId}:em1:0`, 'em1:0');
    const [card] = buildPendingEnrollmentCards([device], {
      [device.id]: identity(device.id, 'em1:0', {
        brokerObservedPeerIpAddress: '192.168.1.1',
        brokerObservedAt: '2026-10-20T09:01:00.000Z',
        brokerIdentityVerification: 'not_plausible',
      }),
    });

    expect(card.ipAddress).toBeNull();
    expect(card.networkLabel).toBe('Not established');
    expect(card.brokerObservedPeerIpAddress).toBe('192.168.1.1');
    expect(card.brokerIdentityVerification).toBe('not_plausible');
  });

  it('labels a historical Shelly IP as reused and keeps protocol and LAN MAC evidence distinct', () => {
    const shelly = candidate(`${physicalId}:em1:0`, 'em1:0', 'Shelly ProEM');
    const cards = buildPendingEnrollmentCards([shelly], {
      [shelly.id]: identity(shelly.id, 'em1:0', {
        lastObservedIpAddress: '192.168.1.133', lastObservedMacAddress: 'ec:62:60:90:d1:97',
        lastObservedDeviceReportedMacAddress: 'ec:62:60:90:d1:94',
        lastObservedNetworkId: 'Upstream LAN', currentOccupantMacAddress: '3c:71:bf:32:54:b7',
        networkAddressStatus: 'reused',
      }),
    });

    expect(cards[0]).toMatchObject({
      ipAddress: '192.168.1.133', macAddress: 'ec:62:60:90:d1:97',
      deviceReportedMacAddress: 'ec:62:60:90:d1:94',
      currentOccupantMacAddress: '3c:71:bf:32:54:b7',
      networkEvidenceStatus: 'Historical · IP now observed with a different MAC',
    });
  });

  it('keeps a partially identified protocol candidate separate until it has an inventory relationship', () => {
    const candidateA = candidate(`${physicalId}:em1:0`, 'em1:0', 'Pro EM channel 0');
    const candidateB = candidate(`${physicalId}:em1:1`, 'em1:1', 'Pro EM channel 1');
    const cards = buildPendingEnrollmentCards([candidateA, candidateB], {
      [candidateA.id]: identity(candidateA.id, 'em1:0', { physicalDeviceId: null, lastObservedIpAddress: null }),
      [candidateB.id]: identity(candidateB.id, 'em1:1', { physicalDeviceId: null, lastObservedIpAddress: null }),
    });

    expect(cards).toHaveLength(2);
    expect(cards[0].unknownNetworkMessage).toBe('MQTT source — network address not established');
    expect(cards.map(card => card.ipAddress)).toEqual([null, null]);
  });

  it('withholds conflicting or partially identified network addresses', () => {
    const a = candidate(`${physicalId}:em1:0`, 'em1:0', 'Shelly ProEM');
    const b = candidate(`${physicalId}:em1:1`, 'em1:1', 'Shelly ProEM');
    const cards = buildPendingEnrollmentCards([a, b], {
      [a.id]: identity(a.id, 'em1:0', { lastObservedIpAddress: '192.168.1.204', lastObservedMacAddress: '08:f9:e0:e8:49:13' }),
      [b.id]: identity(b.id, 'em1:1', { status: 'conflict', lastObservedIpAddress: null, lastObservedMacAddress: null, reason: 'Conflicting MAC evidence.' }),
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      ipAddress: null, macAddress: null,
      unknownNetworkMessage: 'Network identity conflict — address withheld',
    });
  });
});
