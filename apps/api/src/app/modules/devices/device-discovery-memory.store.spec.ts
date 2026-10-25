import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dedupeNetworkEndpoints,
  DeviceDiscoveryMemoryStore,
  networkDiscoveryIdentity,
} from './device-discovery-memory.store';
import type {
  NetworkDiscoveredDevice,
} from './device-registry.types';
import type { NetworkDiscoverySnapshot } from './network-discovery-snapshot';
import { isNetworkObservationFresh } from './network-observation-freshness';

const TEST_OWNER = { tenantId: 'tenant-test', siteId: 'site-test' };

function device(
  ipAddress: string,
  macAddress: string,
): NetworkDiscoveredDevice {
  return {
    id: `device-${ipAddress}`,
    ipAddress,
    macAddress,
    networkZoneId: 'local-lan',
    networkZoneName: 'Local LAN',
    protocol: 'unknown',
    confidence: 0.5,
    status: 'unknown',
    discoveredAt: '2026-10-18T10:00:00.000Z',
    reason: 'Test observation',
  };
}

function verifiedEnergridDevice(
  ipAddress: string,
  observedAt: string,
  scope = 'upstream-lan',
  physicalId = 'esp8266:324864',
): NetworkDiscoveredDevice {
  return {
    id: physicalId, ipAddress, networkZoneId: scope, networkZoneName: 'Upstream LAN',
    vendor: 'Energrid', model: 'Energrid ESP8266 DHT22', firmwareVersion: '0.2.0', protocol: 'http',
    confidence: 0.95, status: 'online', discoveredAt: observedAt, reason: 'Verified firmware identity.',
    observations: [
      { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: scope, method: 'GET /api/v1/identity' },
      { source: 'http_identity', attribute: 'identity.device_id', value: physicalId, observedAt, scopeId: scope, method: 'GET /api/v1/identity' },
    ],
  }
}

