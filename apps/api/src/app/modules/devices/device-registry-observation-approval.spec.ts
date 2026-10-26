import { DeviceRegistryService } from './device-registry.service';

const tenantId = 'tenant-demo';
const siteId = 'site-home';
const deviceId = 'device:eero-lan:esp8266:324b44';
const device = {
  id: deviceId, tenantId, siteId, kind: 'physical', trustStatus: 'approved',
  adapter: { protocol: 'http', driver: 'energrid-esp8266', configured: false },
  metadata: { physicalId: 'esp8266:324b44', networkScope: 'eero-lan' },
};

function registry(observationAuthority?: unknown) {
  const record = { schemaVersion: 1, device, observationAuthority, physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null }, updatedAt: '2026-10-24T00:00:00.000Z' };
  const installationStore = { save: jest.fn(async () => undefined), append: jest.fn(async () => undefined) };
  const enrollment = { find: jest.fn(async () => ({ status: 'enrolled' })) };
  const instance = Object.assign(Object.create(DeviceRegistryService.prototype), {
    ensureInstallationsLoaded: jest.fn(async () => undefined),
    getDevices: jest.fn(() => [device]),
    persistedInstallations: new Map([[
      `${encodeURIComponent(tenantId)}:${encodeURIComponent(siteId)}:${encodeURIComponent(deviceId)}`,
      record,
    ]]),
    installationStore,
    enrollment,
  }) as DeviceRegistryService;
  return { instance, installationStore, record, enrollment };
}

describe('scoped Energrid observation approval', () => {
  it('presents a read-only two-field proposal for the enrolled second ESP8266', async () => {
    const h = registry();
    await expect(h.instance.getEnergridObservationApproval(tenantId, siteId, deviceId)).resolves.toEqual({
      approved: false,
      approvalStatus: 'missing',
      sourceId: 'energrid-http-status',
      selector: '/api/v1/status',
      fields: [
        { metric: 'temperature', rawKey: 'temperatureC', unit: 'Cel', displayUnit: '°C' },
        { metric: 'humidity', rawKey: 'humidityPct', unit: '%RH', displayUnit: '%RH' },
      ],
    });
    expect(h.installationStore.save).not.toHaveBeenCalled();
  });

  it('persists only the exact authority after an explicit approval request and is idempotent', async () => {
    const h = registry();
    const result = await h.instance.approveEnergridObservations(tenantId, siteId, deviceId, 'admin@example.test');
    expect(result).toMatchObject({ approved: true, approvalStatus: 'approved', sourceId: 'energrid-http-status', selector: '/api/v1/status' });
    expect(h.installationStore.save).toHaveBeenCalledTimes(1);
    const saved = h.installationStore.save.mock.calls[0][0] as typeof h.record;
    expect(saved.observationAuthority).toEqual({
      bindings: [{
        deviceId,
        sourceId: 'energrid-http-status',
        selector: '/api/v1/status',
        fields: {
          temperature: { rawKey: 'temperatureC', type: 'number' },
          humidity: { rawKey: 'humidityPct', type: 'number' },
        },
      }],
      policy: {
        deviceId,
        allowedSourcesByField: {
          temperature: ['energrid-http-status'],
          humidity: ['energrid-http-status'],
        },
      },
    });
    expect(saved.observationAuthority).not.toHaveProperty('control');
    await h.instance.approveEnergridObservations(tenantId, siteId, deviceId, 'admin@example.test');
    expect(h.installationStore.save).toHaveBeenCalledTimes(1);
  });

  it('fails closed for another tenant/site, unenrolled devices, and conflicting authority', async () => {
    const h = registry({ bindings: [], policy: { deviceId, allowedSourcesByField: {} } });
    await expect(h.instance.getEnergridObservationApproval('other-tenant', siteId, deviceId)).resolves.toBeNull();
    await expect(h.instance.getEnergridObservationApproval(tenantId, siteId, deviceId)).resolves.toMatchObject({
      approved: false, approvalStatus: 'different_authority',
    });
    h.enrollment.find.mockResolvedValueOnce(null as never);
    await expect(h.instance.getEnergridObservationApproval(tenantId, siteId, deviceId)).resolves.toBeNull();
    await expect(h.instance.approveEnergridObservations(tenantId, siteId, deviceId, 'admin@example.test'))
      .rejects.toThrow('different observation authority');
    expect(h.installationStore.save).not.toHaveBeenCalled();
  });
});
