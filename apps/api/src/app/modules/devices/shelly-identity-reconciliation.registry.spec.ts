import { DeviceRegistryService } from './device-registry.service';
import { findExactShellyInventoryAssignment } from '../portal/site-local-shelly-inventory-match';
import { PortalController } from '../portal/portal.controller';
import type { PhysicalDeviceInventoryRecord } from './enrollment/physical-device-inventory.repository';
import { configuredShellyMqttBroker } from './adapters/inbound/shelly/shelly-mqtt-observation-approval';
import { shellyPro2PmNotifyStatusFixture } from './adapters/inbound/shelly/__fixtures__/shelly-pro2pm-notifystatus.fixture';
import { DeviceMqttMessageRouter } from './mqtt/device-mqtt-message-router';
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime';
import { DeviceObservationService } from './device-observation.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    // Mirrors the existing Home MQTT-enrolled records: the authoritative
    // physical inventory link lives in PhysicalDeviceInventory assignments,
    // not as a duplicated physicalInventoryId on the logical device metadata.
    metadata: { physicalId, component, mqttEvidenceCandidate: true },
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
  return { registry: new DeviceRegistryService(undefined, store as any, enrollment as any), store, record, device, enrollment };
}

const evidence = (siteId = 'site-home') => ({
  tenantId: 'tenant-demo', siteId, deviceId, physicalId, component,
  physicalInventoryId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9',
  evidenceScanId: 'site-observer-12345678', evidenceCompletedAt: observedAt, observerId: 'pi-housenet', ipAddress: '192.168.1.166',
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
      adapter: before.adapter, metadata: { physicalId, component,
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

  it('can attach accepted historical evidence for review while marking it ineligible to grant new authority', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    const old = '2026-10-26T08:00:00.000Z';
    await h.registry.reconcileShellyIdentityEvidence({ ...evidence(),
      evidenceCompletedAt: '2026-10-26T08:01:00.000Z', identityVerifiedAt: old, componentVerifiedAt: old });
    const proposal = await h.registry.getShellyObservationApproval('tenant-demo', 'site-home', deviceId);
    expect(proposal).toMatchObject({ approved: false, approvalStatus: 'missing', evidenceFresh: false,
      evidence: { provenance: 'operator_attested_site_local_shelly_rpc_report', observerId: 'pi-housenet',
        snapshotId: 'site-observer-12345678', endpoint: '192.168.1.166',
        networkScope: 'upstream-lan:192.168.1.0/24', identityVerifiedAt: old, componentVerifiedAt: old },
      fields: [{ metric: 'power' }, { metric: 'energy_import_total' }] });
    await expect(h.registry.approveShellyObservations('tenant-demo', 'site-home', deviceId,
      'operator@example.test', ['power'], 'shelly/washer@other/events/rpc', configuredShellyMqttBroker()))
      .rejects.toThrow('Fresh site-local Shelly identity and component evidence is required');
    expect(h.store.save).toHaveBeenCalledTimes(1);
  });

  it('preserves a pre-existing observation authority when identity evidence is reconciled', async () => {
    const h = setup();
    const existingAuthority = { bindings: [{ deviceId, sourceId: 'existing-source', selector: 'existing/topic', fields: {} }], policy: { deviceId } };
    h.record.observationAuthority = existingAuthority;
    await h.registry.onModuleInit();
    await h.registry.reconcileShellyIdentityEvidence(evidence());
    expect(h.store.save).toHaveBeenCalledWith(expect.objectContaining({ observationAuthority: existingAuthority }));
  });

  it('accepts the caller-validated exact assignment when legacy metadata omits the duplicate inventory ID', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    // A legacy logical record without a copied inventory ID is eligible only
    // after the caller supplies the exact server-validated assignment.
    const result = await h.registry.reconcileShellyIdentityEvidence(evidence());
    expect(result?.id).toBe(deviceId);
    const conflict = setup();
    conflict.device.metadata = { ...conflict.device.metadata, physicalInventoryId: 'different-inventory' };
    await conflict.registry.onModuleInit();
    await expect(conflict.registry.reconcileShellyIdentityEvidence(evidence())).resolves.toBeNull();
    expect(conflict.store.save).not.toHaveBeenCalled();
  });

  it('reports the first safe matching rejection code and accepts the legacy Home record via the validated inventory assignment', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    await expect(h.registry.getShellyReconciliationTargetDecision(
      'tenant-demo', 'site-home', deviceId, physicalId, component, evidence().physicalInventoryId,
    )).resolves.toMatchObject({ matched: true, device: { id: deviceId, adapter: { driver: 'shelly-discovered' } } });

    const mismatch = await h.registry.getShellyReconciliationTargetDecision(
      'tenant-demo', 'site-home', deviceId, 'shellyplus1-other', component, evidence().physicalInventoryId,
    );
    expect(mismatch).toEqual({ matched: false, reasonCode: 'physical_identity_mismatch' });
    const outside = await h.registry.getShellyReconciliationTargetDecision(
      'tenant-demo', 'site-device-lab', deviceId, physicalId, component, evidence().physicalInventoryId,
    );
    expect(outside).toEqual({ matched: false, reasonCode: 'logical_record_outside_site' });
    const unlinked = setup();
    unlinked.enrollment.find.mockResolvedValue({ deviceId, status: 'suspended' });
    await unlinked.registry.onModuleInit();
    await expect(unlinked.registry.getShellyReconciliationTargetDecision(
      'tenant-demo', 'site-home', deviceId, physicalId, component, evidence().physicalInventoryId,
    )).resolves.toEqual({ matched: false, reasonCode: 'not_enrolled' });

    const inventoryConflict = setup();
    inventoryConflict.device.metadata = { ...inventoryConflict.device.metadata, physicalInventoryId: 'different-inventory' };
    await inventoryConflict.registry.onModuleInit();
    await expect(inventoryConflict.registry.getShellyReconciliationTargetDecision(
      'tenant-demo', 'site-home', deviceId, physicalId, component, evidence().physicalInventoryId,
    )).resolves.toEqual({ matched: false, reasonCode: 'physical_inventory_conflict' });
  });

  it('replays accepted Home RPC identity against both persisted component assignments without changing Home records', async () => {
    const secondId = `${physicalId}:switch:1`;
    const h = setup();
    const secondDevice = { ...h.device, id: secondId, displayName: `${physicalId} switch:1`, zoneId: 'unknown', zoneName: 'Unknown',
      metadata: { physicalId, component: 'switch:1', mqttEvidenceCandidate: true } };
    const records = [h.record, { ...h.record, device: secondDevice }];
    const store = { listAll: jest.fn().mockResolvedValue(records), save: jest.fn().mockResolvedValue(undefined), append: jest.fn().mockResolvedValue(undefined) };
    const enrollment = {
      list: jest.fn().mockResolvedValue([{ deviceId, status: 'enrolled' }, { deviceId: secondId, status: 'enrolled' }]),
      find: jest.fn(async ({ deviceId: id }: { deviceId: string }) => ({ deviceId: id, status: 'enrolled' })),
    };
    const registry = new DeviceRegistryService(undefined, store as any, enrollment as any);
    await registry.onModuleInit();
    const inventory: PhysicalDeviceInventoryRecord = {
      physicalDeviceId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9',
      scope: { tenantId: 'tenant-demo', siteId: 'site-home' },
      identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      verificationStatus: 'protocol_observed', firstSeenAt: observedAt, lastSeenAt: observedAt,
      components: ['switch:0', 'switch:1'].map(key => ({ key, capabilities: ['switch', 'power'], firstSeenAt: observedAt, lastSeenAt: observedAt })),
      endpoints: [], networkObservations: [],
      assignments: [
        { deviceId, physicalDeviceId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9', componentKey: 'switch:0', assignedAt: observedAt, assignedBy: 'operator' },
        { deviceId: secondId, physicalDeviceId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9', componentKey: 'switch:1', assignedAt: observedAt, assignedBy: 'operator' },
      ],
    };
    for (const key of ['switch:0', 'switch:1']) {
      const id = `${physicalId}:${key}`;
      const matchedInventory = findExactShellyInventoryAssignment(
        [inventory], { tenantId: 'tenant-demo', siteId: 'site-home' }, id, physicalId, key,
      );
      expect(matchedInventory?.physicalDeviceId).toBe(inventory.physicalDeviceId);
      await expect(registry.getShellyReconciliationTargetDecision(
        'tenant-demo', 'site-home', id, physicalId, key, matchedInventory!.physicalDeviceId,
      )).resolves.toMatchObject({ matched: true, device: { id } });
    }
    expect(store.save).not.toHaveBeenCalled();
  });

  it('builds a historical review proposal from the accepted Home snapshot and existing MQTT records', async () => {
    const secondId = `${physicalId}:switch:1`;
    const h = setup();
    const secondDevice = { ...h.device, id: secondId, displayName: `${physicalId} switch:1`, zoneId: 'unknown', zoneName: 'Unknown',
      metadata: { physicalId, component: 'switch:1', mqttEvidenceCandidate: true } };
    const records = [h.record, { ...h.record, device: secondDevice }];
    const store = { listAll: jest.fn().mockResolvedValue(records), save: jest.fn().mockResolvedValue(undefined), append: jest.fn().mockResolvedValue(undefined) };
    const enrollment = {
      list: jest.fn().mockResolvedValue([{ deviceId, status: 'enrolled' }, { deviceId: secondId, status: 'enrolled' }]),
      find: jest.fn(async ({ deviceId: id }: { deviceId: string }) => ({ deviceId: id, status: 'enrolled' })),
    };
    const registry = new DeviceRegistryService(undefined, store as any, enrollment as any);
    await registry.onModuleInit();
    const inventoryId = '8e15ec60-a22b-4f8c-ab09-5e61d44030f9';
    const inventory: PhysicalDeviceInventoryRecord = {
      physicalDeviceId: inventoryId, scope: { tenantId: 'tenant-demo', siteId: 'site-home' },
      identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      verificationStatus: 'protocol_observed', firstSeenAt: observedAt, lastSeenAt: observedAt,
      components: ['switch:0', 'switch:1'].map(key => ({ key, capabilities: ['switch', 'power'], firstSeenAt: observedAt, lastSeenAt: observedAt })),
      endpoints: [], networkObservations: [],
      assignments: [
        { deviceId, physicalDeviceId: inventoryId, componentKey: 'switch:0', assignedAt: observedAt, assignedBy: 'operator' },
        { deviceId: secondId, physicalDeviceId: inventoryId, componentKey: 'switch:1', assignedAt: observedAt, assignedBy: 'operator' },
      ],
    };
    const endpoint = {
      id: physicalId, ipAddress: '192.168.1.166', vendor: 'Shelly', model: 'SPSW-202PE16EU', generation: 2,
      firmwareVersion: '2.0.0', status: 'online', discoveredAt: '2026-10-27T09:39:36.000Z',
      networkZoneId: 'upstream-lan', networkZoneName: 'Upstream LAN', gatewayId: 'upstream-lan',
      components: [{ component: 'switch:0', channel: 0 }, { component: 'switch:1', channel: 1 }],
      observations: [
        { source: 'http_identity', attribute: 'identity.device_id', value: physicalId, observedAt: '2026-10-27T09:39:00.000Z' },
        { source: 'site_local_http_rpc', attribute: 'observer.identity', value: 'pi-housenet', observedAt: '2026-10-27T09:39:00.000Z' },
        ...['switch:0', 'switch:1'].flatMap((key, index) => [
          { source: 'site_local_http_rpc', attribute: 'shelly.component_status', value: key, method: `Switch.GetStatus?id=${index}`, observedAt: `2026-10-27T09:39:${10 + index * 10}.000Z` },
          { source: 'site_local_http_rpc', attribute: 'shelly.measurement_capability', value: `${key}:power`, observedAt: `2026-10-27T09:39:${10 + index * 10}.000Z` },
          { source: 'site_local_http_rpc', attribute: 'shelly.measurement_capability', value: `${key}:energy_import_total`, observedAt: `2026-10-27T09:39:${10 + index * 10}.000Z` },
        ]),
      ],
    };
    const snapshot = {
      scanId: 'site-observer-2aec6d8b2d4d25f397a572203264edd0a388de00',
      completedAt: '2026-10-27T09:39:36.000Z', ownership: { tenantId: 'tenant-demo', siteId: 'site-home' },
      collector: { host: 'pi' }, scopes: [{ id: 'upstream-lan', cidr: '192.168.1.0/24' }], endpoints: [endpoint],
    } as any;
    const controller = new PortalController(
      {} as any, {} as any, {} as any, {} as any, registry,
      {} as any, {} as any, {} as any, {} as any,
      undefined, undefined, { list: jest.fn().mockResolvedValue([inventory]) } as any,
    );
    const review = await (controller as any).buildSiteLocalShellyReview(
      snapshot, snapshot.ownership, 'pi-housenet', endpoint, 'Home', false,
    );
    expect(review.reconciliationProposals).toHaveLength(2);
    expect(review.reconciliationProposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId, physicalInventoryId: inventoryId, component: 'switch:0', evidenceFresh: false, currentIdentitySource: 'unverified' }),
      expect.objectContaining({ deviceId: secondId, physicalInventoryId: inventoryId, component: 'switch:1', evidenceFresh: false, currentIdentitySource: 'unverified' }),
    ]));
    expect(review.reconciliationConflicts).toEqual([]);
    expect(store.save).not.toHaveBeenCalled();
    expect(records.map(item => ({ id: item.device.id, room: item.device.zoneName }))).toEqual([
      { id: deviceId, room: 'Bathroom' }, { id: secondId, room: 'Unknown' },
    ]);
  });

  it('does not write authority when saved physical identity evidence is only proposed', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    expect(await h.registry.getShellyReconciliationTargetDecision(
      'tenant-demo', 'site-home', deviceId, physicalId, component, evidence().physicalInventoryId,
    )).toMatchObject({ matched: true });
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.record.observationAuthority).toBeUndefined();
    expect(h.device.control).toBeUndefined();
  });

  it('restores the verified switch capability on a legacy power-only component without authorizing control', async () => {
    const h = setup();
    h.device.capabilities = [{ kind: 'power', actions: ['read'] }];
    h.device.supportedCapabilities = [{ kind: 'power', actions: ['read'] }];
    await h.registry.onModuleInit();
    expect(h.registry.getDevices(true).find(item => item.id === deviceId)?.control).toMatchObject({
      status: 'read-only', binding: null,
    });

    await h.registry.reconcileShellyIdentityEvidence(evidence());
    const reconciled = h.registry.getDevices(true).find(item => item.id === deviceId)!;
    expect(reconciled.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'switch', actions: expect.arrayContaining(['turn_on', 'turn_off']) }),
    ]));
    expect(reconciled.supportedCapabilities.map(item => item.kind)).toEqual(expect.arrayContaining(['power', 'switch']));
    expect(reconciled.control).toMatchObject({ status: 'needs-setup', binding: null });
    expect(reconciled.assistantEnabled).toBe(false);
    expect(h.record.observationAuthority).toBeUndefined();
    expect(await h.registry.getShellyObservationApproval('tenant-demo', 'site-home', deviceId))
      .toMatchObject({ approved: false, approvalStatus: 'missing' });
  });

  it('keeps verified power as supported-only until explicit MQTT measurement approval, then enables read-only history capability', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    const before = h.registry.getDevices(true).find(item => item.id === deviceId)!;
    expect(before.capabilities.map(item => item.kind)).toEqual(['switch']);

    await h.registry.reconcileShellyIdentityEvidence(evidence());
    const reconciled = h.registry.getDevices(true).find(item => item.id === deviceId)!;
    expect(reconciled.supportedCapabilities.map(item => item.kind)).toContain('power');
    expect(reconciled.capabilities.map(item => item.kind)).not.toContain('power');
    expect(h.record.observationAuthority).toBeUndefined();

    const status = await h.registry.getShellyObservationApproval('tenant-demo', 'site-home', deviceId);
    expect(status).toMatchObject({ evidenceFresh: true, approved: false,
      fields: [{ metric: 'power' }, { metric: 'energy_import_total' }] });
    await h.registry.approveShellyObservations('tenant-demo', 'site-home', deviceId, 'operator@example.test',
      ['power'], 'shelly/washer@other/events/rpc', configuredShellyMqttBroker());

    const approved = h.registry.getDevices(true).find(item => item.id === deviceId)!;
    expect(approved.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'switch', actions: expect.arrayContaining(['turn_on', 'turn_off']) }),
      expect.objectContaining({ kind: 'power', actions: ['read'], unit: 'W' }),
    ]));
    expect(h.record.observationAuthority).toBeUndefined();
    expect(h.store.save).toHaveBeenCalledWith(expect.objectContaining({
      observationAuthority: expect.objectContaining({
        bindings: [expect.objectContaining({
          deviceId, sourceId: 'shelly-mqtt', selector: 'shelly/washer@other/events/rpc',
          fields: { power: { rawKey: 'power', type: 'number' } },
        })],
      }),
      device: expect.objectContaining({
        capabilities: expect.arrayContaining([expect.objectContaining({ kind: 'power', actions: ['read'] })]),
      }),
    }));
  });

  it('reconciles and admits both existing Home components through canonical ingress only after separate explicit approval', async () => {
    const oldEnv = { ...process.env };
    const physicalInventoryId = '8e15ec60-a22b-4f8c-ab09-5e61d44030f9';
    const mqttTopic = 'shelly/washer@other/events/rpc';
    const componentKeys = ['switch:0', 'switch:1'];
    const records = new Map(componentKeys.map((key, index) => {
      const id = `${physicalId}:${key}`;
      const device = { ...hDevice(id, key, index) };
      return [`site-home:${id}`, { schemaVersion: 1, device, physicalOutcome: {
        status: 'not_confirmed', confirmedAt: null, confirmedBy: null,
      }, updatedAt: observedAt }];
    }));
    const store = {
      listAll: jest.fn().mockImplementation(async () => [...records.values()]),
      get: jest.fn().mockImplementation(async (siteId: string, id: string) => records.get(`${siteId}:${id}`) || null),
      save: jest.fn().mockImplementation(async (next: any) => { records.set(`${next.device.siteId}:${next.device.id}`, next); }),
      append: jest.fn().mockResolvedValue(undefined),
    };
    const enrollment = {
      list: jest.fn().mockResolvedValue(componentKeys.map(key => ({ deviceId: `${physicalId}:${key}`, status: 'enrolled' }))),
      find: jest.fn().mockImplementation(async ({ deviceId: id }: { deviceId: string }) =>
        records.has(`site-home:${id}`) ? { tenantId: 'tenant-demo', siteId: 'site-home', deviceId: id, status: 'enrolled' } : null),
    };
    const previousStorePath = process.env.HOME_OBSERVATION_STORE_DIRECTORY;
    const directory = await mkdtemp(join(tmpdir(), 'energrid-shelly-e2e-'));
    let runtime: ApprovedMqttObservationRuntime | undefined;
    try {
      process.env.HOME_OBSERVATION_STORE_DIRECTORY = directory;
      process.env.HOME_HTTP_POLL_ENABLED = 'true';
      delete process.env.HOME_OBSERVATION_BINDINGS_JSON;
      delete process.env.LAB_MQTT_OBSERVATION_BINDINGS_JSON;
      const registry = new DeviceRegistryService(undefined, store as any, enrollment as any);
      await registry.onModuleInit();
      for (const componentKey of componentKeys) {
        const id = `${physicalId}:${componentKey}`;
        await registry.reconcileShellyIdentityEvidence({ ...evidence(), deviceId: id, component: componentKey,
          physicalInventoryId, evidenceScanId: 'site-observer-2aec6d8b2d4d25f397a572203264edd0a388de00',
          verifiedMeasurementFields: ['power', 'energy_import_total', 'energy_export_total'] });
        // Reconciliation only establishes supported LAN evidence. It does not
        // grant the read capability or any field authority.
        expect(registry.getDevices(true).find(item => item.id === id)?.capabilities.map(item => item.kind)).toEqual(['switch']);
        expect(registry.getDevices(true).find(item => item.id === id)?.supportedCapabilities.map(item => item.kind)).toContain('power');
        await registry.approveShellyObservations('tenant-demo', 'site-home', id, 'operator@example.test',
          ['power'], mqttTopic, configuredShellyMqttBroker());
      }

      const historyWriter = { persistAccepted: jest.fn().mockResolvedValue([{ field: 'power', outcome: 'stored' }]) };
      runtime = new ApprovedMqttObservationRuntime(registry, store as any, enrollment as any, historyWriter as any);
      const capture = jest.fn().mockResolvedValue(undefined);
      const router = new DeviceMqttMessageRouter(registry, new DeviceObservationService(), { capture } as any,
        undefined, undefined, enrollment as any, runtime);
      const payload = { ...shellyPro2PmNotifyStatusFixture, params: {
        ...shellyPro2PmNotifyStatusFixture.params,
        'switch:0': { ...shellyPro2PmNotifyStatusFixture.params['switch:0'], current: 0.1, voltage: 230 },
        'switch:1': { ...shellyPro2PmNotifyStatusFixture.params['switch:1'], current: 0.2, voltage: 230 },
      } };
      const routed = await router.route({ topic: mqttTopic, payload, payloadText: JSON.stringify(payload) });
      await routed?.persisted;

      expect(routed?.observationAdmissions).toEqual(componentKeys.map(componentKey => expect.objectContaining({
        deviceId: `${physicalId}:${componentKey}`, outcome: 'admitted',
      })));
      expect(historyWriter.persistAccepted).toHaveBeenCalledTimes(2);
      expect(historyWriter.persistAccepted).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 'tenant-demo', siteId: 'site-home', sourceId: 'shelly-mqtt', selector: mqttTopic,
        fields: [expect.objectContaining({ field: 'power', value: 0 })],
      }));
      expect(capture).toHaveBeenCalledTimes(2);
      for (const componentKey of componentKeys) {
        const deviceId = `${physicalId}:${componentKey}`;
        expect(capture).toHaveBeenCalledWith(expect.objectContaining({ deviceId, tenantId: 'tenant-demo', siteId: 'site-home' }),
          expect.objectContaining({ capabilities: expect.arrayContaining([expect.objectContaining({ kind: 'power', actions: ['read'] })]) }), 'shelly-mqtt');
        expect(registry.getDevices(true).find(item => item.id === deviceId)?.state.values.power).toBe(0);
      }
      expect(registry.getDevices(true).every(item => item.id !== `${physicalId}:switch:2`)).toBe(true);
    } finally {
      await runtime?.onModuleDestroy();
      if (previousStorePath === undefined) delete process.env.HOME_OBSERVATION_STORE_DIRECTORY;
      else process.env.HOME_OBSERVATION_STORE_DIRECTORY = previousStorePath;
      process.env = { ...oldEnv };
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects identity/component mismatches and evidence outside the authorized site', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    await expect(h.registry.reconcileShellyIdentityEvidence({ ...evidence(), physicalId: 'shellyplus1-000000000001' })).rejects.toThrow();
    await expect(h.registry.reconcileShellyIdentityEvidence({ ...evidence(), component: 'switch:1' })).rejects.toThrow();
    await expect(h.registry.getShellyReconciliationTarget('tenant-demo', 'site-device-lab', deviceId, physicalId, component,
      '8e15ec60-a22b-4f8c-ab09-5e61d44030f9')).resolves.toBeNull();
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it('rejects invalid or replay-shaped reconciliation evidence', async () => {
    const h = setup();
    await h.registry.onModuleInit();
    await expect(h.registry.reconcileShellyIdentityEvidence({ ...evidence(), identityVerifiedAt: 'invalid-time' })).rejects.toThrow(/accepted/i);
    await expect(h.registry.reconcileShellyIdentityEvidence({ ...evidence(), evidenceScanId: 'arbitrary-report' })).rejects.toThrow(/accepted/i);
    expect(h.store.save).not.toHaveBeenCalled();
  });
});

function hDevice(id: string, component: string, index: number) {
  return {
    id, tenantId: 'tenant-demo', siteId: 'site-home', siteName: 'Home',
    displayName: index === 0 ? 'Washer / bathroom fan' : 'Existing component',
    kind: 'physical', trustStatus: 'approved', zoneId: index === 0 ? 'bathroom' : 'unknown',
    zoneName: index === 0 ? 'Bathroom' : 'Unknown', adapter: { id: 'mqtt', protocol: 'mqtt', transport: 'mqtt', driver: 'shelly-discovered', configured: true },
    capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
    supportedCapabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
    state: { values: {}, observedAt: null, source: 'mqtt', status: 'unknown' },
    metadata: { physicalId, component, mqttEvidenceCandidate: true },
  };
}
