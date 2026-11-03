import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import {
  filterNetworkDevices, mergeCurrentAndRememberedDevices, networkInventoryStats,
} from './discovery-network';
import { useDiscoveryNetworkModel } from './useDiscoveryNetworkModel';
import type { DiscoveryMemoryResponse, NetworkDevice } from './discovery-contracts';

const device = (overrides: Partial<NetworkDevice> = {}): NetworkDevice => ({
  id: 'shelly-1', ipAddress: '172.30.250.3', networkZoneId: 'lab', networkZoneName: 'Virtual Lab',
  macAddress: '02:63:60:34:06:4d', vendor: 'Shelly', protocol: 'http', model: 'Plus 1',
  confidence: 1, status: 'online', discoveredAt: '2026-11-03T12:00:00Z', reason: 'RPC identity',
  ...overrides,
});
const memory = (records: NetworkDevice[], lastScanId = 'scan-1'): DiscoveryMemoryResponse => ({
  summary: { lastScanId, known: records.length, observedInLatestScan: 0, notObservedInLatestScan: records.length },
  devices: records.map((record, index) => ({ schemaVersion: 1, identity: record.macAddress ? `mac:${record.macAddress.toLowerCase()}` : `endpoint:${record.networkZoneId}:${record.ipAddress}`,
    device: record, firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-02T00:00:00Z', lastScanId: `old-${index}` })),
});

describe('Discovery network inventory model', () => {
  it('prefers current MAC evidence even when the remembered IP changed', () => {
    const live = device();
    const retained = device({ ipAddress: '172.30.250.4', status: 'online' });
    expect(mergeCurrentAndRememberedDevices([live], memory([retained]))).toEqual([live]);
  });

  it('suppresses old records at an occupied endpoint, and never implies reachability for retained history', () => {
    const current = device({ macAddress: '00:00:00:00:00:01' });
    const staleAtSameAddress = device({ macAddress: '00:00:00:00:00:02' });
    const different = device({ id: 'esp-2', vendor: 'Espressif', model: 'ESP8266', ipAddress: '172.30.250.10', macAddress: undefined, status: 'online' });
    const merged = mergeCurrentAndRememberedDevices([current], memory([staleAtSameAddress, different]));
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(current);
    expect(merged[1]).toMatchObject({ id: 'esp-2', status: 'unknown' });
    expect(different.status).toBe('online'); // never mutate stored evidence
  });

  it('searches all devices even in Shelly-only mode, while empty search respects the filter', () => {
    const shelly = device();
    const esp = device({ id: 'esp-2', vendor: 'Espressif', model: 'ESP8266', app: undefined, ipAddress: '172.30.250.10' });
    expect(filterNetworkDevices([shelly, esp], 'capable', '')).toEqual([shelly]);
    expect(filterNetworkDevices([shelly, esp], 'capable', 'esp-2')).toEqual([esp]);
    expect(filterNetworkDevices([shelly, esp], 'all', '172.30.250.3')).toEqual([shelly]);
  });

  it('separates live online responses from remembered counts in summary statistics', () => {
    const live = device();
    const old = device({ id: 'old-1', ipAddress: '172.30.250.10', status: 'unknown' });
    const values = networkInventoryStats([live, old], [live], memory([old]), [{ id: 'lab', name: 'Virtual Lab', seedIps: [] }]);
    expect(values.find(row => row.label === 'Online in last API scan')?.value).toBe('1');
    expect(values.find(row => row.label === 'Remembered endpoints')?.value).toBe('1');
    expect(values.find(row => row.label === 'Zones')?.value).toBe('1');
  });

  it('reacts to memory replacement and distinguishes one-endpoint verification from subnet scans', () => {
    const live = ref<NetworkDevice[]>([]);
    const retained = ref<DiscoveryMemoryResponse | null>(memory([device()]));
    const snapshots = ref([{ methods: ['operator_selected_shelly_read_only_rpc'], completedAt: 'scan-1' }]);
    const model = useDiscoveryNetworkModel(live, retained, snapshots);
    expect(model.networkDevices.value[0].status).toBe('unknown');
    expect(model.latestMemoryMarkerVerification.value).not.toBeNull();
    live.value = [device()];
    expect(model.networkDevices.value).toHaveLength(1);
    retained.value = memory([device({ id: 'new', macAddress: '00:11:22:33:44:55', ipAddress: '172.30.250.9' })], 'scan-2');
    expect(model.latestMemoryMarkerVerification.value).toBeNull();
    expect(model.networkDevices.value).toHaveLength(2);
  });
});
