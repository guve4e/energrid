import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RegisteredDevice } from './device-registry.types';
import type {
  ApprovedObservationBinding,
  ObservationAuthorityPolicy,
} from '@energrid/domain-devices';

export interface InstallationObservationAuthority {
  bindings: ApprovedObservationBinding[];
  policy: ObservationAuthorityPolicy;
  /** Exact broker endpoint reviewed for Shelly MQTT measurements. */
  broker?: string;
}

export interface DeviceInstallationRecord {
  schemaVersion: 1;
  device: RegisteredDevice;
  observationAuthority?: InstallationObservationAuthority;
  physicalOutcome: {
    status: 'not_confirmed' | 'confirmed';
    confirmedAt: string | null;
    confirmedBy: string | null;
  };
  updatedAt: string;
}

export interface DeviceInstallationChangeProposal {
  schemaVersion: 1;
  id: string;
  tenantId: string;
  siteId: string;
  deviceId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  expiresAt: string;
  installationUpdatedAt: string;
  current: {
    displayName: string;
    zoneName: string;
    loadType: string | null;
  };
  proposed: {
    displayName: string;
    zoneName: string;
    loadType: string | null;
  };
  decidedAt?: string;
}

export interface DeviceInstallationEvent {
  id: string;
  deviceId: string;
  kind: 'approved' | 'observation_authority_approved' | 'control_configured' | 'installation_details_saved' | 'command' | 'physical_outcome_confirmed' | 'shelly_identity_evidence_reconciled';
  occurredAt: string;
  actor: string;
  evidence: Record<string, string | number | boolean | null>;
}

export interface PortalSiteRecord {
  schemaVersion: 1;
  tenantId: string;
  siteId: string;
  name: string;
  mode: 'home' | 'away' | 'night';
  explicitlyAuthorized: true;
  createdAt: string;
}

export const DEVICE_INSTALLATION_STORE_DIRECTORY = Symbol(
  'DEVICE_INSTALLATION_STORE_DIRECTORY',
);

@Injectable()
export class DeviceInstallationStore implements OnModuleInit, OnModuleDestroy {
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

  async onModuleInit(): Promise<void> {
    await this.ensureOpen();
  }

  async list(siteId: string): Promise<DeviceInstallationRecord[]> {
    await this.ensureOpen();
    const records: DeviceInstallationRecord[] = [];
    for await (const [, value] of this.db.iterator({
      gte: installationKey(siteId, ''),
      lt: installationKey(siteId, '\uffff'),
    })) {
      if (isInstallationRecord(value)) records.push(value);
    }
    return records;
  }

  async listAll(): Promise<DeviceInstallationRecord[]> {
    await this.ensureOpen();
    const records: DeviceInstallationRecord[] = [];
    for await (const [key, value] of this.db.iterator({ gte: 'installation:', lt: 'installation;\uffff' })) {
      if (key.startsWith('installation:') && isInstallationRecord(value)) records.push(value);
    }
    return records;
  }

