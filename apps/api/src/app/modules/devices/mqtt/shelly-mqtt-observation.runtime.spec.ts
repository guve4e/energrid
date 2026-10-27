import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellyMqttObservationApproval } from '../adapters/inbound/shelly/shelly-mqtt-observation-approval';
import { ApprovedMqttObservationRuntime } from './approved-mqtt-observation.runtime';

describe('approved Shelly MQTT observation ingress', () => {
  const oldEnv = { ...process.env };
  let directory = '';
  let runtime: ApprovedMqttObservationRuntime | undefined;

  afterEach(async () => {
    await runtime?.onModuleDestroy();
    runtime = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
    process.env = { ...oldEnv };
  });

  async function setup(options: { approved?: boolean; tenantId?: string; siteId?: string; componentKey?: string; verifiedFields?: string; approvedFields?: Array<'power' | 'energy_import_total' | 'energy_export_total'>; siteLocal?: boolean; mqttTopic?: string } = {}) {
    directory = await mkdtemp(join(tmpdir(), 'energrid-shelly-observation-'));
    process.env.HOME_OBSERVATION_STORE_DIRECTORY = directory;
    process.env.HOME_HTTP_POLL_ENABLED = 'true';
    delete process.env.HOME_OBSERVATION_BINDINGS_JSON;
    delete process.env.LAB_MQTT_OBSERVATION_BINDINGS_JSON;
    const physicalId = 'shellypro2pm-001122334455';
    const componentKey = options.componentKey || 'switch:0';
    const deviceId = `${physicalId}:${componentKey}`;
    const tenantId = options.tenantId || 'tenant-a';
    const siteId = options.siteId || 'site-a';
    const device = {
      id: deviceId, tenantId, siteId, kind: 'physical', trustStatus: 'approved',
      adapter: { driver: 'shelly-lan', protocol: 'http' },
      metadata: {
        physicalId, component: componentKey,
        identityEvidenceSource: options.siteLocal ? 'verified_site_local_shelly_rpc' : 'verified_shelly_http_rpc',
        componentEvidenceSource: options.siteLocal ? 'verified_site_local_shelly_rpc' : 'verified_shelly_component_status_rpc',
        ...(options.siteLocal ? { siteLocalObserverId: 'pi-housenet-observer' } : {}),
        shellyMqttObservationApprovalRequired: true, verifiedMeasurementFields: options.verifiedFields || 'power',
      },
    };
    const registry = {
      ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
      getDevices: jest.fn().mockReturnValue([device]),
      projectApprovedObservation: jest.fn(),
    };
    const installation = {
      schemaVersion: 1,
      device,
      observationAuthority: options.approved ? shellyMqttObservationApproval(deviceId, options.approvedFields, options.mqttTopic) : undefined,
    };
    const installations = { get: jest.fn().mockResolvedValue(installation) };
    const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled', tenantId, siteId, deviceId }) };
    runtime = new ApprovedMqttObservationRuntime(registry as any, installations as any, enrollment as any);
    return { physicalId, componentKey, deviceId, tenantId, siteId, registry, installations, enrollment };
  }

  it('rejects unapproved Shelly power without mutating the observation projection', async () => {
    const h = await setup();
    const result = await runtime!.ingestShellyMqttObservation({
      topic: `${h.physicalId}/events/rpc`, physicalId: h.physicalId, componentKey: h.componentKey,
      values: { power: 42 }, evidenceId: 'evidence-1',
    });
    expect(result).toMatchObject({ outcome: 'rejected', reasonCode: 'observation_authority_missing' });
    expect(h.registry.projectApprovedObservation).not.toHaveBeenCalled();
    expect(h.enrollment.find).not.toHaveBeenCalled();
    expect(h.installations.get).toHaveBeenCalledWith(h.siteId, h.deviceId);
  });

  it('accepts an approved exact component/topic and deduplicates repeated evidence', async () => {
    const h = await setup({ approved: true });
    const input = {
      topic: `${h.physicalId}/events/rpc`, physicalId: h.physicalId, componentKey: h.componentKey,
      values: { power: 42 }, evidenceId: 'stable-message-hash',
    };
    const first = await runtime!.ingestShellyMqttObservation(input);
    const duplicate = await runtime!.ingestShellyMqttObservation(input);
    expect(first).toMatchObject({ outcome: 'processed', accepted: true, deviceId: h.deviceId, scope: { tenantId: h.tenantId, siteId: h.siteId } });
    expect(duplicate).toMatchObject({ outcome: 'processed', accepted: false, reason: 'duplicate_evidence' });
    expect(h.registry.projectApprovedObservation).toHaveBeenCalledTimes(1);
    expect(h.installations.get).toHaveBeenCalledWith(h.siteId, h.deviceId);
  });

  it('accepts only an explicitly reviewed custom MQTT source topic for the RPC-verified device', async () => {
    const topic = 'shelly/washer@other/events/rpc';
    const h = await setup({ approved: true, mqttTopic: topic });
    const result = await runtime!.ingestShellyMqttObservation({
      topic, physicalId: h.physicalId, componentKey: h.componentKey,
      values: { power: 18 }, evidenceId: 'custom-prefix-message',
    });
    expect(result).toMatchObject({ outcome: 'processed', accepted: true, deviceId: h.deviceId,
      scope: { tenantId: h.tenantId, siteId: h.siteId } });
    const wrongTopic = await runtime!.ingestShellyMqttObservation({
      topic: 'different/prefix/events/rpc', physicalId: h.physicalId, componentKey: h.componentKey,
      values: { power: 18 }, evidenceId: 'wrong-prefix-message',
    });
    expect(wrongTopic).toMatchObject({ outcome: 'rejected', reasonCode: 'observation_authority_missing' });
  });

  it('rejects topic and component identity mismatches before resolving an installation', async () => {
    const h = await setup({ approved: true });
    const wrongTopic = await runtime!.ingestShellyMqttObservation({
      topic: 'other-device/events/rpc', physicalId: h.physicalId, componentKey: h.componentKey,
      values: { power: 42 }, evidenceId: 'evidence-1',
    });
    const invalidComponent = await runtime!.ingestShellyMqttObservation({
      topic: `${h.physicalId}/events/rpc`, physicalId: h.physicalId, componentKey: 'switch:1',
      values: { power: 42 }, evidenceId: 'evidence-2',
    });
    expect(wrongTopic).toMatchObject({ outcome: 'rejected', reasonCode: 'observation_authority_missing' });
    expect(invalidComponent).toMatchObject({ outcome: 'rejected', reasonCode: 'shelly_lan_verified_enrollment_missing' });
    expect(h.installations.get).toHaveBeenCalledTimes(1);
  });

  it('binds installation lookup to the enrolled device site rather than the active Portal site', async () => {
    const h = await setup({ approved: true, tenantId: 'tenant-lab', siteId: 'site-lab' });
    const result = await runtime!.ingestShellyMqttObservation({
      topic: `${h.physicalId}/events/rpc`, physicalId: h.physicalId, componentKey: h.componentKey,
      values: { power: 12 }, evidenceId: 'lab-evidence',
    });
    expect(result).toMatchObject({ outcome: 'processed', accepted: true, scope: { tenantId: 'tenant-lab', siteId: 'site-lab' } });
    expect(h.installations.get).toHaveBeenCalledWith('site-lab', h.deviceId);
  });

  it('admits only separately approved switch energy counters through the enrolled site binding', async () => {
    const h = await setup({ componentKey: 'switch:1', verifiedFields: 'power,energy_import_total',
      approved: true, approvedFields: ['energy_import_total'] });
    const result = await runtime!.ingestShellyMqttObservation({
      topic: `${h.physicalId}/events/rpc`, physicalId: h.physicalId, componentKey: h.componentKey,
      values: { energy_import_total: 0.6 }, evidenceId: 'switch-energy-message',
    });
    expect(result).toMatchObject({ outcome: 'processed', accepted: true, deviceId: h.deviceId,
      scope: { tenantId: h.tenantId, siteId: h.siteId } });
    expect(h.installations.get).toHaveBeenCalledWith(h.siteId, h.deviceId);
    expect(h.registry.projectApprovedObservation).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: h.deviceId, values: { energy_import_total: 0.6 },
    }));
  });

  it('accepts explicitly approved site-local RPC verified switch readings only for the enrolled site', async () => {
    const h = await setup({ componentKey: 'switch:1', verifiedFields: 'power,energy_import_total',
      approved: true, approvedFields: ['energy_import_total'], siteLocal: true });
    const result = await runtime!.ingestShellyMqttObservation({
      topic: `${h.physicalId}/events/rpc`, physicalId: h.physicalId, componentKey: h.componentKey,
      values: { energy_import_total: 0.6 }, evidenceId: 'site-local-switch-energy',
    });
    expect(result).toMatchObject({ outcome: 'processed', accepted: true,
      scope: { tenantId: h.tenantId, siteId: h.siteId } });
    expect(h.installations.get).toHaveBeenCalledWith(h.siteId, h.deviceId);
  });
});
