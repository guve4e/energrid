import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeviceAiInvestigationResult } from './device-ai-investigation.service';

export interface StoredDeviceInvestigation {
  schemaVersion: 1;
  id: string;
  deviceId: string;
  createdAt: string;
  result: DeviceAiInvestigationResult;
}

export const DEVICE_INVESTIGATION_STORE_DIRECTORY =
  'ENERGRID_INVESTIGATION_STORE_DIRECTORY';

function defaultDirectory(): string {
  return (
    process.env[DEVICE_INVESTIGATION_STORE_DIRECTORY]?.trim() ||
    join(homedir(), '.energrid', 'device-investigations')
  );
}

function recordKey(id: string): string {
  return `investigation:${id}`;
}

function deviceKey(deviceId: string, createdAt: string, id: string): string {
  return `device:${encodeURIComponent(deviceId)}:${createdAt}:${id}`;
}

@Injectable()
export class DeviceInvestigationHistoryStore implements OnModuleDestroy {
  private readonly db: ClassicLevel<string, StoredDeviceInvestigation | string>;

  constructor(
    @Optional()
    @Inject(DEVICE_INVESTIGATION_STORE_DIRECTORY)
    directory?: string,
  ) {
    this.db = new ClassicLevel(
      directory?.trim() || defaultDirectory(),
      { valueEncoding: 'json' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.close();
  }

  async save(
    result: DeviceAiInvestigationResult,
  ): Promise<StoredDeviceInvestigation> {
    const record: StoredDeviceInvestigation = {
      schemaVersion: 1,
      id: randomUUID(),
      deviceId: result.deviceId,
      createdAt: new Date().toISOString(),
      result: structuredClone(result),
    };

    // Both entries are written atomically.
    await this.db.batch([
      {
        type: 'put',
        key: recordKey(record.id),
        value: record,
      },
      {
        type: 'put',
        key: deviceKey(record.deviceId, record.createdAt, record.id),
        value: record.id,
      },
    ]);

    return record;
  }

  async get(id: string): Promise<StoredDeviceInvestigation | null> {
    try {
      const record = await this.db.get(recordKey(id));
      return record && typeof record !== 'string' ? record : null;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'LEVEL_NOT_FOUND'
      ) {
        return null;
      }
      throw error;
    }
  }

  async list(
    deviceId: string,
    limit = 50,
  ): Promise<StoredDeviceInvestigation[]> {
    const prefix = `device:${encodeURIComponent(deviceId)}:`;
    const records: StoredDeviceInvestigation[] = [];

    for await (const [, id] of this.db.iterator({
      gte: prefix,
      lt: `${prefix}\uffff`,
      reverse: true,
      limit: Math.min(200, Math.max(1, Math.floor(limit))),
    })) {
      if (typeof id !== 'string') continue;

      const record = await this.get(id);
      if (record) records.push(record);
    }

    return records;
  }
}
