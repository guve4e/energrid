import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RegisteredDevice } from './device-registry.types';

export interface DeviceInstallationRecord {
  schemaVersion: 1;
  device: RegisteredDevice;
  physicalOutcome: {
    status: 'not_confirmed' | 'confirmed';
    confirmedAt: string | null;
    confirmedBy: string | null;
  };
  updatedAt: string;
}

export interface DeviceInstallationEvent {
  id: string;
  deviceId: string;
  kind: 'approved' | 'control_configured' | 'installation_details_saved' | 'command' | 'physical_outcome_confirmed';
  occurredAt: string;
  actor: string;
  evidence: Record<string, string | number | boolean | null>;
}

export const DEVICE_INSTALLATION_STORE_DIRECTORY = Symbol(
  'DEVICE_INSTALLATION_STORE_DIRECTORY',
);

@Injectable()
export class DeviceInstallationStore implements OnModuleDestroy {
  private readonly db: ClassicLevel<string, unknown>;

  constructor(
    @Optional()
    @Inject(DEVICE_INSTALLATION_STORE_DIRECTORY)
    directory?: string,
  ) {
    this.db = new ClassicLevel(directory?.trim() || deviceStoreDirectory(), {
      valueEncoding: 'json',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.close();
  }

  async list(siteId: string): Promise<DeviceInstallationRecord[]> {
    const records: DeviceInstallationRecord[] = [];
    for await (const [, value] of this.db.iterator({
      gte: installationKey(siteId, ''),
      lt: installationKey(siteId, '\uffff'),
    })) {
      if (isInstallationRecord(value)) records.push(value);
    }
    return records;
  }

  async get(siteId: string, deviceId: string): Promise<DeviceInstallationRecord | null> {
    try {
      const value: unknown = await this.db.get(installationKey(siteId, deviceId));
      return isInstallationRecord(value) ? value : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(record: DeviceInstallationRecord): Promise<void> {
    await this.db.put(installationKey(record.device.siteId, record.device.id), record);
  }

  async append(event: DeviceInstallationEvent): Promise<void> {
    await this.db.put(`event:${event.deviceId}:${event.id}`, event);
  }

  async events(deviceId: string, limit = 100): Promise<DeviceInstallationEvent[]> {
    const items: DeviceInstallationEvent[] = [];
    for await (const [, value] of this.db.iterator({
      gte: `event:${deviceId}:`,
      lt: `event:${deviceId}:\uffff`,
      reverse: true,
      limit: Math.min(500, Math.max(1, Math.floor(limit))),
    })) {
      if (isInstallationEvent(value)) items.push(value);
    }
    return items;
  }
}

function deviceStoreDirectory(): string {
  return process.env.HOME_DEVICE_STORE_DIRECTORY?.trim() ||
    join(homedir(), '.energrid', 'device-registry');
}

function installationKey(siteId: string, deviceId: string): string {
  return `installation:${siteId}:${deviceId}`;
}

function isInstallationRecord(value: unknown): value is DeviceInstallationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DeviceInstallationRecord>;
  return record.schemaVersion === 1 && !!record.device &&
    typeof record.device.id === 'string' && typeof record.device.siteId === 'string' &&
    !!record.physicalOutcome &&
    ['not_confirmed', 'confirmed'].includes(record.physicalOutcome.status);
}

function isInstallationEvent(value: unknown): value is DeviceInstallationEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<DeviceInstallationEvent>;
  return typeof event.id === 'string' && typeof event.deviceId === 'string' &&
    typeof event.kind === 'string' && typeof event.occurredAt === 'string' &&
    typeof event.actor === 'string' && !!event.evidence;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: string }).code === 'LEVEL_NOT_FOUND';
}
