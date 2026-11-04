import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ClassicLevel } from 'classic-level';
import type { RegisteredDevice } from './device-registry.types';
import {
  DeviceInstallationStore,
  DEVICE_INSTALLATION_STORE_DIRECTORY,
} from './device-installation.store';

describe('DeviceInstallationStore', () => {
  const home = { tenantId: 'tenant-demo', siteId: 'site-home' };
  let directory: string;
  let store: DeviceInstallationStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'energrid-device-store-'));
    store = new DeviceInstallationStore(directory);
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('waits for LevelDB to open before startup reads installation records', async () => {
    await store.onModuleInit();

    await expect(store.list(home)).resolves.toEqual([]);
  });

  it('keeps installation identity and physical confirmation separate from device state', async () => {
    const device = {
      id: 'shellyplus1-aabbccddeeff:switch:0',
      tenantId: home.tenantId,
      siteId: 'site-home',
      displayName: 'Hall light',
    } as RegisteredDevice;
    await store.save({
      schemaVersion: 1,
      device,
      physicalOutcome: {
        status: 'confirmed',
        confirmedAt: '2026-10-16T10:00:00.000Z',
        confirmedBy: 'installer-1',
      },
      updatedAt: '2026-10-16T10:00:00.000Z',
    });

    await expect(store.get(home, device.id)).resolves.toEqual(
      expect.objectContaining({
        device,
        physicalOutcome: expect.objectContaining({
          status: 'confirmed',
          confirmedBy: 'installer-1',
        }),
      }),
    );
    await expect(store.list({ tenantId: 'tenant-demo', siteId: 'another-site' })).resolves.toEqual([]);
  });

  it('appends commissioning evidence and reads newest events first', async () => {
    for (const [id, kind] of [
      ['2026-10-16T10:00:00.000Z-a', 'approved'],
      ['2026-10-16T10:01:00.000Z-b', 'command'],
    ] as const) {
      await store.append({
        id,
        deviceId: 'relay',
        kind,
        occurredAt: id.slice(0, 24),
        actor: 'installer',
        evidence: { status: kind === 'command' ? 'pending' : 'approved' },
      });
    }

    await expect(store.events('relay', 1)).resolves.toEqual([
      expect.objectContaining({ kind: 'command' }),
    ]);
  });

  it('does not overwrite installations when tenants reuse a site ID and device ID', async () => {
    const installationFor = (tenantId: string) => ({
      schemaVersion: 1 as const,
      device: {
        id: 'relay-1',
        tenantId,
        siteId: 'site-shared',
        displayName: `${tenantId} relay`,
      } as RegisteredDevice,
      physicalOutcome: {
        status: 'not_confirmed' as const,
        confirmedAt: null,
        confirmedBy: null,
      },
      updatedAt: '2026-11-04T10:00:00.000Z',
    });

    await store.save(installationFor('tenant-a'));
    await store.save(installationFor('tenant-b'));

    const records = await store.listAll();
    expect(records.map(record => record.device.tenantId).sort()).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    const a = { tenantId: 'tenant-a', siteId: 'site-shared' };
    const b = { tenantId: 'tenant-b', siteId: 'site-shared' };
    expect((await store.get(a, 'relay-1'))?.device.tenantId).toBe('tenant-a');
    expect((await store.get(b, 'relay-1'))?.device.tenantId).toBe('tenant-b');
    expect((await store.list(a)).map(record => record.device.tenantId)).toEqual(['tenant-a']);
    expect((await store.list(b)).map(record => record.device.tenantId)).toEqual(['tenant-b']);
  });

  it('does not overwrite proposals when tenants reuse a site ID and proposal ID', async () => {
    const proposalFor = (tenantId: string) => ({
      schemaVersion: 1 as const,
      id: '00000000-0000-4000-8000-000000000001',
      tenantId,
      siteId: 'site-shared',
      deviceId: 'relay-1',
      status: 'pending' as const,
      createdAt: '2026-11-04T10:00:00.000Z',
      expiresAt: '2026-11-05T10:00:00.000Z',
      installationUpdatedAt: '2026-11-04T09:00:00.000Z',
      current: { displayName: 'Relay', zoneName: 'Living room', loadType: 'lighting' },
      proposed: { displayName: 'Relay', zoneName: 'Hall', loadType: 'lighting' },
    });

    await store.saveProposal(proposalFor('tenant-a'));
    await store.saveProposal(proposalFor('tenant-b'));

    const a = { tenantId: 'tenant-a', siteId: 'site-shared' };
    const b = { tenantId: 'tenant-b', siteId: 'site-shared' };
    await expect(store.listDeviceProposals(a, 'relay-1')).resolves.toEqual([
      expect.objectContaining({ tenantId: 'tenant-a' }),
    ]);
    await expect(store.listDeviceProposals(b, 'relay-1')).resolves.toEqual([
      expect.objectContaining({ tenantId: 'tenant-b' }),
    ]);
    await expect(store.getProposal(a, proposalFor('tenant-a').id)).resolves.toEqual(
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
    await expect(store.getProposal(b, proposalFor('tenant-b').id)).resolves.toEqual(
      expect.objectContaining({ tenantId: 'tenant-b' }),
    );
  });

  it('preserves records across store instances', async () => {
    const record = {
      schemaVersion: 1 as const,
      device: { id: 'relay', tenantId: home.tenantId, siteId: home.siteId } as RegisteredDevice,
      physicalOutcome: {
        status: 'not_confirmed' as const,
        confirmedAt: null,
        confirmedBy: null,
      },
      updatedAt: '2026-10-16T10:00:00.000Z',
    };
    await store.save(record);
    await store.onModuleDestroy();

    store = new DeviceInstallationStore(directory);
    await expect(store.get(home, 'relay')).resolves.toEqual(record);
  });

  it('reads matching legacy installation records without copying them to another tenant', async () => {
    await store.onModuleDestroy();
    const legacy: ClassicLevel<string, unknown> = new ClassicLevel(directory, { valueEncoding: 'json' });
    await legacy.open();
    const record = {
      schemaVersion: 1 as const,
      device: { id: 'relay', tenantId: 'tenant-a', siteId: 'site-shared' } as RegisteredDevice,
      physicalOutcome: { status: 'confirmed' as const, confirmedAt: '2026-10-16T10:00:00.000Z', confirmedBy: 'installer' },
      updatedAt: '2026-10-16T10:00:00.000Z',
    };
    await legacy.put('installation:site-shared:relay', record);
    await legacy.put('installation:site-shared:unowned', {
      ...record, device: { id: 'unowned', siteId: 'site-shared' },
    });
    await legacy.close();
    store = new DeviceInstallationStore(directory);
    await expect(store.get({ tenantId: 'tenant-a', siteId: 'site-shared' }, 'relay')).resolves.toEqual(record);
    await expect(store.get({ tenantId: 'tenant-b', siteId: 'site-shared' }, 'relay')).resolves.toBeNull();
    await expect(store.list({ tenantId: 'tenant-b', siteId: 'site-shared' })).resolves.toEqual([]);
    await expect(store.get({ tenantId: 'tenant-a', siteId: 'site-shared' }, 'unowned')).resolves.toBeNull();

    const updated = { ...record, updatedAt: '2026-11-04T10:00:00.000Z' };
    await store.save(updated);
    await expect(store.get({ tenantId: 'tenant-a', siteId: 'site-shared' }, 'relay')).resolves.toEqual(updated);
    expect(await store.listAll()).toEqual(expect.arrayContaining([updated]));
    expect(await store.listAll()).toHaveLength(2);
    await store.onModuleDestroy();
    store = new DeviceInstallationStore(directory);
    await expect(store.get({ tenantId: 'tenant-a', siteId: 'site-shared' }, 'relay')).resolves.toEqual(updated);
  });

  it('reads only owner-matched legacy proposals while retaining new scoped proposals', async () => {
    await store.onModuleDestroy();
    const legacy: ClassicLevel<string, unknown> = new ClassicLevel(directory, { valueEncoding: 'json' });
    await legacy.open();
    const proposal = {
      schemaVersion: 1 as const,
      id: '00000000-0000-4000-8000-000000000002',
      tenantId: 'tenant-a', siteId: 'site-shared', deviceId: 'relay',
      status: 'pending' as const, createdAt: '2026-11-04T10:00:00.000Z',
      expiresAt: '2026-11-05T10:00:00.000Z', installationUpdatedAt: '2026-11-04T09:00:00.000Z',
      current: { displayName: 'Relay', zoneName: 'Hall', loadType: null },
      proposed: { displayName: 'Relay', zoneName: 'Kitchen', loadType: null },
    };
    await legacy.put(`installation-proposal:site-shared:${proposal.id}`, proposal);
    await legacy.close();
    store = new DeviceInstallationStore(directory);
    const a = { tenantId: 'tenant-a', siteId: 'site-shared' };
    const b = { tenantId: 'tenant-b', siteId: 'site-shared' };
    await expect(store.getProposal(a, proposal.id)).resolves.toEqual(proposal);
    await expect(store.getProposal(b, proposal.id)).resolves.toBeNull();
    await expect(store.listDeviceProposals(b, 'relay')).resolves.toEqual([]);
    await store.saveProposal({ ...proposal, status: 'rejected', decidedAt: '2026-11-04T11:00:00.000Z' });
    await expect(store.getProposal(a, proposal.id)).resolves.toEqual(expect.objectContaining({ status: 'rejected' }));
    await expect(store.listDeviceProposals(a, 'relay')).resolves.toEqual([]);
  });

  it('fails closed for missing ownership when creating installations', async () => {
    await expect(store.save({
      schemaVersion: 1,
      device: { id: 'relay', siteId: 'site-home' } as RegisteredDevice,
      physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
      updatedAt: new Date().toISOString(),
    })).rejects.toThrow('Installation tenant and site are required');
  });

  it('resolves through Nest using the configured directory token', async () => {
    const module = await Test.createTestingModule({
      providers: [
        DeviceInstallationStore,
        {
          provide: DEVICE_INSTALLATION_STORE_DIRECTORY,
          useValue: join(directory, 'nest-store'),
        },
      ],
    }).compile();

    expect(module.get(DeviceInstallationStore)).toBeInstanceOf(
      DeviceInstallationStore,
    );
    await module.close();
  });
});
