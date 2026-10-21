import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  NetworkDeviceEndpoint,
  NetworkDiscoveredDevice,
} from './device-registry.types';
import type { NetworkDiscoverySnapshot } from './network-discovery-snapshot';

export const DEVICE_DISCOVERY_MEMORY_DIRECTORY = Symbol(
  'DEVICE_DISCOVERY_MEMORY_DIRECTORY',
);

export interface KnownNetworkDevice {
  schemaVersion: 1;
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

export function normalizeNetworkHostname(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase();
}

export function networkEndpointIdentity(
  device: Pick<NetworkDiscoveredDevice, 'networkZoneId' | 'ipAddress'>,
): string {
  return `endpoint:${device.networkZoneId}:${device.ipAddress}`;
}

export function dedupeNetworkEndpoints(
  devices: NetworkDiscoveredDevice[],
): NetworkDiscoveredDevice[] {
  const byEndpoint = new Map<string, NetworkDiscoveredDevice[]>();

  for (const device of devices) {
    const identity = networkEndpointIdentity(device);
    const group = byEndpoint.get(identity) || [];
    group.push(device);
    byEndpoint.set(identity, group);
  }

  return [...byEndpoint.values()].map(mergeEndpointEvidence).sort((a, b) =>
    a.networkZoneId.localeCompare(b.networkZoneId) ||
    a.ipAddress.localeCompare(b.ipAddress),
  );
}

function mergeEndpointEvidence(
  devices: NetworkDiscoveredDevice[],
): NetworkDiscoveredDevice {
  const latestObservedAt = devices.reduce(
    (latest, device) => device.discoveredAt > latest ? device.discoveredAt : latest,
    devices[0].discoveredAt,
  );
  const currentDevices = devices.filter(device => device.discoveredAt === latestObservedAt);
  const currentMacAddresses = [...new Set(currentDevices
    .flatMap(device => [device.macAddress, ...(device.identityConflict?.macAddresses || [])])
    .map(mac => mac?.trim().toLowerCase())
    .filter((mac): mac is string => !!mac && mac !== 'ff:ff:ff:ff:ff:ff'))]
    .sort();

  if (currentMacAddresses.length > 1) {
    return conflictEndpointEvidence(currentDevices, currentMacAddresses);
  }

  const currentMac = currentMacAddresses[0];
  const currentMacDevice = currentDevices.find(
    device => device.macAddress?.trim().toLowerCase() === currentMac,
  );
  const currentHostname = normalizeNetworkHostname(currentMacDevice?.hostname || '');
  const identityDevices = currentMac
    ? devices.filter(device =>
        device.macAddress?.trim().toLowerCase() === currentMac ||
        (!hasUsefulMac(device.macAddress) && currentHostname &&
          normalizeNetworkHostname(device.hostname || '') === currentHostname),
      )
    : currentDevices;
  const preferred = [...identityDevices].sort((a, b) =>
    b.discoveredAt.localeCompare(a.discoveredAt) ||
    b.confidence - a.confidence ||
    Number(hasUsefulMac(b.macAddress)) - Number(hasUsefulMac(a.macAddress)) ||
    (normalizeNetworkHostname(b.hostname || '')
      .localeCompare(normalizeNetworkHostname(a.hostname || ''))),
  )[0];
  const macAddresses = [...new Set(identityDevices
    .flatMap(device => [
      device.macAddress,
      ...(device.identityConflict?.macAddresses || []),
    ])
    .map(mac => mac?.trim().toLowerCase())
    .filter((mac): mac is string => !!mac && mac !== 'ff:ff:ff:ff:ff:ff'))]
    .sort();
  const endpoints = new Map<string, NetworkDeviceEndpoint>();

  for (const device of identityDevices) {
    for (const endpoint of device.endpoints || [{
      ipAddress: device.ipAddress,
      networkZoneId: device.networkZoneId,
      networkZoneName: device.networkZoneName,
      ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
    }]) {
      const identity = `${endpoint.networkZoneId}:${endpoint.ipAddress}:${endpoint.macAddress?.toLowerCase() || ''}`;
      endpoints.set(identity, endpoint);
    }
  }

  const observations = new Map<string, NonNullable<NetworkDiscoveredDevice['observations']>[number]>();
  for (const device of identityDevices) {
    for (const observation of device.observations || []) {
      const identity = `${observation.source}:${observation.attribute}:${String(observation.value)}:${observation.observedAt}`;
      observations.set(identity, observation);
    }
  }

  const components = new Map<string, NonNullable<NetworkDiscoveredDevice['components']>[number]>();
  for (const device of identityDevices) {
    for (const component of device.components || []) components.set(component.component, component);
  }

  const { identityConflict: _oldConflict, ...base } = preferred;
  return {
    ...base,
    ...(macAddresses.length > 1 ? {
      identityConflict: {
        reason: 'multiple_macs_for_endpoint' as const,
        macAddresses,
      },
    } : {}),
    endpoints: [...endpoints.values()].sort((a, b) =>
      a.ipAddress.localeCompare(b.ipAddress) ||
      (a.macAddress || '').localeCompare(b.macAddress || ''),
    ),
    observations: [...observations.values()].sort((a, b) =>
      a.observedAt.localeCompare(b.observedAt) ||
      a.source.localeCompare(b.source) ||
      a.attribute.localeCompare(b.attribute),
    ),
    components: components.size ? [...components.values()].sort((a, b) => a.component.localeCompare(b.component)) : preferred.components,
  };
}

function conflictEndpointEvidence(
  devices: NetworkDiscoveredDevice[],
  macAddresses: string[],
): NetworkDiscoveredDevice {
  const endpoint = devices[0];
  const discoveredAt = devices.reduce(
    (latest, device) => device.discoveredAt > latest ? device.discoveredAt : latest,
    endpoint.discoveredAt,
  );
  const endpoints = new Map<string, NetworkDeviceEndpoint>();

  for (const device of devices) {
    for (const observedEndpoint of device.endpoints || [{
      ipAddress: device.ipAddress,
      networkZoneId: device.networkZoneId,
      networkZoneName: device.networkZoneName,
      ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
    }]) {
      const identity = `${observedEndpoint.networkZoneId}:${observedEndpoint.ipAddress}:${observedEndpoint.macAddress?.toLowerCase() || ''}`;
      endpoints.set(identity, observedEndpoint);
    }
  }

  return {
    id: networkEndpointIdentity(endpoint),
    ipAddress: endpoint.ipAddress,
    networkZoneId: endpoint.networkZoneId,
    networkZoneName: endpoint.networkZoneName,
    protocol: 'unknown',
    confidence: 0,
    status: 'unknown',
    discoveredAt,
    reason: 'Conflicting MAC identities were observed at this endpoint.',
    identityConflict: { reason: 'multiple_macs_for_endpoint', macAddresses },
    endpoints: [...endpoints.values()].sort((a, b) =>
      a.ipAddress.localeCompare(b.ipAddress) ||
      (a.macAddress || '').localeCompare(b.macAddress || ''),
    ),
  };
}

function mergeNetworkHistory(
  previous: NetworkDiscoveredDevice,
  current: NetworkDiscoveredDevice,
): NetworkDiscoveredDevice {
  const latest = previous.discoveredAt.localeCompare(current.discoveredAt) > 0
    ? previous
    : current;
  const endpoints = new Map<string, NetworkDeviceEndpoint>();

  for (const device of [previous, current]) {
    for (const endpoint of device.endpoints || [{
      ipAddress: device.ipAddress,
      networkZoneId: device.networkZoneId,
      networkZoneName: device.networkZoneName,
      ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
    }]) {
      endpoints.set(`${endpoint.networkZoneId}:${endpoint.ipAddress}:${endpoint.macAddress?.toLowerCase() || ''}`, endpoint);
    }
  }

  const merged = mergeEndpointEvidence([previous, current]);
  return {
    ...latest,
    endpoints: [...endpoints.values()].sort((a, b) => a.ipAddress.localeCompare(b.ipAddress)),
    observations: merged.observations,
    ...(merged.identityConflict ? { identityConflict: merged.identityConflict } : {}),
  };
}

function hasUsefulMac(value?: string): boolean {
  const mac = value?.trim().toLowerCase();
  return !!mac && mac !== 'ff:ff:ff:ff:ff:ff';
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
  const mac = device.macAddress?.trim().toLowerCase();

  if (mac && mac !== 'ff:ff:ff:ff:ff:ff') {
    return `mac:${device.networkZoneId}:${mac}`;
  }

  if (device.vendor === 'Shelly' && device.id.toLowerCase().startsWith('shelly')) {
    return `shelly:${device.networkZoneId}:${device.id.toLowerCase()}`;
  }

  return networkEndpointIdentity(device);
}

function key(identity: string): string {
  return `known:${encodeURIComponent(identity)}`;
}

function isKnownDevice(value: unknown): value is KnownNetworkDevice {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<KnownNetworkDevice>;

  return record.schemaVersion === 1 &&
    typeof record.identity === 'string' &&
    typeof record.firstSeenAt === 'string' &&
    typeof record.lastSeenAt === 'string' &&
    typeof record.lastScanId === 'string' &&
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
  ): Promise<void> {
    const recordsByKey = new Map<string, KnownNetworkDevice>();
    for (const device of devices) {
      const identity = networkDiscoveryIdentity(device);
      const databaseKey = key(identity);
      const pending = recordsByKey.get(databaseKey);
      const previousValue = pending || await this.getOptional(databaseKey);
      const previous = isKnownDevice(previousValue)
        ? previousValue
        : null;

      const record: KnownNetworkDevice = {
        schemaVersion: 1,
        identity,
        firstSeenAt: previous?.firstSeenAt || scanId,
        lastSeenAt: scanId,
        lastScanId: scanId,
        device: structuredClone(previous
          ? mergeNetworkHistory(previous.device, device)
          : device),
      };

      recordsByKey.set(databaseKey, record);
    }

    const operations: Array<{
      type: 'put';
      key: string;
      value: unknown;
    }> = [...recordsByKey].map(([databaseKey, record]) => ({
      type: 'put',
      key: databaseKey,
      value: record,
    }));

    operations.push({
      type: 'put',
      key: 'meta:lastScanId',
      value: scanId,
    });

    await this.db.batch(operations);
  }

