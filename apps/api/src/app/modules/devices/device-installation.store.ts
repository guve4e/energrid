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

  /** Only return records belonging to this explicitly established tenant/site. */
  async list(scope: InstallationScope): Promise<DeviceInstallationRecord[]> {
    assertScope(scope);
    await this.ensureOpen();
    const records = new Map<string, DeviceInstallationRecord>();
    // Read legacy keys without assigning records to a different tenant.
    for await (const [, value] of this.db.iterator({
      gte: legacyInstallationKey(scope.siteId, ''),
      lt: legacyInstallationKey(scope.siteId, '\uffff'),
    })) {
      if (isInstallationRecord(value) && hasInstallationOwner(value, scope)) {
        records.set(value.device.id, value);
      }
    }
    // Versioned records win over legacy copies after the first write.
    const prefix = scopedInstallationPrefix(scope);
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: `${prefix}\uffff` })) {
      if (isInstallationRecord(value) && hasInstallationOwner(value, scope)) {
        records.set(value.device.id, value);
      }
    }
    return [...records.values()];
  }

  /** Internal bootstrap only. Callers must scope records before exposing them. */
  async listAll(): Promise<DeviceInstallationRecord[]> {
    await this.ensureOpen();
    const records = new Map<string, DeviceInstallationRecord>();
    for await (const [key, value] of this.db.iterator({ gte: 'installation:', lt: 'installation:\uffff' })) {
      if (!key.startsWith('installation:') || !isInstallationRecord(value)) continue;
      // Keep unowned legacy records visible to the offline migration inventory,
      // but never make them a match for a tenant-scoped read.
      records.set(installationIdentity(value), value);
    }
    for await (const [key, value] of this.db.iterator({ gte: 'installation-v2:', lt: 'installation-v2:\uffff' })) {
      if (!key.startsWith('installation-v2:') || !isInstallationRecord(value)) continue;
      records.set(installationIdentity(value), value);
    }
    return [...records.values()];
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

  async get(scope: InstallationScope, deviceId: string): Promise<DeviceInstallationRecord | null> {
    assertScope(scope);
    if (!deviceId?.trim()) return null;
    await this.ensureOpen();
    const scoped = await this.readInstallation(scopedInstallationKey(scope, deviceId));
    if (scoped) return hasInstallationOwner(scoped, scope) && scoped.device.id === deviceId ? scoped : null;
    const legacy = await this.readInstallation(legacyInstallationKey(scope.siteId, deviceId));
    return legacy && hasInstallationOwner(legacy, scope) && legacy.device.id === deviceId ? legacy : null;
  }

  async save(record: DeviceInstallationRecord): Promise<void> {
    const scope = { tenantId: record.device.tenantId, siteId: record.device.siteId };
    assertScope(scope);
    if (!record.device.id?.trim()) throw new Error('Device ID is required.');
    await this.ensureOpen();
    // Never rewrite or delete a legacy key without an audited migration.
    await this.db.put(scopedInstallationKey(scope, record.device.id), record);
  }

  private async readInstallation(key: string): Promise<DeviceInstallationRecord | null> {
    try {
      const value: unknown = await this.db.get(key);
      return isInstallationRecord(value) ? value : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async saveProposal(proposal: DeviceInstallationChangeProposal): Promise<void> {
    if (proposal.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(proposal.id) ||
        !proposal.deviceId.trim()) {
      throw new Error('Invalid installation proposal.');
    }
    const scope = { tenantId: proposal.tenantId, siteId: proposal.siteId };
    assertScope(scope);
    await this.ensureOpen();
    await this.db.put(scopedProposalKey(scope, proposal.id), proposal);
  }

  async getProposal(scope: InstallationScope, proposalId: string): Promise<DeviceInstallationChangeProposal | null> {
    assertScope(scope);
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) return null;
    await this.ensureOpen();
    const current = await this.readProposal(scopedProposalKey(scope, proposalId));
    if (current) return hasProposalOwner(current, scope) && current.id === proposalId ? current : null;
    const legacy = await this.readProposal(legacyProposalKey(scope.siteId, proposalId));
    return legacy && hasProposalOwner(legacy, scope) && legacy.id === proposalId ? legacy : null;
  }

  async listDeviceProposals(scope: InstallationScope, deviceId: string): Promise<DeviceInstallationChangeProposal[]> {
    assertScope(scope);
    if (!deviceId?.trim()) return [];
    await this.ensureOpen();
    const proposals = new Map<string, DeviceInstallationChangeProposal>();
    const addMatching = (value: unknown) => {
      if (!isInstallationProposal(value) || !hasProposalOwner(value, scope) ||
          value.deviceId !== deviceId) return;
      proposals.set(value.id, value);
    };
    const legacyPrefix = `installation-proposal:${scope.siteId}:`;
    for await (const [, value] of this.db.iterator({ gte: legacyPrefix, lt: `${legacyPrefix}\uffff` })) {
      addMatching(value);
    }
    const prefix = scopedProposalPrefix(scope);
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: `${prefix}\uffff` })) {
      addMatching(value);
    }
    return [...proposals.values()]
      .filter(proposal => proposal.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
  }

  private async readProposal(key: string): Promise<DeviceInstallationChangeProposal | null> {
    try {
      const value: unknown = await this.db.get(key);
      return isInstallationProposal(value) ? value : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
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

/** Tenant and site must originate from authorization/enrollment, not device payloads. */
export interface InstallationScope {
  tenantId: string;
  siteId: string;
}

function assertScope(scope: InstallationScope): void {
  if (!scope?.tenantId?.trim() || !scope?.siteId?.trim()) {
    throw new Error('Installation tenant and site are required.');
  }
}

function enc(value: string): string { return encodeURIComponent(value); }

function scopedInstallationPrefix(scope: InstallationScope): string {
  return `installation-v2:${enc(scope.tenantId)}:${enc(scope.siteId)}:`;
}

function scopedInstallationKey(scope: InstallationScope, deviceId: string): string {
  return `${scopedInstallationPrefix(scope)}${enc(deviceId)}`;
}

function legacyInstallationKey(siteId: string, deviceId: string): string {
  return `installation:${siteId}:${deviceId}`;
}

function scopedProposalPrefix(scope: InstallationScope): string {
  return `installation-proposal-v2:${enc(scope.tenantId)}:${enc(scope.siteId)}:`;
}

function scopedProposalKey(scope: InstallationScope, proposalId: string): string {
  return `${scopedProposalPrefix(scope)}${enc(proposalId)}`;
}

function legacyProposalKey(siteId: string, proposalId: string): string {
  return `installation-proposal:${siteId}:${proposalId}`;
}

function installationIdentity(record: DeviceInstallationRecord): string {
  return JSON.stringify([record.device.tenantId ?? null, record.device.siteId, record.device.id]);
}

function hasInstallationOwner(record: DeviceInstallationRecord, scope: InstallationScope): boolean {
  return record.device.tenantId === scope.tenantId && record.device.siteId === scope.siteId;
}

function hasProposalOwner(proposal: DeviceInstallationChangeProposal, scope: InstallationScope): boolean {
  return proposal.tenantId === scope.tenantId && proposal.siteId === scope.siteId;
}

function isInstallationProposal(value: unknown): value is DeviceInstallationChangeProposal {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DeviceInstallationChangeProposal>;
  return record.schemaVersion === 1 && typeof record.id === 'string' &&
    typeof record.tenantId === 'string' && typeof record.siteId === 'string' &&
    typeof record.deviceId === 'string' &&
    ['pending', 'approved', 'rejected'].includes(record.status || '') &&
    typeof record.createdAt === 'string' && typeof record.expiresAt === 'string' &&
    typeof record.installationUpdatedAt === 'string' &&
    !!record.current && !!record.proposed;
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
