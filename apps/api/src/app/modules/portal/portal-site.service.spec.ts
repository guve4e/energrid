import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceInstallationStore } from '../devices/device-installation.store';
import { PortalSiteService } from './portal-site.service';

describe('PortalSiteService', () => {
  let directory: string;
  let store: DeviceInstallationStore;
  let service: PortalSiteService;
  const admin = { userId: 'admin-1', role: 'admin' as const };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'energrid-portal-sites-'));
    store = new DeviceInstallationStore(directory);
    await store.onModuleInit();
    service = new PortalSiteService(store);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('offers only the explicitly configured Home and Virtual Device Lab sites', async () => {
    await expect(service.list(admin)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: 'tenant-demo', siteId: 'site-home', name: 'Home', explicitlyAuthorized: true }),
      expect.objectContaining({ tenantId: 'tenant-demo', siteId: 'site-device-lab', name: 'Virtual Device Lab', explicitlyAuthorized: true }),
    ]));
  });

  it('resolves a selected site from the authorized catalog and persists selection per administrator', async () => {
    await expect(service.select(admin, 'site-device-lab')).resolves.toEqual(expect.objectContaining({
      tenantId: 'tenant-demo', siteId: 'site-device-lab', name: 'Virtual Device Lab',
    }));
    await expect(service.forPrincipal(admin)).resolves.toEqual(expect.objectContaining({
      tenantId: 'tenant-demo', siteId: 'site-device-lab', siteName: 'Virtual Device Lab',
    }));

    await store.onModuleDestroy();
    store = new DeviceInstallationStore(directory);
    await store.onModuleInit();
    service = new PortalSiteService(store);
    await service.onModuleInit();
    await expect(service.forPrincipal(admin)).resolves.toEqual(expect.objectContaining({ siteId: 'site-device-lab' }));
  });

  it('rejects arbitrary site IDs and non-administrator selection', async () => {
    await expect(service.select(admin, 'site-other')).rejects.toThrow('Site is not authorized');
    await expect(service.select({ userId: 'viewer-1', role: 'viewer' }, 'site-device-lab'))
      .rejects.toThrow('Administrator access is required');
  });
});
