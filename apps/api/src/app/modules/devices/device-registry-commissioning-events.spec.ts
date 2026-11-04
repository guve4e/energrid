import { DeviceRegistryService } from './device-registry.service';
import type { DeviceInstallationRecord } from './device-installation.store';

describe('Scoped commissioning event writers', () => {
  const installation = (tenantId: string): DeviceInstallationRecord => ({
    schemaVersion: 1,
    device: { id: 'relay-1', tenantId, siteId: 'shared-site' } as DeviceInstallationRecord['device'],
    physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
    updatedAt: '2026-11-04T10:00:00.000Z',
  });

  it('requires explicit ownership when the same ID exists in two installations', async () => {
    const append = jest.fn().mockResolvedValue(undefined);
    const registry = Object.create(DeviceRegistryService.prototype) as DeviceRegistryService;
    Object.assign(registry, {
      installationStore: { append },
      persistedInstallations: new Map([
        ['tenant-a', installation('tenant-a')], ['tenant-b', installation('tenant-b')],
      ]),
    });
    await expect(registry.persistInstallationEvent('relay-1', 'command', { status: 'requested' }))
      .rejects.toThrow('one verified installation owner');
    expect(append).not.toHaveBeenCalled();
    await registry.persistInstallationEvent('relay-1', 'command', { status: 'requested' },
      'operator-1', { tenantId: 'tenant-a', siteId: 'shared-site' });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', siteId: 'shared-site', deviceId: 'relay-1', actor: 'operator-1',
    }));
    await expect(registry.persistInstallationEvent('relay-1', 'command', {}, 'operator-1',
      { tenantId: 'tenant-foreign', siteId: 'shared-site' }))
      .rejects.toThrow('one verified installation owner');
  });
});