  async ensurePortalSite(input: Pick<PortalSiteRecord, 'tenantId' | 'siteId' | 'name' | 'mode'>): Promise<PortalSiteRecord> {
    await this.ensureOpen();
    const key = portalSiteKey(input.tenantId, input.siteId);
    try {
      const existing: unknown = await this.db.get(key);
      if (isPortalSiteRecord(existing)) return existing;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const record: PortalSiteRecord = { schemaVersion: 1, ...input, explicitlyAuthorized: true, createdAt: new Date().toISOString() };
    await this.db.put(key, record);
    return record;
  }

  async listPortalSites(): Promise<PortalSiteRecord[]> {
    await this.ensureOpen();
    const records: PortalSiteRecord[] = [];
    for await (const [key, value] of this.db.iterator({ gte: 'portal-site:', lt: 'portal-site;\uffff' })) {
      if (key.startsWith('portal-site:') && isPortalSiteRecord(value)) records.push(value);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  async setPortalSiteSelection(userId: string, tenantId: string, siteId: string): Promise<void> {
    await this.ensureOpen();
    await this.db.put(portalSiteSelectionKey(userId), { schemaVersion: 1, userId, tenantId, siteId, updatedAt: new Date().toISOString() });
  }

  async getPortalSiteSelection(userId: string): Promise<{ tenantId: string; siteId: string } | null> {
    await this.ensureOpen();
    try {
      const value = await this.db.get(portalSiteSelectionKey(userId)) as { schemaVersion?: number; tenantId?: string; siteId?: string };
      if (value?.schemaVersion !== 1 || !value.tenantId || !value.siteId) return null;
      return { tenantId: value.tenantId, siteId: value.siteId };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(siteId: string, deviceId: string): Promise<DeviceInstallationRecord | null> {
    await this.ensureOpen();
    try {
      const value: unknown = await this.db.get(installationKey(siteId, deviceId));
      return isInstallationRecord(value) ? value : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(record: DeviceInstallationRecord): Promise<void> {
    await this.ensureOpen();
    await this.db.put(installationKey(record.device.siteId, record.device.id), record);
  }

  async saveProposal(
    proposal: DeviceInstallationChangeProposal,
  ): Promise<void> {
    if (
      proposal.schemaVersion !== 1 ||
      !/^[0-9a-f-]{36}$/i.test(proposal.id) ||
      !proposal.tenantId.trim() ||
      !proposal.siteId.trim() ||
      !proposal.deviceId.trim()
    ) {
      throw new Error('Invalid installation proposal.');
    }
    await this.ensureOpen();
    await this.db.put(
      `installation-proposal:${proposal.siteId}:${proposal.id}`,
      proposal,
    );
  }

  async getProposal(
    siteId: string,
    proposalId: string,
  ): Promise<DeviceInstallationChangeProposal | null> {
    if (!siteId.trim() || !/^[0-9a-f-]{36}$/i.test(proposalId))
      return null;

    await this.ensureOpen();

    try {
      const value: unknown = await this.db.get(
        `installation-proposal:${siteId}:${proposalId}`,
      );

      if (!value || typeof value !== 'object') return null;

      const record = value as Partial<DeviceInstallationChangeProposal>;

      return record.schemaVersion === 1 &&
        record.id === proposalId &&
        record.siteId === siteId &&
        typeof record.tenantId === 'string' &&
        typeof record.deviceId === 'string' &&
        ['pending', 'approved', 'rejected'].includes(record.status || '') &&
        typeof record.createdAt === 'string' &&
        typeof record.expiresAt === 'string' &&
        typeof record.installationUpdatedAt === 'string' &&
        !!record.current &&
        !!record.proposed
          ? record as DeviceInstallationChangeProposal
          : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listDeviceProposals(
    siteId: string,
    deviceId: string,
  ): Promise<DeviceInstallationChangeProposal[]> {
    if (!siteId.trim() || !deviceId.trim()) return [];

    await this.ensureOpen();

    const prefix = `installation-proposal:${siteId}:`;
    const results: DeviceInstallationChangeProposal[] = [];

    for await (const [, value] of this.db.iterator({
      gte: prefix,
      lt: `${prefix}\uffff`,
    })) {
      if (!value || typeof value !== 'object') continue;

      const proposal = value as Partial<DeviceInstallationChangeProposal>;

      if (
        proposal.schemaVersion !== 1 ||
        proposal.siteId !== siteId ||
        proposal.deviceId !== deviceId ||
        typeof proposal.tenantId !== 'string' ||
        typeof proposal.id !== 'string' ||
        typeof proposal.createdAt !== 'string' ||
        typeof proposal.expiresAt !== 'string' ||
        proposal.status !== 'pending' ||
        !proposal.current ||
        !proposal.proposed
      ) continue;

      results.push(proposal as DeviceInstallationChangeProposal);
    }

    return results
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
  }

  async append(event: DeviceInstallationEvent): Promise<void> {
    await this.ensureOpen();
    await this.db.put(`event:${event.deviceId}:${event.id}`, event);
  }

  async events(deviceId: string, limit = 100): Promise<DeviceInstallationEvent[]> {
    await this.ensureOpen();
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

  private async ensureOpen(): Promise<void> {
    if (this.db.status !== 'open') await this.db.open();
  }
}

function deviceStoreDirectory(): string {
  return process.env.HOME_DEVICE_STORE_DIRECTORY?.trim() ||
    join(homedir(), '.energrid', 'device-registry');
}

function installationKey(siteId: string, deviceId: string): string {
  return `installation:${siteId}:${deviceId}`;
}

function portalSiteKey(tenantId: string, siteId: string): string {
  return `portal-site:${encodeURIComponent(tenantId)}:${encodeURIComponent(siteId)}`;
}

function portalSiteSelectionKey(userId: string): string {
  return `portal-site-selection:${encodeURIComponent(userId)}`;
}

function isPortalSiteRecord(value: unknown): value is PortalSiteRecord {
  if (!value || typeof value !== 'object') return false;
  const site = value as Partial<PortalSiteRecord>;
  return site.schemaVersion === 1 && site.explicitlyAuthorized === true &&
    typeof site.tenantId === 'string' && typeof site.siteId === 'string' &&
    typeof site.name === 'string' && ['home', 'away', 'night'].includes(site.mode || '') &&
    typeof site.createdAt === 'string';
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