describe('DeviceDiscoveryMemoryStore', () => {
  let directory: string;
  let store: DeviceDiscoveryMemoryStore;

  function recordScan(scanId: string, devices: NetworkDiscoveredDevice[], owner = TEST_OWNER) {
    return store.recordScan(scanId, devices, owner);
  }

  function recordIdentityObservation(observedAt: string, device: NetworkDiscoveredDevice, owner = TEST_OWNER) {
    return store.recordIdentityObservation(observedAt, device, owner);
  }

  function recordSnapshot(snapshot: NetworkDiscoverySnapshot) {
    return store.recordSnapshot({ ...snapshot, ownership: snapshot.ownership || TEST_OWNER });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'energrid-discovery-'));
    store = new DeviceDiscoveryMemoryStore(directory);
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });


  it('persists installer network notes across restarts and isolates installations', async () => {
    const notes = 'ASUS is the main router. Eero connects behind it.';

    expect(await store.getNetworkInstallerNotes('tenant-a', 'site-a')).toBeNull();

    const saved = await store.saveNetworkInstallerNotes(
      'tenant-a',
      'site-a',
      notes,
    );

    expect(saved).toMatchObject({
      schemaVersion: 1,
      source: 'installer',
      text: notes,
    });
    expect(Number.isNaN(Date.parse(saved.updatedAt))).toBe(false);

    expect(await store.getNetworkInstallerNotes('tenant-a', 'site-b')).toBeNull();
    expect(await store.getNetworkInstallerNotes('tenant-b', 'site-a')).toBeNull();

    await store.onModuleDestroy();
    store = new DeviceDiscoveryMemoryStore(directory);

    expect(await store.getNetworkInstallerNotes('tenant-a', 'site-a'))
      .toEqual(saved);

    const updated = await store.saveNetworkInstallerNotes(
      'tenant-a',
      'site-a',
      'Eero is operating in router mode.',
    );

    expect(updated.text).toBe('Eero is operating in router mode.');
    expect(await store.getNetworkInstallerNotes('tenant-a', 'site-a'))
      .toEqual(updated);
  });

  it('persists devices across store restarts', async () => {
    const timestamp = '2026-10-18T10:00:00.000Z';

    await recordScan(timestamp, [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
    ]);

    await store.onModuleDestroy();

    store = new DeviceDiscoveryMemoryStore(directory);

    const records = await store.list(TEST_OWNER);

    expect(records).toHaveLength(1);
    expect(records[0].firstSeenAt).toBe(timestamp);
    expect(records[0].lastSeenAt).toBe(timestamp);
  });

  it('stores uppercase and lowercase Energrid firmware IDs under one lowercase physical identity', async () => {
    const observedAt = '2026-10-24T12:00:00.000Z';
    const lowercase = verifiedEnergridDevice('192.168.1.129', observedAt, 'upstream-lan', 'esp8266:324b44');
    const uppercase: NetworkDiscoveredDevice = {
      ...lowercase,
      id: 'esp8266:324B44',
      observations: lowercase.observations?.map(observation =>
        observation.attribute === 'identity.device_id'
          ? { ...observation, value: 'esp8266:324B44' }
          : observation,
      ),
    };

    expect(networkDiscoveryIdentity(uppercase)).toBe(networkDiscoveryIdentity(lowercase));
    await recordScan(observedAt, [lowercase, uppercase]);
    const records = await store.listIdentityEvidence(TEST_OWNER);

    expect(records).toHaveLength(1);
    expect(records[0].identity).toBe('device:upstream-lan:esp8266:324b44');
  });

  it('persists a re-verified Energrid identity and provenance across store restarts', async () => {
    const initialAt = '2026-10-23T12:00:00.000Z';
    const refreshedAt = '2026-10-23T12:10:00.000Z';
    const initial = verifiedEnergridDevice('192.168.1.198', initialAt);
    await recordIdentityObservation(initialAt, initial);
    await recordIdentityObservation(refreshedAt, {
      ...initial,
      discoveredAt: refreshedAt,
      reason: 'Re-verified by the bounded HTTP poller.',
      observations: [
        ...(initial.observations || []),
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: refreshedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
        { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt: refreshedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
      ],
    });

    await store.onModuleDestroy();
    store = new DeviceDiscoveryMemoryStore(directory);

    const record = (await store.listIdentityEvidence(TEST_OWNER)).find(item => item.identity === 'device:upstream-lan:esp8266:324864');
    expect(record).toMatchObject({
      lastSeenAt: refreshedAt,
      lastScanId: `identity:${refreshedAt}`,
      device: {
        id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan',
        observations: expect.arrayContaining([
          expect.objectContaining({ source: 'http_identity', attribute: 'identity.verified', value: true, scopeId: 'upstream-lan', method: 'GET /api/v1/identity', observedAt: refreshedAt }),
          expect.objectContaining({ source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', scopeId: 'upstream-lan', method: 'GET /api/v1/identity', observedAt: refreshedAt }),
        ]),
      },
    });
  });

  it('stores immutable scan snapshots across store restarts and rejects replacing an existing scan ID', async () => {
    const snapshot: NetworkDiscoverySnapshot = {
      schemaVersion: 1, ownership: TEST_OWNER, scanId: 'scan-immutable-1', startedAt: '2026-10-18T10:00:00.000Z',
      completedAt: '2026-10-18T10:00:05.000Z', collector: { id: 'mac/en0', host: 'mac', interfaces: ['en0'] },
      scopes: [{ id: 'home', name: 'Home', cidr: '192.168.7.0/24', complete: true, gatewayIpsObserved: [] }],
      methods: ['icmp', 'tcp'], successes: 1, failures: [], limitations: [], rawEvidenceOmitted: 0,
      rawEvidence: [{ observedAt: '2026-10-18T10:00:01.000Z', source: 'neighbor_table', scopeId: 'home', evidence: { ipAddress: '192.168.7.21' } }],
      endpoints: [device('192.168.7.21', '78:ee:4c:cf:42:68')], topology: { relationships: [] },
    }
    await recordSnapshot(snapshot)
    await expect(recordSnapshot({ ...snapshot, completedAt: '2026-10-18T10:01:00.000Z' }))
      .rejects.toThrow('Discovery snapshot already exists')
    await store.onModuleDestroy()
    store = new DeviceDiscoveryMemoryStore(directory)
    expect(await store.getSnapshot(snapshot.scanId, TEST_OWNER)).toEqual(snapshot)
    expect(await store.listSnapshots(TEST_OWNER)).toEqual([snapshot])
  })

  it('preserves version 2 runtime observer evidence across a store restart', async () => {
    const snapshot: NetworkDiscoverySnapshot = {
      schemaVersion: 2, ownership: TEST_OWNER, scanId: 'scan-runtime-2', startedAt: '2026-10-21T10:00:00.000Z',
      completedAt: '2026-10-21T10:00:05.000Z', collector: { id: 'observer/linux', host: 'observer', interfaces: ['eth0'] },
      scopes: [{ id: 'eth0-network', name: 'Local network', cidr: '10.42.6.0/26', interfaceName: 'eth0', complete: false, gatewayIpsObserved: [] }],
      methods: ['neighbor_table'], successes: 0, failures: [], limitations: [], rawEvidenceOmitted: 0,
      rawEvidence: [], endpoints: [], topology: { relationships: [] },
      runtime: {
        observedAt: '2026-10-21T10:00:00.000Z', observer: { id: 'observer/linux', host: 'observer', platform: 'linux' },
        interfaces: [{ name: 'eth0', internal: false, addresses: [{ family: 'IPv4', address: '10.42.6.10', netmask: '255.255.255.192', prefixLength: 26, cidr: '10.42.6.0/26' }] }],
        routes: [{ destination: '10.42.6.0/26', family: 'IPv4', interfaceName: 'eth0', evidence: 'ip_route_table' }],
        localScopes: [{ cidr: '10.42.6.0/26', interfaceName: 'eth0' }],
        configuredScopes: [{ id: 'eth0-network', name: 'Local network', cidr: '10.42.6.0/26', interfaceName: 'eth0', reachability: 'on_link', boundedScanEligible: true, reason: 'Direct route observed.' }],
        capabilities: [{ id: 'route_table', available: true, detail: 'Route table read.' }], limitations: [],
      },
    }
    await recordSnapshot(snapshot)
    await store.onModuleDestroy()
    store = new DeviceDiscoveryMemoryStore(directory)
    expect(await store.getSnapshot(snapshot.scanId, TEST_OWNER)).toEqual(snapshot)
  })

  it('isolates snapshots and candidate evidence by explicit tenant/site owner', async () => {
    const home = { tenantId: 'tenant-demo', siteId: 'site-home' };
    const lab = { tenantId: 'tenant-demo', siteId: 'site-virtual-lab' };
    const observed = device('172.30.250.10', '02:00:00:00:00:10');
    const snapshot: NetworkDiscoverySnapshot = {
      schemaVersion: 2, ownership: home, scanId: 'home-scan',
      startedAt: '2026-10-24T10:00:00.000Z', completedAt: '2026-10-24T10:00:05.000Z',
      collector: { id: 'mac/en0', host: 'mac', interfaces: ['en0'] },
      scopes: [{ id: 'device-lab-vlan', name: 'Virtual Lab', cidr: '172.30.250.0/28', complete: true, gatewayIpsObserved: [] }],
      methods: ['virtual_lab'], successes: 1, failures: [], limitations: [], rawEvidenceOmitted: 0,
      rawEvidence: [], endpoints: [observed], topology: { relationships: [] },
    };
    await recordScan(snapshot.completedAt, [observed], home);
    await recordSnapshot(snapshot);

    expect(await store.listIdentityEvidence(home)).toHaveLength(1);
    expect(await store.listIdentityEvidence(lab)).toEqual([]);
    expect(await store.getSnapshot(snapshot.scanId, home)).toMatchObject({ ownership: home });
    expect(await store.getSnapshot(snapshot.scanId, lab)).toBeNull();
    expect(await store.listSnapshots(lab)).toEqual([]);
    expect(await store.listSnapshots(home)).toEqual([snapshot]);
  });

  it('keeps ownership unchanged when the active site context changes and after recovery', async () => {
    const home = { tenantId: 'tenant-demo', siteId: 'site-home' };
    const lab = { tenantId: 'tenant-demo', siteId: 'site-virtual-lab' };
    const timestamp = '2026-10-24T11:00:00.000Z';
    const observed = device('172.30.250.11', '02:00:00:00:00:11');
    await recordScan(timestamp, [observed], lab);
    const snapshot: NetworkDiscoverySnapshot = {
      schemaVersion: 2, ownership: lab, scanId: 'lab-scan', startedAt: timestamp,
      completedAt: timestamp, collector: { id: 'observer', host: 'lab', interfaces: ['eth0'] },
      scopes: [{ id: 'device-lab-vlan', name: 'Virtual Lab', cidr: '172.30.250.0/28', complete: true, gatewayIpsObserved: [] }],
      methods: ['virtual_lab'], successes: 1, failures: [], limitations: [], rawEvidenceOmitted: 0,
      rawEvidence: [], endpoints: [observed], topology: { relationships: [] },
    };
    await recordSnapshot(snapshot);

    await store.onModuleDestroy();
    store = new DeviceDiscoveryMemoryStore(directory);

    expect(await store.listIdentityEvidence(home)).toEqual([]);
    expect(await store.listIdentityEvidence(lab)).toMatchObject([
      { ownership: lab, device: { ipAddress: observed.ipAddress } },
    ]);
    expect(await store.getSnapshot('lab-scan', home)).toBeNull();
    expect(await store.getSnapshot('lab-scan', lab)).toMatchObject({ ownership: lab });
  });

  it('preserves legacy unscoped snapshot history but excludes it from candidates and scoped comparisons', async () => {
    const legacy: NetworkDiscoverySnapshot = {
      schemaVersion: 2, scanId: 'm3-legacy-scan', startedAt: '2026-10-24T12:00:00.000Z',
      completedAt: '2026-10-24T12:00:05.000Z', collector: { id: 'mac/en0', host: 'mac', interfaces: ['en0'] },
      scopes: [{ id: 'device-lab-vlan', name: 'Virtual Lab', cidr: '172.30.250.0/28', complete: true, gatewayIpsObserved: [] }],
      methods: ['virtual_lab'], successes: 1, failures: [], limitations: [], rawEvidenceOmitted: 0,
      rawEvidence: [], endpoints: [device('172.30.250.10', '02:00:00:00:00:10')], topology: { relationships: [] },
    };
    const legacyDevice = device('172.30.250.10', '02:00:00:00:00:10');
    const legacyRecord = {
      schemaVersion: 1, identity: networkDiscoveryIdentity(legacyDevice),
      firstSeenAt: legacy.completedAt, lastSeenAt: legacy.completedAt,
      lastScanId: legacy.scanId, device: legacyDevice,
    };
    const legacyKey = `known:${encodeURIComponent(legacyRecord.identity)}`;
    const db = (store as unknown as { db: { put(key: string, value: unknown): Promise<void> } }).db;
    await db.put(legacyKey, legacyRecord);
    await db.put(`snapshot:${encodeURIComponent(legacy.scanId)}`, legacy);

    const history = await store.listHistoricalSnapshots(TEST_OWNER);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ scanId: legacy.scanId, ownershipStatus: 'legacy-unscoped' });
    expect(await store.getSnapshot(legacy.scanId, TEST_OWNER)).toBeNull();
    expect(await store.listIdentityEvidence(TEST_OWNER)).toEqual([]);
    expect(await store.list(TEST_OWNER)).toEqual([]);
  });

  it('refuses new discovery records without an explicit owner', async () => {
    await expect(store.recordScan('scan-unowned', [device('192.168.7.9', '02:00:00:00:00:09')], undefined as never))
      .rejects.toThrow('server-authorized tenant/site ownership');
    const unowned = {
      schemaVersion: 2 as const, scanId: 'snapshot-unowned', startedAt: '2026-10-24T12:00:00.000Z',
      completedAt: '2026-10-24T12:00:01.000Z', collector: { id: 'x', host: 'x', interfaces: [] },
      scopes: [], methods: [], successes: 0, failures: [], limitations: [], rawEvidenceOmitted: 0,
      rawEvidence: [], endpoints: [], topology: { relationships: [] },
    };
    await expect(store.recordSnapshot(unowned)).rejects.toThrow('require server-authorized tenant/site ownership');
  });

  it('retains devices absent from a later scan', async () => {
    await recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
      device('192.168.7.30', 'e4:b0:63:74:7c:ac'),
    ]);

    await recordScan('2026-10-18T11:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
    ]);

    expect(await store.summary(TEST_OWNER)).toEqual({
      lastScanId: '2026-10-18T11:00:00.000Z',
      known: 2,
      observedInLatestScan: 1,
      notObservedInLatestScan: 1,
    });

    expect(await store.list(TEST_OWNER)).toHaveLength(2);
  });

  it('retains identity when an IP address changes', async () => {
    const mac = '78:ee:4c:cf:42:68';

    await recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', mac),
    ]);

    await recordScan('2026-10-18T11:00:00.000Z', [
      device('192.168.7.99', mac),
    ]);

    const records = await store.list(TEST_OWNER);

    expect(records).toHaveLength(1);
    expect(records[0].device.ipAddress).toBe('192.168.7.99');
    expect(records[0].firstSeenAt).toBe(
      '2026-10-18T10:00:00.000Z',
    );
    expect(records[0].device.endpoints).toContainEqual(expect.objectContaining({
      ipAddress: '192.168.7.21',
    }));
    expect(records[0].device.endpoints).toContainEqual(expect.objectContaining({
      ipAddress: '192.168.7.99',
    }));
  });

  it('correlates a verified firmware ID across DHCP changes and restarts while keeping scope boundaries', async () => {
    const firstSeen = '2026-10-23T12:00:00.000Z';
    const lastSeen = '2026-10-23T12:10:00.000Z';
    await recordScan(firstSeen, [verifiedEnergridDevice('192.168.1.198', firstSeen)]);
    await recordScan(lastSeen, [verifiedEnergridDevice('192.168.1.205', lastSeen)]);

    let records = await store.list(TEST_OWNER);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: firstSeen, lastSeenAt: lastSeen,
      device: { id: 'esp8266:324864', ipAddress: '192.168.1.205', status: 'online' },
    });
    expect(records[0].device.endpoints?.map(endpoint => endpoint.ipAddress).sort())
      .toEqual(['192.168.1.198', '192.168.1.205']);

    await store.onModuleDestroy();
    store = new DeviceDiscoveryMemoryStore(directory);
    records = await store.list(TEST_OWNER);
    expect(records).toHaveLength(1);
    expect(records[0].lastSeenAt).toBe(lastSeen);

    await recordScan('2026-10-23T12:20:00.000Z', [
      verifiedEnergridDevice('192.168.1.205', '2026-10-23T12:20:00.000Z', 'other-routed-lan'),
    ]);
    expect(await store.list(TEST_OWNER)).toHaveLength(2);
  });

  it('replaces an unverified endpoint-only alias with the verified canonical firmware identity', async () => {
    const firstSeen = '2026-10-23T12:00:00.000Z';
    await recordScan(firstSeen, [{
      ...device('192.168.1.198', 'ff:ff:ff:ff:ff:ff'),
      id: '192.168.1.198', networkZoneId: 'upstream-lan', networkZoneName: 'Upstream LAN',
    }]);
    await recordScan('2026-10-23T12:01:00.000Z', [verifiedEnergridDevice('192.168.1.198', '2026-10-23T12:01:00.000Z')]);

    const records = await store.list(TEST_OWNER);
    expect(records).toHaveLength(1);
    expect(records[0].identity).toBe('device:upstream-lan:esp8266:324864');
  });

  it('deduplicates repeated verified identity evidence within one scan', async () => {
    const observedAt = '2026-10-23T12:00:00.000Z';
    const candidate = verifiedEnergridDevice('192.168.1.198', observedAt);
    await recordScan(observedAt, [candidate, structuredClone(candidate)]);

    const records = await store.list(TEST_OWNER);
    expect(records).toHaveLength(1);
    expect(records[0].device.endpoints).toHaveLength(1);
    expect(records[0].device.observations?.filter(item => item.attribute === 'identity.verified')).toHaveLength(1);
  });

  it('keeps a missed device as historical evidence and marks it absent from the latest scan', async () => {
    await recordScan('2026-10-23T12:00:00.000Z', [verifiedEnergridDevice('192.168.1.198', '2026-10-23T12:00:00.000Z')]);
    await recordScan('2026-10-23T12:05:00.000Z', []);

    const [record] = await store.list(TEST_OWNER);
    expect(record.lastScanId).toBe('2026-10-23T12:00:00.000Z');
    expect(record.device.status).toBe('online');
    expect(isNetworkObservationFresh(record.device.discoveredAt, Date.parse('2026-10-23T12:05:00.000Z'))).toBe(false);
    expect(await store.summary(TEST_OWNER)).toMatchObject({ known: 1, observedInLatestScan: 0, notObservedInLatestScan: 1 });
  });

  it('retains all same-scan endpoint addresses under one scoped observed identity', async () => {
    const mac = '78:ee:4c:cf:42:68';
    await recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', mac),
      device('192.168.7.22', mac),
    ]);

    const records = await store.list(TEST_OWNER);

    expect(records).toHaveLength(1);
    expect(records[0].device.endpoints?.map(endpoint => endpoint.ipAddress).sort())
      .toEqual(['192.168.7.21', '192.168.7.22']);
  });

  it('projects legacy and MAC-keyed memory for one scoped IP as one endpoint', async () => {
    await recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', 'ff:ff:ff:ff:ff:ff'),
    ]);
    await recordScan('2026-10-18T11:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
    ]);

    const records = await store.list(TEST_OWNER);

    expect(records).toHaveLength(1);
    expect(records[0].device.macAddress).toBe('78:ee:4c:cf:42:68');
  });

  it('keeps one current endpoint after repeated scans while retaining hostname observations', async () => {
    await recordScan('2026-10-18T10:00:00.000Z', [
      {
        ...device('192.168.7.21', '78:ee:4c:cf:42:68'),
        hostname: 'esp-3254b7',
        observations: [{ source: 'dns', attribute: 'hostname', value: 'esp-3254b7', observedAt: '2026-10-18T10:00:00.000Z' }],
      },
    ]);
    await recordScan('2026-10-18T11:00:00.000Z', [
      {
        ...device('192.168.7.21', '78:ee:4c:cf:42:68'),
        hostname: 'ESP-3254B7',
        observations: [{ source: 'dns', attribute: 'hostname', value: 'ESP-3254B7', observedAt: '2026-10-18T11:00:00.000Z' }],
      },
    ]);

    const records = await store.list(TEST_OWNER);

    expect(records).toHaveLength(1);
    expect(records[0].device.observations?.map(item => item.value)).toEqual([
      'esp-3254b7',
      'ESP-3254B7',
    ]);
  });

  it('does not combine same IP records from different network scopes', async () => {
    const first = device('192.168.7.21', '78:ee:4c:cf:42:68');
    const second = {
      ...device('192.168.7.21', 'e4:b0:63:74:7c:ac'),
      networkZoneId: 'guest-lan',
      networkZoneName: 'Guest LAN',
    };

    await recordScan('2026-10-18T10:00:00.000Z', [first, second]);

    expect(await store.list(TEST_OWNER)).toHaveLength(2);
  });

  it('retains conflicting MAC evidence on one endpoint projection', async () => {
    await recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
      device('192.168.7.21', 'e4:b0:63:74:7c:ac'),
    ]);

    const records = await store.list(TEST_OWNER);

    expect(records).toHaveLength(1);
    expect(records[0].device.identityConflict).toEqual({
      reason: 'multiple_macs_for_endpoint',
      macAddresses: ['78:ee:4c:cf:42:68', 'e4:b0:63:74:7c:ac'],
    });
  });

  it('projects equally current MAC conflicts without merging physical identity evidence', async () => {
    const scanId = '2026-10-18T10:00:00.000Z';
    const shelly = {
      ...device('192.168.7.21', '78:ee:4c:cf:42:68'),
      id: 'shellypro2pm-78ee4ccf4268',
      vendor: 'Shelly',
      protocol: 'http' as const,
      model: 'Shelly Pro 2PM',
      firmwareVersion: '1.4.4',
      app: 'Pro2PM',
      deviceReportedMacAddress: '78:ee:4c:cf:42:69',
      components: [{ component: 'switch:0', channel: 0 }],
      observations: [{ source: 'tcp' as const, attribute: 'service', value: 80, observedAt: scanId }],
    };
    const esp = {
      ...device('192.168.7.21', 'e4:b0:63:74:7c:ac'),
      id: 'esp-identity-e4b063747cac',
      vendor: 'Espressif',
      protocol: 'mqtt' as const,
      model: 'ESP32-C6',
      firmwareVersion: '2.0.0',
      app: 'esp-device',
      deviceReportedMacAddress: 'e4:b0:63:74:7c:ad',
      components: [{ component: 'temperature:0', channel: 0 }],
      observations: [{ source: 'tcp' as const, attribute: 'service', value: 1883, observedAt: scanId }],
    };
    await recordScan(scanId, [shelly, esp]);

    const identityEvidence = await store.listIdentityEvidence(TEST_OWNER);
    const endpointView = dedupeNetworkEndpoints(identityEvidence.map(record => record.device));
    const rememberedEndpointView = await store.list(TEST_OWNER);

    expect(identityEvidence).toHaveLength(2);
    expect(identityEvidence.map(record => record.device.id).sort()).toEqual([
      'esp-identity-e4b063747cac',
      'shellypro2pm-78ee4ccf4268',
    ]);
    expect(identityEvidence.find(record => record.device.id === shelly.id)?.device)
      .toMatchObject({
        components: shelly.components,
        model: shelly.model,
        firmwareVersion: shelly.firmwareVersion,
        app: shelly.app,
        protocol: shelly.protocol,
        deviceReportedMacAddress: shelly.deviceReportedMacAddress,
        observations: shelly.observations,
      });
    expect(identityEvidence.find(record => record.device.id === esp.id)?.device)
      .toMatchObject({
        components: esp.components,
        model: esp.model,
        firmwareVersion: esp.firmwareVersion,
        app: esp.app,
        protocol: esp.protocol,
        deviceReportedMacAddress: esp.deviceReportedMacAddress,
        observations: esp.observations,
      });

    expect(endpointView).toHaveLength(1);
    expect(endpointView[0]).toMatchObject({
      id: 'endpoint:local-lan:192.168.7.21',
      ipAddress: '192.168.7.21',
      networkZoneId: 'local-lan',
      status: 'unknown',
      protocol: 'unknown',
      identityConflict: {
        reason: 'multiple_macs_for_endpoint',
        macAddresses: ['78:ee:4c:cf:42:68', 'e4:b0:63:74:7c:ac'],
      },
      endpoints: expect.arrayContaining([
        expect.objectContaining({ macAddress: '78:ee:4c:cf:42:68' }),
        expect.objectContaining({ macAddress: 'e4:b0:63:74:7c:ac' }),
      ]),
    });
    expect(endpointView[0]).not.toHaveProperty('macAddress');
    expect(endpointView[0]).not.toHaveProperty('deviceReportedMacAddress');
    expect(endpointView[0]).not.toHaveProperty('vendor');
    expect(endpointView[0]).not.toHaveProperty('model');
    expect(endpointView[0]).not.toHaveProperty('firmwareVersion');
    expect(endpointView[0]).not.toHaveProperty('app');
    expect(endpointView[0]).not.toHaveProperty('components');
    expect(endpointView[0]).not.toHaveProperty('observations');
    expect(endpointView[0].id).not.toBe(shelly.id);
    expect(endpointView[0].id).not.toBe(esp.id);
    expect(rememberedEndpointView).toHaveLength(1);
    expect(rememberedEndpointView[0].device.identityConflict).toEqual({
      reason: 'multiple_macs_for_endpoint',
      macAddresses: ['78:ee:4c:cf:42:68', 'e4:b0:63:74:7c:ac'],
    });
    expect(rememberedEndpointView[0].device.id).toBe('endpoint:local-lan:192.168.7.21');
    expect(rememberedEndpointView[0].device).not.toHaveProperty('components');
    expect(rememberedEndpointView[0].device).not.toHaveProperty('model');
    expect(rememberedEndpointView[0].device).not.toHaveProperty('firmwareVersion');
    expect(rememberedEndpointView[0].device).not.toHaveProperty('deviceReportedMacAddress');
  });

  it('still merges repeated endpoint observations for the same MAC identity', () => {
    const mac = '78:ee:4c:cf:42:68';
    const endpoints = dedupeNetworkEndpoints([
      { ...device('192.168.7.21', mac), components: [{ component: 'switch:0', channel: 0 }] },
      { ...device('192.168.7.21', mac), components: [{ component: 'switch:1', channel: 1 }] },
    ]);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].identityConflict).toBeUndefined();
    expect(endpoints[0].components).toEqual([
      { component: 'switch:0', channel: 0 },
      { component: 'switch:1', channel: 1 },
    ]);
  });

  it('preserves knowledge when a scan returns no devices', async () => {
    await recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
    ]);

    await recordScan('2026-10-18T11:00:00.000Z', []);

    const summary = await store.summary(TEST_OWNER);

    expect(summary.known).toBe(1);
    expect(summary.observedInLatestScan).toBe(0);
    expect(summary.notObservedInLatestScan).toBe(1);
  });

  it('keeps reused-IP endpoint evidence separate from historical device identity evidence', async () => {
    await recordScan('2026-10-19T10:00:00.000Z', [{
      ...device('192.168.1.133', 'ec:62:60:90:d1:97'),
      id: 'shellypro2pm-ec626090d194', vendor: 'Shelly', protocol: 'http',
      model: 'Shelly Pro 2PM',
      firmwareVersion: '1.4.4',
      app: 'Pro2PM',
      deviceReportedMacAddress: 'ec:62:60:90:d1:94',
      components: [{ component: 'switch:0', channel: 0 }],
      observations: [{ source: 'tcp', attribute: 'service', value: 80, observedAt: '2026-10-19T10:00:00.000Z' }],
    }]);
    await recordScan('2026-10-20T10:00:00.000Z', [{
      ...device('192.168.1.133', '3c:71:bf:32:54:b7'),
      id: '3c:71:bf:32:54:b7', vendor: 'Espressif', protocol: 'unknown', status: 'online',
      observations: [{ source: 'icmp', attribute: 'reachable', value: true, observedAt: '2026-10-20T10:00:00.000Z' }],
    }]);

    const endpointView = await store.list(TEST_OWNER);
    const identityEvidence = await store.listIdentityEvidence(TEST_OWNER);

    expect(endpointView).toHaveLength(1);
    expect(endpointView[0].device).toMatchObject({
      id: '3c:71:bf:32:54:b7',
      macAddress: '3c:71:bf:32:54:b7',
      vendor: 'Espressif',
      protocol: 'unknown',
      status: 'online',
      observations: [{ source: 'icmp', attribute: 'reachable', value: true }],
    });
    expect(endpointView[0].device.identityConflict).toBeUndefined();
    expect(endpointView[0].device.components).toBeUndefined();
    expect(endpointView[0].device.model).toBeUndefined();
    expect(endpointView[0].device.firmwareVersion).toBeUndefined();
    expect(endpointView[0].device.app).toBeUndefined();
    expect(endpointView[0].device.deviceReportedMacAddress).toBeUndefined();
    expect(identityEvidence.map(record => record.device.id)).toEqual([
      '3c:71:bf:32:54:b7', 'shellypro2pm-ec626090d194',
    ]);
    expect(identityEvidence[1].device).toMatchObject({
      macAddress: 'ec:62:60:90:d1:97',
      model: 'Shelly Pro 2PM',
      firmwareVersion: '1.4.4',
      app: 'Pro2PM',
      components: [{ component: 'switch:0', channel: 0 }],
      observations: [{ source: 'tcp', attribute: 'service', value: 80 }],
    });
  });
});
