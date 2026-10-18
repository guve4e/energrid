import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NetworkDiscoveredDevice } from './device-registry.types';

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

function identityOf(device: NetworkDiscoveredDevice): string {
  const mac = device.macAddress?.trim().toLowerCase();

  if (mac && mac !== 'ff:ff:ff:ff:ff:ff') {
    return `mac:${mac}`;
  }

  if (device.vendor === 'Shelly' && device.id.toLowerCase().startsWith('shelly')) {
    return `shelly:${device.id.toLowerCase()}`;
  }

  return `endpoint:${device.networkZoneId}:${device.ipAddress}`;
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
    const operations: Array<{
      type: 'put';
      key: string;
      value: unknown;
    }> = [];

    for (const device of devices) {
      const identity = identityOf(device);
      const previousValue = await this.getOptional(key(identity));
      const previous = isKnownDevice(previousValue)
        ? previousValue
        : null;

      const record: KnownNetworkDevice = {
        schemaVersion: 1,
        identity,
        firstSeenAt: previous?.firstSeenAt || scanId,
        lastSeenAt: scanId,
        lastScanId: scanId,
        device: structuredClone(device),
      };

      operations.push({
        type: 'put',
        key: key(identity),
        value: record,
      });
    }

    operations.push({
      type: 'put',
      key: 'meta:lastScanId',
      value: scanId,
    });

    await this.db.batch(operations);
  }

  async list(): Promise<KnownNetworkDevice[]> {
    const records: KnownNetworkDevice[] = [];

    for await (const [, value] of this.db.iterator({
      gte: 'known:',
      lt: 'known:\uffff',
    })) {
      if (isKnownDevice(value)) records.push(value);
    }

    return records.sort((a, b) =>
      b.lastSeenAt.localeCompare(a.lastSeenAt)
    );
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
