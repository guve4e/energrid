import { projectPendingDeviceIdentity } from './pending-device-identity.projection';
import type { RegisteredDevice, NetworkDiscoveredDevice } from '../devices/device-registry.types';
import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository';
import type { KnownNetworkDevice } from '../devices/device-discovery-memory.store';

const shellyId = 'shellyproem50-8c4f00dbd258';
const observedAt = '2026-10-20T12:00:00.000Z';

function candidate(id: string, component: string): RegisteredDevice {
  return {
    id, tenantId: 'tenant-a', siteId: 'site-a', siteName: 'Home',
    displayName: id, kind: 'logical', zoneId: 'unknown', zoneName: 'Unknown',
    trustStatus: 'discovered', capabilities: [],
    adapter: { id: 'mqtt', protocol: 'mqtt', driver: 'shelly-discovered', configured: false, target: `${shellyId}/rpc` },
    state: { values: {}, observedAt, source: 'mqtt', status: 'unknown' },
    responseProfile: { confidence: 0, learningEnabled: false },
    policy: { requiresApproval: true, confirmationRequiredFor: [] },
    discovery: { source: 'mqtt', confidence: 0.8, reason: 'Shelly MQTT telemetry' },
    metadata: { physicalId: shellyId, component, channel: Number(component.split(':')[1]) },
  };
}

function inventory(components = ['em1:0', 'em1:1']): PhysicalDeviceInventoryRecord {
  return {
    physicalDeviceId: 'inventory-physical-1',
    scope: { tenantId: 'tenant-a', siteId: 'site-a' },
    identity: { namespace: 'mqtt:shelly-protocol-id', value: shellyId },
    identityEvidenceSource: 'mqtt_protocol_message',
    identityLastObservedAt: observedAt,
    verificationStatus: 'protocol_observed',
    firstSeenAt: observedAt, lastSeenAt: observedAt,
    components: components.map(key => ({ key, capabilities: ['power'], firstSeenAt: observedAt, lastSeenAt: observedAt })),
    endpoints: [], networkObservations: [], assignments: [],
  };
}

function lan(componentList = ['em1:0', 'em1:1'], extra: Partial<NetworkDiscoveredDevice> = {}): NetworkDiscoveredDevice {
  return {
    id: shellyId, ipAddress: '192.168.1.204', macAddress: '8c:4f:00:db:d2:58',
    hostname: 'shelly-proem', gatewayId: 'gateway-home', networkZoneId: 'iot',
    networkZoneName: 'IoT', protocol: 'http', status: 'online', confidence: 0.9,
    discoveredAt: observedAt, reason: 'Shelly HTTP RPC identity response',
    components: componentList.map((component, index) => ({ component, channel: index })),
    ...extra,
  };
}

