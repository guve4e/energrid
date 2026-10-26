import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NetworkDiscoveredDevice } from './device-registry.types';
import type { NetworkDiscoverySnapshot } from './network-discovery-snapshot';
import {
  conflictEndpointEvidence,
  dedupeNetworkEndpoints,
  hasUsefulMac,
  mergeNetworkHistory,
  networkEndpointIdentity,
  normalizeNetworkHostname,
} from './network-discovery-evidence-utils';
export {
  dedupeNetworkEndpoints,
  networkEndpointIdentity,
  normalizeNetworkHostname,
} from './network-discovery-evidence-utils';

export const DEVICE_DISCOVERY_MEMORY_DIRECTORY = Symbol(
  'DEVICE_DISCOVERY_MEMORY_DIRECTORY',
);

export interface DiscoveryOwnership {
  tenantId: string;
  siteId: string;
}

export interface KnownNetworkDevice {
  schemaVersion: 1 | 2;
  /** Missing only on legacy records; those records are never candidate evidence. */
  ownership?: DiscoveryOwnership;
  identity: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastScanId: string;
  device: NetworkDiscoveredDevice;
}

export interface DiscoveryMemorySummary {
  lastScanId: string | null;
  known: number;
  observedInLatestScan: number;
  notObservedInLatestScan: number;
}

