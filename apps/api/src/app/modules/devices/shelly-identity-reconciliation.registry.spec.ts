import { DeviceRegistryService } from './device-registry.service';

const physicalId = 'shellypro2pm-ec6260888084';
const component = 'switch:0';
const deviceId = `${physicalId}:${component}`;
const observedAt = new Date().toISOString();

function setup(siteId = 'site-home') {
  const device = {
    id: deviceId, tenantId: 'tenant-demo', siteId, siteName: siteId === 'site-home' ? 'Home' : 'Virtual Device Lab',
    displayName: 'Washer / bathroom fan', kind: 'physical', trustStatus: 'approved', zoneId: 'bathroom', zoneName: 'Bathroom',
    adapter: { id: 'mqtt', protocol: 'mqtt', transport: 'mqtt', driver: 'shelly-discovered', configured: true, target: 'shelly/washer@other' },
    capabilities: [{ kind: 'switch', actions: ['read'] }], supportedCapabilities: [{ kind: 'switch', actions: ['read'] }],
    state: { values: { output: false }, observedAt, source: 'mqtt', status: 'online' },
    responseProfile: { confidence: 0.8, learningEnabled: false }, policy: { requiresApproval: true, confirmationRequiredFor: [] },
    metadata: { physicalId, component, physicalInventoryId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9', mqttEvidenceCandidate: true },
  };
  const record = { schemaVersion: 1, device, observationAuthority: undefined,
    physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null }, updatedAt: observedAt };
  const records = new Map([[`${siteId}:${deviceId}`, record]]);
  const store = {
    listAll: jest.fn().mockResolvedValue([record]),
    save: jest.fn(async (next: any) => { records.set(`${next.device.siteId}:${next.device.id}`, next); }),
    append: jest.fn().mockResolvedValue(undefined),
  };
  const enrollment = {
    list: jest.fn().mockResolvedValue([{ deviceId, status: 'enrolled' }]),
    find: jest.fn().mockResolvedValue({ deviceId, status: 'enrolled' }),
  };
  return { registry: new DeviceRegistryService(undefined, store as any, enrollment as any), store, record, device };
}

const evidence = (siteId = 'site-home') => ({
  tenantId: 'tenant-demo', siteId, deviceId, physicalId, component,
  evidenceScanId: 'site-observer-12345678', observerId: 'pi-housenet', ipAddress: '192.168.1.166',
  networkScope: 'upstream-lan:192.168.1.0/24', identityVerifiedAt: observedAt, componentVerifiedAt: observedAt,
  verifiedMeasurementFields: ['power', 'energy_import_total'],
});

describe('site-scoped Shelly enrollment reconciliation', () => {
  it('adds fresh verified identity evidence without replacing the enrolled device or granting authority', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    const before = h.registry.getDevices(true).find(item => item.id === deviceId)!;
    const updated = await h.registry.reconcileShellyIdentityEvidence(evidence());
    expect(updated).toMatchObject({ id: deviceId, displayName: before.displayName, zoneName: before.zoneName,
      adapter: before.adapter, metadata: { physicalId, component, physicalInventoryId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9',
        identityEvidenceSource: 'verified_site_local_shelly_rpc', componentEvidenceSource: 'verified_site_local_shelly_rpc',
        verifiedMeasurementFields: 'power,energy_import_total' } });
    expect(h.store.save).toHaveBeenCalledTimes(1);
    expect(h.store.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'shelly_identity_evidence_reconciled', deviceId }));
    expect(await h.registry.getShellyObservationApproval('tenant-demo', 'site-home', deviceId)).toMatchObject({
      approvalStatus: 'missing', approved: false, selector: '',
      fields: [{ metric: 'power', unit: 'W' }, { metric: 'energy_import_total', unit: 'kWh' }],
    });
  });

  it('is idempotent for the same immutable report and preserves existing authority', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    await h.registry.reconcileShellyIdentityEvidence(evidence());
    await h.registry.reconcileShellyIdentityEvidence(evidence());
    expect(h.store.save).toHaveBeenCalledTimes(1);
    expect(h.store.append).toHaveBeenCalledTimes(1);
  });

  it('rejects identity/component mismatches and evidence outside the authorized site', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    await expect(h.registry.reconcileShellyIdentityEvidence({ ...evidence(), physicalId: 'shellyplus1-000000000001' })).rejects.toThrow();
    await expect(h.registry.reconcileShellyIdentityEvidence({ ...evidence(), component: 'switch:1' })).rejects.toThrow();
    await expect(h.registry.getShellyReconciliationTarget('tenant-demo', 'site-device-lab', deviceId, physicalId, component)).resolves.toBeNull();
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it('rejects stale or replay-shaped reconciliation evidence', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    await expect(h.registry.reconcileShellyIdentityEvidence({ ...evidence(), identityVerifiedAt: '2020-01-01T00:00:00.000Z' })).rejects.toThrow(/Fresh/);
    await expect(h.registry.reconcileShellyIdentityEvidence({ ...evidence(), evidenceScanId: 'arbitrary-report' })).rejects.toThrow(/Fresh/);
    expect(h.store.save).not.toHaveBeenCalled();
  });
});