  async recordSnapshot(snapshot: NetworkDiscoverySnapshot): Promise<void> {
    const snapshotKey = `snapshot:${encodeURIComponent(snapshot.scanId)}`;
    if (await this.getOptional(snapshotKey) !== undefined) {
      throw new Error(`Discovery snapshot already exists: ${snapshot.scanId}`);
    }
    await this.db.put(snapshotKey, structuredClone(snapshot));
  }

  async getSnapshot(scanId: string): Promise<NetworkDiscoverySnapshot | null> {
    const value = await this.getOptional(`snapshot:${encodeURIComponent(scanId)}`);
    return isNetworkDiscoverySnapshot(value) ? value : null;
  }

  async listSnapshots(limit = 50): Promise<NetworkDiscoverySnapshot[]> {
    const snapshots: NetworkDiscoverySnapshot[] = [];
    for await (const [, value] of this.db.iterator({ gte: 'snapshot:', lt: 'snapshot:\uffff' })) {
      if (isNetworkDiscoverySnapshot(value)) snapshots.push(value);
    }
    return snapshots
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.scanId.localeCompare(a.scanId))
      .slice(0, Math.max(1, Math.min(Math.floor(limit), 100)));
  }

  /** Persist one independently verified endpoint without claiming a complete network scan. */
  async recordIdentityObservation(
    observedAt: string,
    device: NetworkDiscoveredDevice,
  ): Promise<void> {
    const identity = networkDiscoveryIdentity(device);
    const databaseKey = key(identity);
    const previousValue = await this.getOptional(databaseKey);
    const previous = isKnownDevice(previousValue) ? previousValue : null;
    const record: KnownNetworkDevice = {
      schemaVersion: 1,
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

  async list(): Promise<KnownNetworkDevice[]> {
    return dedupeKnownRecords(await this.listIdentityEvidence());
  }

  async listIdentityEvidence(): Promise<KnownNetworkDevice[]> {
    const records: KnownNetworkDevice[] = [];

    for await (const [, value] of this.db.iterator({
      gte: 'known:',
      lt: 'known:\uffff',
    })) {
      if (isKnownDevice(value)) records.push(value);
    }

    return records.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async summary(): Promise<DiscoveryMemorySummary> {
    const records = await this.list();
    const value = await this.getOptional('meta:lastScanId');
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
    Array.isArray(snapshot.scopes) &&
    Array.isArray(snapshot.rawEvidence) &&
    Array.isArray(snapshot.endpoints);
}