function dedupeKnownRecords(records: KnownNetworkDevice[]): KnownNetworkDevice[] {
  const groups = new Map<string, KnownNetworkDevice[]>();
  for (const record of records) {
    const identity = networkEndpointIdentity(record.device);
    const group = groups.get(identity) || [];
    group.push(record);
    groups.set(identity, group);
  }

  return [...groups.values()].map(group => {
    const newest = [...group].sort((a, b) =>
      b.lastSeenAt.localeCompare(a.lastSeenAt) ||
      b.device.discoveredAt.localeCompare(a.device.discoveredAt) ||
      b.device.confidence - a.device.confidence ||
      a.device.id.localeCompare(b.device.id),
    )[0];
    const currentScanMacs = [...new Set(group
      .filter(record => record.lastScanId === newest.lastScanId)
      .flatMap(record => [record.device.macAddress, ...(record.device.identityConflict?.macAddresses || [])])
      .map(mac => mac?.trim().toLowerCase())
      .filter((mac): mac is string => !!mac && mac !== 'ff:ff:ff:ff:ff:ff'))]
      .sort();
    const hasCurrentMacConflict = currentScanMacs.length > 1;
    const currentScanRecords = group.filter(record => record.lastScanId === newest.lastScanId);
    const device = hasCurrentMacConflict
      ? conflictEndpointEvidence(currentScanRecords.map(record => record.device), currentScanMacs)
      : newest.device;
    return {
      ...newest,
      identity: hasCurrentMacConflict ? networkEndpointIdentity(device) : newest.identity,
      device,
    };
  }).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function networkDiscoveryIdentity(device: NetworkDiscoveredDevice): string {
  const stableDeviceId = verifiedDeviceIdentity(device)
  if (stableDeviceId) {
    return `device:${device.networkZoneId}:${stableDeviceId}`
  }

  const mac = device.macAddress?.trim().toLowerCase();

  if (mac && mac !== 'ff:ff:ff:ff:ff:ff') {
    return `mac:${device.networkZoneId}:${mac}`;
  }

  if (device.vendor === 'Shelly' && device.id.toLowerCase().startsWith('shelly')) {
    return `shelly:${device.networkZoneId}:${device.id.toLowerCase()}`;
  }

  return networkEndpointIdentity(device);
}

function verifiedDeviceIdentity(device: NetworkDiscoveredDevice): string | null {
  const verified = device.observations?.some(observation =>
    observation.source === 'http_identity' &&
    observation.attribute === 'identity.verified' &&
    observation.value === true,
  )
  const id = device.observations?.find(observation =>
    observation.source === 'http_identity' && observation.attribute === 'identity.device_id',
  )?.value
  return verified && typeof id === 'string' && id === device.id ? id.toLowerCase() : null
}

function scopedKey(identity: string, ownership: DiscoveryOwnership): string {
  return `known:${encodeURIComponent(ownership.tenantId)}:${encodeURIComponent(ownership.siteId)}:${encodeURIComponent(identity)}`;
}

function summaryKey(ownership: DiscoveryOwnership): string {
  return `meta:lastScanId:${encodeURIComponent(ownership.tenantId)}:${encodeURIComponent(ownership.siteId)}`;
}

function validOwnership(value: unknown): value is DiscoveryOwnership {
  if (!value || typeof value !== 'object') return false;
  const ownership = value as Partial<DiscoveryOwnership>;
  return typeof ownership.tenantId === 'string' && ownership.tenantId.trim().length > 0 &&
    typeof ownership.siteId === 'string' && ownership.siteId.trim().length > 0;
}

function sameOwnership(a: DiscoveryOwnership | undefined, b: DiscoveryOwnership): boolean {
  return !!a && a.tenantId === b.tenantId && a.siteId === b.siteId;
}

function isKnownDevice(value: unknown): value is KnownNetworkDevice {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<KnownNetworkDevice>;

  return (record.schemaVersion === 1 || record.schemaVersion === 2) &&
    typeof record.identity === 'string' &&
    typeof record.firstSeenAt === 'string' &&
    typeof record.lastSeenAt === 'string' &&
    typeof record.lastScanId === 'string' &&
    (record.schemaVersion === 1 || validOwnership(record.ownership)) &&
    !!record.device &&
    typeof record.device.ipAddress === 'string';
}

@Injectable()
export class DeviceDiscoveryMemoryStore implements OnModuleDestroy {
  private readonly db: ClassicLevel<string, unknown>;

  constructor(
    @Optional()
    @Inject(DEVICE_DISCOVERY_MEMORY_DIRECTORY)
    directory?: string,
  ) {
    this.db = new ClassicLevel(
      directory?.trim() ||
        process.env.HOME_DISCOVERY_MEMORY_DIRECTORY?.trim() ||
        join(homedir(), '.energrid', 'network-discovery'),
      { valueEncoding: 'json' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.close();
  }

  private async getOptional(key: string): Promise<unknown> {
    try {
      return await this.db.get(key);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'LEVEL_NOT_FOUND'
      ) {
        return undefined;
      }

      throw error;
    }
  }

  async recordScan(
    scanId: string,
    devices: NetworkDiscoveredDevice[],
    ownership: DiscoveryOwnership,
  ): Promise<void> {
    if (!validOwnership(ownership)) throw new Error('Discovery evidence requires server-authorized tenant/site ownership');
    const recordsByKey = new Map<string, KnownNetworkDevice>();
    const endpointAliasesToDelete = new Set<string>();
    for (const device of devices) {
      const identity = networkDiscoveryIdentity(device);
      const databaseKey = scopedKey(identity, ownership);
      const pending = recordsByKey.get(databaseKey);
      const previousValue = pending || await this.getOptional(databaseKey);
      const previous = isKnownDevice(previousValue)
        ? previousValue
        : null;

      const record: KnownNetworkDevice = {
        schemaVersion: 2,
        ownership: structuredClone(ownership),
        identity,
        firstSeenAt: previous?.firstSeenAt || scanId,
        lastSeenAt: scanId,
        lastScanId: scanId,
        device: structuredClone(previous
          ? mergeNetworkHistory(previous.device, device)
          : device),
      };

      recordsByKey.set(databaseKey, record);

      const endpointIdentity = networkEndpointIdentity(device)
      const endpointKey = scopedKey(endpointIdentity, ownership)
      if (!verifiedDeviceIdentity(device)) continue
      const endpointValue = await this.getOptional(endpointKey)
      if (isKnownDevice(endpointValue) && endpointValue.identity === endpointIdentity &&
          !verifiedDeviceIdentity(endpointValue.device)) {
        endpointAliasesToDelete.add(endpointKey)
      }
    }

    const operations: Array<
      { type: 'put'; key: string; value: unknown } | { type: 'del'; key: string }
    > = [...recordsByKey].map(([databaseKey, record]) => ({
      type: 'put',
      key: databaseKey,
      value: record,
    }));

    for (const endpointKey of endpointAliasesToDelete) {
      if (!recordsByKey.has(endpointKey)) operations.push({ type: 'del', key: endpointKey });
    }

    operations.push({
      type: 'put',
      key: summaryKey(ownership),
      value: scanId,
    });

    await this.db.batch(operations);
  }

  async getNetworkInstallerNotes(tenantId: string, siteId: string): Promise<{
    schemaVersion: 1;
    source: 'installer';
    text: string;
    updatedAt: string;
  } | null> {
    const key = `network:installer-notes:${encodeURIComponent(tenantId)}:${encodeURIComponent(siteId)}`;
    const value = await this.getOptional(key);

    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;

    if (record.schemaVersion !== 1 ||
        record.source !== 'installer' ||
        typeof record.text !== 'string' ||
        typeof record.updatedAt !== 'string') {
      return null;
    }

    return {
      schemaVersion: 1,
      source: 'installer',
      text: record.text,
      updatedAt: record.updatedAt,
    };
  }

  async saveNetworkInstallerNotes(
    tenantId: string,
    siteId: string,
    text: string,
  ) {
    const record = {
      schemaVersion: 1 as const,
      source: 'installer' as const,
      text,
      updatedAt: new Date().toISOString(),
    };

    const key = `network:installer-notes:${encodeURIComponent(tenantId)}:${encodeURIComponent(siteId)}`;
    await this.db.put(key, record);
    return record;
  }

  async recordSnapshot(snapshot: NetworkDiscoverySnapshot): Promise<void> {
    if (!validOwnership(snapshot.ownership)) {
      throw new Error('New discovery snapshots require server-authorized tenant/site ownership');
    }
    const snapshotKey = `snapshot:${encodeURIComponent(snapshot.scanId)}`;
    if (await this.getOptional(snapshotKey) !== undefined) {
      throw new Error(`Discovery snapshot already exists: ${snapshot.scanId}`);
    }
    const { ownershipStatus: _projectionOnlyStatus, ...persistedSnapshot } = snapshot;
    await this.db.put(snapshotKey, structuredClone(persistedSnapshot));
  }

  async getSnapshot(scanId: string, ownership: DiscoveryOwnership): Promise<NetworkDiscoverySnapshot | null> {
    if (!validOwnership(ownership)) return null;
    const value = await this.getOptional(`snapshot:${encodeURIComponent(scanId)}`);
    return isNetworkDiscoverySnapshot(value) && sameOwnership(value.ownership, ownership) ? value : null;
  }

  async listSnapshots(ownership: DiscoveryOwnership, limit = 50): Promise<NetworkDiscoverySnapshot[]> {
    if (!validOwnership(ownership)) return [];
    const snapshots: NetworkDiscoverySnapshot[] = [];
    for await (const [, value] of this.db.iterator({ gte: 'snapshot:', lt: 'snapshot:\uffff' })) {
      if (isNetworkDiscoverySnapshot(value) && sameOwnership(value.ownership, ownership)) snapshots.push(value);
    }
    return snapshots
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.scanId.localeCompare(a.scanId))
      .slice(0, Math.max(1, Math.min(Math.floor(limit), 100)));
  }

  /** Includes legacy snapshots for read-only history, explicitly marked unscoped. */
  async listHistoricalSnapshots(ownership: DiscoveryOwnership, limit = 50): Promise<NetworkDiscoverySnapshot[]> {
    if (!validOwnership(ownership)) return [];
    const snapshots: NetworkDiscoverySnapshot[] = [];
    for await (const [, value] of this.db.iterator({ gte: 'snapshot:', lt: 'snapshot:\uffff' })) {
      if (!isNetworkDiscoverySnapshot(value)) continue;
      if (value.ownership && !sameOwnership(value.ownership, ownership)) continue;
      snapshots.push({
        ...value,
        ownershipStatus: value.ownership ? 'scoped' : 'legacy-unscoped',
      });
    }
    return snapshots
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.scanId.localeCompare(a.scanId))
      .slice(0, Math.max(1, Math.min(Math.floor(limit), 100)));
  }

  /** Persist one independently verified endpoint without claiming a complete network scan. */
  async recordIdentityObservation(
    observedAt: string,
    device: NetworkDiscoveredDevice,
    ownership: DiscoveryOwnership,
  ): Promise<void> {
    if (!validOwnership(ownership)) throw new Error('Identity evidence requires server-authorized tenant/site ownership');
    const identity = networkDiscoveryIdentity(device);
    const databaseKey = scopedKey(identity, ownership);
    const previousValue = await this.getOptional(databaseKey);
    const previous = isKnownDevice(previousValue) ? previousValue : null;
    const record: KnownNetworkDevice = {
      schemaVersion: 2,
      ownership: structuredClone(ownership),
      identity,
      firstSeenAt: previous?.firstSeenAt || observedAt,
      lastSeenAt: observedAt,
      lastScanId: `identity:${observedAt}`,
      device: structuredClone(previous
        ? mergeNetworkHistory(previous.device, device)
        : device),
    };
    await this.db.put(databaseKey, record);
  }

  async list(ownership: DiscoveryOwnership): Promise<KnownNetworkDevice[]> {
    return dedupeKnownRecords(await this.listIdentityEvidence(ownership));
  }

  async listIdentityEvidence(ownership: DiscoveryOwnership): Promise<KnownNetworkDevice[]> {
    if (!validOwnership(ownership)) return [];
    const records: KnownNetworkDevice[] = [];

    for await (const [, value] of this.db.iterator({
      gte: 'known:',
      lt: 'known:\uffff',
    })) {
      if (isKnownDevice(value) && value.schemaVersion === 2 && sameOwnership(value.ownership, ownership)) records.push(value);
    }

    return records.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async summary(ownership: DiscoveryOwnership): Promise<DiscoveryMemorySummary> {
    const records = await this.list(ownership);
    const value = await this.getOptional(summaryKey(ownership));
    const lastScanId = typeof value === 'string' ? value : null;

    const observedInLatestScan = lastScanId
      ? records.filter(record => record.lastScanId === lastScanId).length
      : 0;

    return {
      lastScanId,
      known: records.length,
      observedInLatestScan,
      notObservedInLatestScan: records.length - observedInLatestScan,
    };
  }
}


function isNetworkDiscoverySnapshot(value: unknown): value is NetworkDiscoverySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<NetworkDiscoverySnapshot>;
  return (snapshot.schemaVersion === 1 || snapshot.schemaVersion === 2) &&
    typeof snapshot.scanId === 'string' &&
    typeof snapshot.startedAt === 'string' &&
    typeof snapshot.completedAt === 'string' &&
    (snapshot.ownership === undefined || validOwnership(snapshot.ownership)) &&
    Array.isArray(snapshot.scopes) &&
    Array.isArray(snapshot.rawEvidence) &&
    Array.isArray(snapshot.endpoints);
}
