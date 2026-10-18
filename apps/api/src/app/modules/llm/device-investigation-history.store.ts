import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeviceAiInvestigationResult } from './device-ai-investigation.service';
import type { ObservationProfileProposal } from './observation-profile-proposal';
import type { DeviceProfileReplayReport } from './device-profile-replay-validator';

export interface StoredDeviceInvestigation {
  schemaVersion: 1;
  id: string;
  deviceId: string;
  createdAt: string;
  result: DeviceAiInvestigationResult;
}

export interface ProfileInvestigationScope {
  tenantId: string;
  siteId: string;
}

export interface DeviceProfileInvestigationOutcome {
  provider: string;
  model: string;
  proposal: ObservationProfileProposal;
  replay: DeviceProfileReplayReport;
}

export interface StoredDeviceProfileInvestigation {
  schemaVersion: 1;
  kind: 'mqtt-observation-profile';
  id: string;
  deviceId: string;
  tenantId: string;
  siteId: string;
  createdAt: string;
  result: DeviceProfileInvestigationOutcome;
}

function profilePrefix(
  scope: ProfileInvestigationScope,
  deviceId: string,
): string {
  return [
    'profile-device',
    encodeURIComponent(scope.tenantId),
    encodeURIComponent(scope.siteId),
    encodeURIComponent(deviceId),
    '',
  ].join(':');
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
  private readonly db: ClassicLevel<
    string,
    StoredDeviceInvestigation | StoredDeviceProfileInvestigation | string
  >;

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

  /**
   * Save an AI-generated profile investigation.
   * This operation NEVER approves or installs a device profile.
   */
  async saveProfile(
    scope: ProfileInvestigationScope,
    result: DeviceProfileInvestigationOutcome,
  ): Promise<StoredDeviceProfileInvestigation> {
    if (
      !scope?.tenantId?.trim() ||
      !scope?.siteId?.trim() ||
      !result?.proposal?.deviceId?.trim() ||
      result.proposal.status !== 'proposed' ||
      result.proposal.requiresApproval !== true ||
      result.replay.profileStatus !== 'proposed' ||
      result.replay.installationAuthorized !== false
    ) {
      throw new Error('Invalid profile investigation result');
    }

    const record: StoredDeviceProfileInvestigation = {
      schemaVersion: 1,
      kind: 'mqtt-observation-profile',
      id: randomUUID(),
      deviceId: result.proposal.deviceId,
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      createdAt: new Date().toISOString(),
      result: structuredClone(result),
    };

    const indexKey =
      profilePrefix(scope, record.deviceId) +
      record.createdAt + ':' + record.id;

    await this.db.batch([
      {
        type: 'put',
        key: `profile-investigation:${record.id}`,
        value: record,
      },
      {
        type: 'put',
        key: indexKey,
        value: record.id,
      },
    ]);

    return record;
  }

  async getProfileForDevice(
    scope: ProfileInvestigationScope,
    deviceId: string,
    investigationId: string,
  ): Promise<StoredDeviceProfileInvestigation | null> {
    let record:
      | StoredDeviceInvestigation
      | StoredDeviceProfileInvestigation
      | string
      | undefined;

    try {
      record = await this.db.get(
        `profile-investigation:${investigationId}`,
      );
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

    if (
      !record ||
      typeof record === 'string' ||
      !('kind' in record) ||
      record.kind !== 'mqtt-observation-profile' ||
      record.deviceId !== deviceId ||
      record.tenantId !== scope.tenantId ||
      record.siteId !== scope.siteId
    ) {
      return null;
    }

    return record;
  }

  async listProfiles(
    scope: ProfileInvestigationScope,
    deviceId: string,
    limit = 50,
  ): Promise<StoredDeviceProfileInvestigation[]> {
    const prefix = profilePrefix(scope, deviceId);
    const records: StoredDeviceProfileInvestigation[] = [];

    for await (const [, id] of this.db.iterator({
      gte: prefix,
      lt: `${prefix}\\uffff`,
      reverse: true,
      limit: Math.min(200, Math.max(1, Math.floor(limit))),
    })) {
      if (typeof id !== 'string') continue;

      const record = await this.getProfileForDevice(
        scope,
        deviceId,
        id,
      );

      if (record) records.push(record);
    }

    return records;
  }

  async get(id: string): Promise<StoredDeviceInvestigation | null> {
    try {
      const record = await this.db.get(recordKey(id));
      return record &&
        typeof record !== 'string' &&
        !('kind' in record)
          ? record
          : null;
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
