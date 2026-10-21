import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { RegisteredDevice } from './device-registry.types';
import {
  DeviceInstallationStore,
  DEVICE_INSTALLATION_STORE_DIRECTORY,
} from './device-installation.store';

describe('DeviceInstallationStore', () => {
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

    await expect(store.list('site-home')).resolves.toEqual([]);
  });

  it('keeps installation identity and physical confirmation separate from device state', async () => {
    const device = {
      id: 'shellyplus1-aabbccddeeff:switch:0',
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

    await expect(store.get('site-home', device.id)).resolves.toEqual(
      expect.objectContaining({
        device,
        physicalOutcome: expect.objectContaining({
          status: 'confirmed',
          confirmedBy: 'installer-1',
        }),
      }),
    );
    await expect(store.list('another-site')).resolves.toEqual([]);
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

  it('preserves records across store instances', async () => {
    const record = {
      schemaVersion: 1 as const,
      device: { id: 'relay', siteId: 'site-home' } as RegisteredDevice,
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
    await expect(store.get('site-home', 'relay')).resolves.toEqual(record);
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