describe('pending device identity projection', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T12:00:30.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('correlates Shelly LAN evidence only through exact physical and component identifiers', () => {
    const result = projectPendingDeviceIdentity(candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory()], [lan()]);
    expect(result).toMatchObject({
      logicalCandidateId: `${shellyId}:em1:0`, physicalDeviceId: 'inventory-physical-1',
      physicalHardwareId: shellyId, componentId: 'em1:0', ipAddress: '192.168.1.204',
      macAddress: '8c:4f:00:db:d2:58', hostname: 'shelly-proem', gatewayId: 'gateway-home',
      networkId: 'iot', verificationStatus: 'protocol_observed', status: 'correlated',
      evidenceSource: 'mqtt_protocol_message + lan_http_rpc', lastObservedAt: observedAt,
    });
  });

  it('projects broker peer evidence separately and never treats it as a LAN observation', () => {
    const candidateDevice = candidate(`${shellyId}:em1:0`, 'em1:0');
    const result = projectPendingDeviceIdentity(
      candidateDevice,
      [inventory()],
      [],
      true,
      [],
      () => Date.parse(observedAt),
      [{
        physicalDeviceId: 'inventory-physical-1',
        shellyProtocolId: shellyId,
        brokerId: 'house-broker-pi',
        clientId: 'shelly-mqtt-client',
        peerIp: '192.168.1.1',
        observedAt,
        connectionState: 'connected',
        identityVerification: 'not_plausible',
      }],
    );
    expect(result).toMatchObject({
      brokerObservedPeerIpAddress: '192.168.1.1',
      brokerObservedAt: observedAt,
      brokerIdentityVerification: 'not_plausible',
      ipAddress: null,
      lastObservedIpAddress: null,
      status: 'protocol_observed',
    });
  });

  it('withholds broker peer evidence when the protocol identity has conflicting physical records', () => {
    const duplicate = { ...inventory(), physicalDeviceId: 'inventory-physical-2' };
    const result = projectPendingDeviceIdentity(
      candidate(`${shellyId}:em1:0`, 'em1:0'),
      [inventory(), duplicate],
      [], true, [], () => Date.parse(observedAt),
      [{
        physicalDeviceId: 'inventory-physical-1', shellyProtocolId: shellyId,
        brokerId: 'house-broker-pi', clientId: 'client-1', peerIp: '192.168.1.44',
        observedAt, connectionState: 'connected', identityVerification: 'publisher_observed',
      }],
    );
    expect(result.status).toBe('conflict');
    expect(result.brokerObservedPeerIpAddress).toBeNull();
  });

  it('does not describe an online Shelly observation as current after its freshness window expires', () => {
    const staleAt = '2026-10-20T11:57:00.000Z';
    const staleLan = lan(['em1:0'], { discoveredAt: staleAt });
    const result = projectPendingDeviceIdentity(
      { ...candidate(`${shellyId}:em1:0`, 'em1:0'), state: { values: {}, observedAt: '2026-10-20T12:00:30.000Z', source: 'mqtt', status: 'online' } },
      [inventory(['em1:0'])], [staleLan],
    );

    expect(result).toMatchObject({
      status: 'protocol_observed',
      networkAddressStatus: 'historical',
      ipAddress: null,
      macAddress: null,
      lastObservedAt: staleAt,
      lastObservedIpAddress: '192.168.1.204',
      lastObservedMacAddress: '8c:4f:00:db:d2:58',
      evidenceSource: 'mqtt_protocol_message + expired_lan_scan_observation',
    });
  });

  it('re-evaluates the same cached LAN result against the supplied current time', () => {
    const device = lan(['em1:0'], { discoveredAt: observedAt });
    const projectAt = (nowMs: number) => projectPendingDeviceIdentity(
      candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory(['em1:0'])], [device], true, [], () => nowMs,
    );

    expect(projectAt(Date.parse('2026-10-20T12:01:00.000Z')).networkAddressStatus).toBe('current');
    expect(projectAt(Date.parse('2026-10-20T12:03:00.000Z'))).toMatchObject({
      networkAddressStatus: 'historical', ipAddress: null,
      lastObservedIpAddress: '192.168.1.204', lastObservedAt: observedAt,
    });
  });

  it('does not let an expired address replace newer conflicting evidence at the same scoped IP', () => {
    const shelly = lan(['em1:0'], { discoveredAt: '2026-10-20T11:57:00.000Z' });
    const newerOccupant: NetworkDiscoveredDevice = {
      ...lan([], {
        id: 'aa:bb:cc:dd:ee:ff', macAddress: 'aa:bb:cc:dd:ee:ff',
        discoveredAt: '2026-10-20T11:59:00.000Z',
      }),
      components: undefined,
    };
    const result = projectPendingDeviceIdentity(
      candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory(['em1:0'])], [shelly, newerOccupant],
      true, [], () => Date.parse('2026-10-20T12:00:30.000Z'),
    );

    expect(result).toMatchObject({
      status: 'protocol_observed', networkAddressStatus: 'reused',
      ipAddress: null, lastObservedIpAddress: '192.168.1.204',
      currentOccupantMacAddress: 'aa:bb:cc:dd:ee:ff',
    });
  });

  it.each([
    ['future', '2026-10-20T12:01:00.000Z'],
    ['invalid', 'not-a-timestamp'],
  ])('does not treat a %s observation timestamp as fresh', (_label, discoveredAt) => {
    const result = projectPendingDeviceIdentity(
      candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory(['em1:0'])],
      [lan(['em1:0'], { discoveredAt })], true, [], () => Date.parse('2026-10-20T12:00:30.000Z'),
    );

    expect(result).toMatchObject({
      status: 'protocol_observed', networkAddressStatus: 'historical',
      ipAddress: null, lastObservedIpAddress: '192.168.1.204', lastObservedAt: discoveredAt,
    });
  });

  it('keeps equally addressed evidence in separate network scopes', () => {
    const otherScope = lan(['em1:0'], {
      gatewayId: 'gateway-guest', networkZoneId: 'guest', ipAddress: '192.168.1.204',
      discoveredAt: '2026-10-20T11:59:00.000Z',
    });
    const result = projectPendingDeviceIdentity(
      candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory(['em1:0'])], [otherScope], true, [],
      () => Date.parse('2026-10-20T12:00:30.000Z'),
    );
    expect(result).toMatchObject({ status: 'correlated', networkId: 'guest', ipAddress: '192.168.1.204' });
  });

  it('projects two Shelly channels to the same network observation while retaining their IDs', () => {
    const first = projectPendingDeviceIdentity(candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory()], [lan()]);
    const second = projectPendingDeviceIdentity(candidate(`${shellyId}:em1:1`, 'em1:1'), [inventory()], [lan()]);
    expect([first, second].map(item => [item.logicalCandidateId, item.componentId, item.ipAddress, item.macAddress])).toEqual([
      [`${shellyId}:em1:0`, 'em1:0', '192.168.1.204', '8c:4f:00:db:d2:58'],
      [`${shellyId}:em1:1`, 'em1:1', '192.168.1.204', '8c:4f:00:db:d2:58'],
    ]);
  });

  it('correlates an exact MQTT/RPC hardware ID while preserving both Shelly-reported and LAN MAC evidence', () => {
    const current = lan(['em1:0', 'em1:1'], {
      macAddress: '08:f9:e0:e8:49:13',
      deviceReportedMacAddress: '08:f9:e0:e8:49:10',
    });
    const result = projectPendingDeviceIdentity(
      candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory()], [current],
    );

    expect(result).toMatchObject({
      status: 'correlated',
      ipAddress: '192.168.1.204',
      macAddress: '08:f9:e0:e8:49:13',
      deviceReportedMacAddress: '08:f9:e0:e8:49:10',
      networkAddressStatus: 'current',
    });
  });

  it('shows exact persisted LAN evidence as last observed without claiming it is current', () => {
    const device = lan();
    const history: KnownNetworkDevice[] = [{
      schemaVersion: 1,
      identity: 'shelly:iot:shellyproem50-8c4f00dbd258',
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      lastScanId: observedAt,
      device,
    }];
    const result = projectPendingDeviceIdentity(
      candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory()], [], true, history,
    );

    expect(result).toMatchObject({
      status: 'protocol_observed',
      ipAddress: null,
      macAddress: null,
      lastObservedIpAddress: '192.168.1.204',
      lastObservedMacAddress: '8c:4f:00:db:d2:58',
      lastObservedHostname: 'shelly-proem',
      lastObservedNetworkId: 'IoT',
      reason: expect.stringContaining('historical last-observed network details'),
    });
  });

  it('retains a Shelly DHCP lease as historical when the same scoped IP is now observed with a different MAC', () => {
    const shelly = lan(['switch:0'], {
      id: 'shellypro2pm-ec626090d194',
      ipAddress: '192.168.1.133',
      macAddress: 'ec:62:60:90:d1:97',
      gatewayId: 'gateway-home',
      networkZoneId: 'upstream-lan',
      discoveredAt: '2026-10-19T10:00:00.000Z',
    });
    const history: KnownNetworkDevice[] = [{
      schemaVersion: 1,
      identity: 'mac:upstream-lan:ec:62:60:90:d1:97',
      firstSeenAt: shelly.discoveredAt,
      lastSeenAt: shelly.discoveredAt,
      lastScanId: shelly.discoveredAt,
      device: shelly,
    }];
    const currentEspressif: NetworkDiscoveredDevice = {
      id: '3c:71:bf:32:54:b7',
      ipAddress: '192.168.1.133',
      macAddress: '3c:71:bf:32:54:b7',
      vendor: 'Espressif',
      gatewayId: 'gateway-home',
      networkZoneId: 'upstream-lan',
      networkZoneName: 'Upstream LAN',
      protocol: 'unknown',
      confidence: 0.6,
      status: 'online',
      discoveredAt: '2026-10-20T12:00:00.000Z',
      reason: 'Fresh ARP observation',
    };
    const candidateForShelly: RegisteredDevice = {
      ...candidate('shellypro2pm-ec626090d194:switch:0', 'switch:0'),
      metadata: { physicalId: 'shellypro2pm-ec626090d194', component: 'switch:0' },
    };
    const physical = inventory(['switch:0']);
    physical.identity = { namespace: 'mqtt:shelly-protocol-id', value: 'shellypro2pm-ec626090d194' };

    const result = projectPendingDeviceIdentity(
      candidateForShelly, [physical], [currentEspressif], true, history,
    );

    expect(result).toMatchObject({
      status: 'protocol_observed',
      networkAddressStatus: 'reused',
      currentOccupantMacAddress: '3c:71:bf:32:54:b7',
      ipAddress: null,
      macAddress: null,
      lastObservedIpAddress: '192.168.1.133',
      lastObservedMacAddress: 'ec:62:60:90:d1:97',
    });
    expect(result.reason).toContain('different MAC');
    expect(result.reason).toContain('3c:71:bf:32:54:b7');
  });

  it('does not treat the same historical IP in a different network scope as DHCP reuse', () => {
    const shelly = lan(['switch:0'], {
      id: 'shellypro2pm-ec626090d194', ipAddress: '192.168.1.133',
      macAddress: 'ec:62:60:90:d1:97', gatewayId: 'gateway-home', networkZoneId: 'upstream-lan',
    });
    const history: KnownNetworkDevice[] = [{
      schemaVersion: 1, identity: 'mac:upstream-lan:ec:62:60:90:d1:97',
      firstSeenAt: observedAt, lastSeenAt: observedAt, lastScanId: observedAt, device: shelly,
    }];
    const physical = inventory(['switch:0']);
    physical.identity = { namespace: 'mqtt:shelly-protocol-id', value: 'shellypro2pm-ec626090d194' };
    const otherScope: NetworkDiscoveredDevice = {
      ...lan(['switch:0'], { id: '3c:71:bf:32:54:b7', ipAddress: '192.168.1.133',
        macAddress: '3c:71:bf:32:54:b7', gatewayId: 'gateway-guest', networkZoneId: 'guest-lan' }),
    };

    const result = projectPendingDeviceIdentity({
      ...candidate('shellypro2pm-ec626090d194:switch:0', 'switch:0'),
      metadata: { physicalId: 'shellypro2pm-ec626090d194', component: 'switch:0' },
    }, [physical], [otherScope], true, history);

    expect(result.networkAddressStatus).toBe('historical');
    expect(result.lastObservedIpAddress).toBe('192.168.1.133');
    expect(result.reason).not.toContain('different MAC');
  });

  it('withholds address projection when an exact Shelly identity is evidenced in multiple network scopes', () => {
    const physical = inventory(['em1:0']);
    const primary = lan(['em1:0'], { discoveredAt: '2026-10-20T12:00:00.000Z' });
    const otherNetwork = lan(['em1:0'], {
      gatewayId: 'gateway-guest', networkZoneId: 'guest-lan', networkZoneName: 'Guest LAN',
      ipAddress: '192.168.20.204', discoveredAt: '2026-10-20T12:00:01.000Z',
    });
    const result = projectPendingDeviceIdentity(
      candidate(`${shellyId}:em1:0`, 'em1:0'), [physical], [primary, otherNetwork],
    );

    expect(result).toMatchObject({ status: 'conflict', ipAddress: null, macAddress: null });
    expect(result.reason).toContain('multiple network scopes');
  });

  it('leaves ESP MQTT status identity unknown when it has only a logical ID and measurements', () => {
    const esp = { ...candidate('temp-kitchen', 'temperature'), metadata: { mqttEvidenceCandidate: true }, adapter: { id: 'mqtt', protocol: 'mqtt' as const, driver: 'legacy-framework-device', configured: false, target: 'devices/temp-kitchen/status' } };
    const unrelatedLan = lan();
    unrelatedLan.id = 'ESP-3254B7';
    const result = projectPendingDeviceIdentity(esp, [inventory()], [unrelatedLan]);
    expect(result).toMatchObject({
      logicalCandidateId: 'temp-kitchen', physicalHardwareId: null,
      ipAddress: null, macAddress: null, status: 'not_identified',
      reason: 'MQTT evidence identifies a logical source but contains no stable hardware identifier; its topic is only a communication address.',
    });
  });

  it('withholds LAN addresses when the exact Shelly ID has conflicting MAC evidence', () => {
    const result = projectPendingDeviceIdentity(candidate(`${shellyId}:em1:0`, 'em1:0'), [inventory()], [lan(['em1:0'], {
      identityConflict: { reason: 'multiple_macs_for_endpoint', macAddresses: ['8c:4f:00:db:d2:58', 'aa:bb:cc:dd:ee:ff'] },
    })]);
    expect(result).toMatchObject({ status: 'conflict', ipAddress: null, macAddress: null });
    expect(result.reason).toContain('conflicting MAC');
  });
});
