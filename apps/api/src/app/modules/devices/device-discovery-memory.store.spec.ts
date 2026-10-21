import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dedupeNetworkEndpoints,
  DeviceDiscoveryMemoryStore,
} from './device-discovery-memory.store';
import type {
  NetworkDiscoveredDevice,
} from './device-registry.types';
import type { NetworkDiscoverySnapshot } from './network-discovery-snapshot';

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

describe('DeviceDiscoveryMemoryStore', () => {
  let directory: string;
  let store: DeviceDiscoveryMemoryStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'energrid-discovery-'));
    store = new DeviceDiscoveryMemoryStore(directory);
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists devices across store restarts', async () => {
    const timestamp = '2026-10-18T10:00:00.000Z';

    await store.recordScan(timestamp, [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
    ]);

    await store.onModuleDestroy();

    store = new DeviceDiscoveryMemoryStore(directory);

    const records = await store.list();

    expect(records).toHaveLength(1);
    expect(records[0].firstSeenAt).toBe(timestamp);
    expect(records[0].lastSeenAt).toBe(timestamp);
  });

  it('stores immutable scan snapshots across store restarts and rejects replacing an existing scan ID', async () => {
    const snapshot: NetworkDiscoverySnapshot = {
      schemaVersion: 1, scanId: 'scan-immutable-1', startedAt: '2026-10-18T10:00:00.000Z',
      completedAt: '2026-10-18T10:00:05.000Z', collector: { id: 'mac/en0', host: 'mac', interfaces: ['en0'] },
      scopes: [{ id: 'home', name: 'Home', cidr: '192.168.7.0/24', complete: true, gatewayIpsObserved: [] }],
      methods: ['icmp', 'tcp'], successes: 1, failures: [], limitations: [], rawEvidenceOmitted: 0,
      rawEvidence: [{ observedAt: '2026-10-18T10:00:01.000Z', source: 'neighbor_table', scopeId: 'home', evidence: { ipAddress: '192.168.7.21' } }],
      endpoints: [device('192.168.7.21', '78:ee:4c:cf:42:68')], topology: { relationships: [] },
    }
    await store.recordSnapshot(snapshot)
    await expect(store.recordSnapshot({ ...snapshot, completedAt: '2026-10-18T10:01:00.000Z' }))
      .rejects.toThrow('Discovery snapshot already exists')
    await store.onModuleDestroy()
    store = new DeviceDiscoveryMemoryStore(directory)
    expect(await store.getSnapshot(snapshot.scanId)).toEqual(snapshot)
    expect(await store.listSnapshots()).toEqual([snapshot])
  })

  it('retains devices absent from a later scan', async () => {
    await store.recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
      device('192.168.7.30', 'e4:b0:63:74:7c:ac'),
    ]);

    await store.recordScan('2026-10-18T11:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
    ]);

    expect(await store.summary()).toEqual({
      lastScanId: '2026-10-18T11:00:00.000Z',
      known: 2,
      observedInLatestScan: 1,
      notObservedInLatestScan: 1,
    });

    expect(await store.list()).toHaveLength(2);
  });

  it('retains identity when an IP address changes', async () => {
    const mac = '78:ee:4c:cf:42:68';

    await store.recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', mac),
    ]);

    await store.recordScan('2026-10-18T11:00:00.000Z', [
      device('192.168.7.99', mac),
    ]);

    const records = await store.list();

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

  it('retains all same-scan endpoint addresses under one scoped observed identity', async () => {
    const mac = '78:ee:4c:cf:42:68';
    await store.recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', mac),
      device('192.168.7.22', mac),
    ]);

    const records = await store.list();

    expect(records).toHaveLength(1);
    expect(records[0].device.endpoints?.map(endpoint => endpoint.ipAddress).sort())
      .toEqual(['192.168.7.21', '192.168.7.22']);
  });

  it('projects legacy and MAC-keyed memory for one scoped IP as one endpoint', async () => {
    await store.recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', 'ff:ff:ff:ff:ff:ff'),
    ]);
    await store.recordScan('2026-10-18T11:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
    ]);

    const records = await store.list();

    expect(records).toHaveLength(1);
    expect(records[0].device.macAddress).toBe('78:ee:4c:cf:42:68');
  });

  it('keeps one current endpoint after repeated scans while retaining hostname observations', async () => {
    await store.recordScan('2026-10-18T10:00:00.000Z', [
      {
        ...device('192.168.7.21', '78:ee:4c:cf:42:68'),
        hostname: 'esp-3254b7',
        observations: [{ source: 'dns', attribute: 'hostname', value: 'esp-3254b7', observedAt: '2026-10-18T10:00:00.000Z' }],
      },
    ]);
    await store.recordScan('2026-10-18T11:00:00.000Z', [
      {
        ...device('192.168.7.21', '78:ee:4c:cf:42:68'),
        hostname: 'ESP-3254B7',
        observations: [{ source: 'dns', attribute: 'hostname', value: 'ESP-3254B7', observedAt: '2026-10-18T11:00:00.000Z' }],
      },
    ]);

    const records = await store.list();

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

    await store.recordScan('2026-10-18T10:00:00.000Z', [first, second]);

    expect(await store.list()).toHaveLength(2);
  });

  it('retains conflicting MAC evidence on one endpoint projection', async () => {
    await store.recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
      device('192.168.7.21', 'e4:b0:63:74:7c:ac'),
    ]);

    const records = await store.list();

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
    await store.recordScan(scanId, [shelly, esp]);

    const identityEvidence = await store.listIdentityEvidence();
    const endpointView = dedupeNetworkEndpoints(identityEvidence.map(record => record.device));
    const rememberedEndpointView = await store.list();

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
    await store.recordScan('2026-10-18T10:00:00.000Z', [
      device('192.168.7.21', '78:ee:4c:cf:42:68'),
    ]);

    await store.recordScan('2026-10-18T11:00:00.000Z', []);

    const summary = await store.summary();

    expect(summary.known).toBe(1);
    expect(summary.observedInLatestScan).toBe(0);
    expect(summary.notObservedInLatestScan).toBe(1);
  });

  it('keeps reused-IP endpoint evidence separate from historical device identity evidence', async () => {
    await store.recordScan('2026-10-19T10:00:00.000Z', [{
      ...device('192.168.1.133', 'ec:62:60:90:d1:97'),
      id: 'shellypro2pm-ec626090d194', vendor: 'Shelly', protocol: 'http',
      model: 'Shelly Pro 2PM',
      firmwareVersion: '1.4.4',
      app: 'Pro2PM',
      deviceReportedMacAddress: 'ec:62:60:90:d1:94',
      components: [{ component: 'switch:0', channel: 0 }],
      observations: [{ source: 'tcp', attribute: 'service', value: 80, observedAt: '2026-10-19T10:00:00.000Z' }],
    }]);
    await store.recordScan('2026-10-20T10:00:00.000Z', [{
      ...device('192.168.1.133', '3c:71:bf:32:54:b7'),
      id: '3c:71:bf:32:54:b7', vendor: 'Espressif', protocol: 'unknown', status: 'online',
      observations: [{ source: 'icmp', attribute: 'reachable', value: true, observedAt: '2026-10-20T10:00:00.000Z' }],
    }]);

    const endpointView = await store.list();
    const identityEvidence = await store.listIdentityEvidence();

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
