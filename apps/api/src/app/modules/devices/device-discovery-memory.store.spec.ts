import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeviceDiscoveryMemoryStore,
} from './device-discovery-memory.store';
import type {
  NetworkDiscoveredDevice,
} from './device-registry.types';

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
});
