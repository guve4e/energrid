import type { DeviceEnrollmentService } from './enrollment/device-enrollment.service';
import type { DeviceInstallationStore } from './device-installation.store';
import { DeviceRegistryService } from './device-registry.service';

describe('DeviceRegistryService enrollment lifecycle projection', () => {
  it('does not restore a stale approved installation after restart when PostgreSQL says retired', async () => {
    const record = {
      schemaVersion: 1,
      device: {
        id: 'temp-kitchen', tenantId: 'tenant-demo', siteId: 'site-home',
        siteName: 'Home', displayName: 'Kitchen temperature', kind: 'physical',
        adapter: { protocol: 'mqtt', transport: 'mqtt', driver: 'legacy', target: 'devices/temp-kitchen/data' },
        capabilities: [{ kind: 'temperature', actions: ['read'] }],
        trustStatus: 'approved', assistantEnabled: false, commissioning: undefined,
        discovery: undefined, state: { values: {}, observedAt: null, source: 'store', status: 'unknown' },
        metadata: {}, policy: {},
      },
      physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
      updatedAt: '2026-10-20T06:00:00.000Z',
    } as any;
    const installationStore = {
      list: jest.fn().mockResolvedValue([record]),
    } as unknown as DeviceInstallationStore;
    const enrollment = {
      list: jest.fn().mockResolvedValue([{ deviceId: 'temp-kitchen', status: 'retired' }]),
    } as unknown as DeviceEnrollmentService;
    const registry = new DeviceRegistryService(undefined, installationStore, enrollment);

    await registry.onModuleInit();

    expect(registry.getDevices().some(device => device.id === 'temp-kitchen')).toBe(false);
    expect(registry.isEnrollmentRetired('temp-kitchen')).toBe(true);
    expect(registry.registerDiscoveredDevice({
      id: 'temp-kitchen', tenantId: 'tenant-demo', siteId: 'site-home',
      displayName: 'MQTT source temp-kitchen', source: 'mqtt', protocol: 'mqtt',
      target: 'devices/temp-kitchen/data',
      metadata: { mqttEvidenceCandidate: true },
    })).toBe(true);

    expect(registry.getDevices().find(device => device.id === 'temp-kitchen')).toEqual(
      expect.objectContaining({
        trustStatus: 'discovered',
        metadata: expect.objectContaining({ previouslyEnrolledRetired: true }),
      }),
    );
  });

  it('keeps an enrolled persisted installation approved and reflects retirement immediately', async () => {
    const device = {
      id: 'temp-garage', tenantId: 'tenant-demo', siteId: 'site-home',
      displayName: 'Garage temperature', kind: 'physical', trustStatus: 'approved',
      adapter: { protocol: 'mqtt', transport: 'mqtt', driver: 'legacy', target: 'devices/temp-garage/data' },
      capabilities: [{ kind: 'temperature', actions: ['read'] }], state: { values: {} }, metadata: {},
    };
    const registry = new DeviceRegistryService(undefined, {
      list: jest.fn().mockResolvedValue([{
        schemaVersion: 1, device,
        physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
        updatedAt: '2026-10-20T06:00:00.000Z',
      }]),
    } as any, {
      list: jest.fn().mockResolvedValue([{ deviceId: 'temp-garage', status: 'enrolled' }]),
    } as any);

    await registry.onModuleInit();
    expect(registry.getDevices().find(item => item.id === 'temp-garage')?.trustStatus).toBe('approved');

    registry.setEnrollmentStatus('temp-garage', 'retired');
    expect(registry.getDevices().some(item => item.id === 'temp-garage')).toBe(false);
    registry.setEnrollmentStatus('temp-garage', 'enrolled');
    expect(registry.getDevices().find(item => item.id === 'temp-garage')?.trustStatus).toBe('approved');
  });
});
