import { DeviceRegistryService } from './device-registry.service';
import { isShellyMqttObservationApproval, shellyMqttObservationApproval } from './adapters/inbound/shelly/shelly-mqtt-observation-approval';

const physicalId = 'shellypro2pm-aabbccddeeff';
const deviceId = `${physicalId}:switch:0`;
const device = {
  id: deviceId,
  tenantId: 'tenant-demo',
  siteId: 'site-device-lab',
  siteName: 'Virtual Device Lab',
  displayName: 'Pro 2PM switch:0',
  kind: 'physical',
  zoneId: 'garage',
  zoneName: 'Garage',
  trustStatus: 'approved',
  capabilities: [{ kind: 'switch', actions: ['read'] }, { kind: 'power', actions: ['read'] }],
  supportedCapabilities: [{ kind: 'switch', actions: ['read'] }, { kind: 'power', actions: ['read'] }],
  adapter: { id: 'shelly-lan', protocol: 'http', transport: 'http', driver: 'shelly-lan', configured: true },
  state: { values: {}, observedAt: null, source: 'device-store', status: 'unknown' },
  responseProfile: { confidence: 0.9, learningEnabled: false },
  policy: { requiresApproval: true, confirmationRequiredFor: [] },
  metadata: {
    physicalId, component: 'switch:0',
    identityEvidenceSource: 'verified_shelly_http_rpc',
    componentEvidenceSource: 'verified_shelly_component_status_rpc',
    shellyMqttObservationApprovalRequired: true,
    verifiedMeasurementFields: 'power',
  },
};

function setup(options: { siteId?: string; hasPowerEvidence?: boolean; authority?: unknown; siteLocal?: boolean } = {}) {
  const siteId = options.siteId || 'site-device-lab';
  const storedDevice = { ...device, siteId, metadata: {
    ...device.metadata,
    ...(options.siteLocal ? {
      identityEvidenceSource: 'verified_site_local_shelly_rpc',
      componentEvidenceSource: 'verified_site_local_shelly_rpc',
      siteLocalObserverId: 'pi-housenet-observer',
    } : {}),
    ...(options.hasPowerEvidence === false ? { verifiedMeasurementFields: '' } : {}),
  } };
  const installation = {
    schemaVersion: 1,
    device: storedDevice,
    observationAuthority: options.authority,
    physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
    updatedAt: new Date().toISOString(),
  };
  const installationStore = {
    listAll: jest.fn().mockResolvedValue([installation]),
    save: jest.fn().mockResolvedValue(undefined),
    append: jest.fn().mockResolvedValue(undefined),
  };
  const enrollment = {
    list: jest.fn().mockResolvedValue([{ deviceId, status: 'enrolled' }]),
    find: jest.fn().mockResolvedValue({ deviceId, status: 'enrolled' }),
  };
  const previous = process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON;
  process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON = '{}';
  const registry = new DeviceRegistryService(undefined, installationStore as any, enrollment as any);
  return {
    registry, installationStore, enrollment, installation,
    restore: () => {
      if (previous === undefined) delete process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON;
      else process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON = previous;
    },
  };
}

describe('site-scoped Shelly observation approval', () => {
  it('supports separately approved switch power and cumulative energy fields without control authority', () => {
    const switchId = 'shellypro2pm-ec6260888084:switch:1';
    const authority = shellyMqttObservationApproval(switchId, ['power', 'energy_import_total']);
    expect(authority.bindings[0]).toMatchObject({
      deviceId: switchId, selector: 'shellypro2pm-ec6260888084/events/rpc',
      fields: { power: { rawKey: 'power', type: 'number' }, energy_import_total: { rawKey: 'energy_import_total', type: 'number' } },
    });
    expect(authority.bindings[0].fields).not.toHaveProperty('output');
    expect(authority.bindings[0].fields).not.toHaveProperty('command');
    expect(isShellyMqttObservationApproval(authority, switchId)).toBe(true);
    expect(() => shellyMqttObservationApproval(switchId, ['switch' as never])).toThrow();
  });
  it('persists the operator-approved exact power binding into the installation authority', async () => {
    const h = setup();
    try {
      await h.registry.ensureInstallationsLoaded();
      const proposal = await h.registry.getShellyObservationApproval('tenant-demo', 'site-device-lab', deviceId);
      expect(proposal).toMatchObject({ approved: false, approvalStatus: 'missing', sourceId: 'shelly-mqtt', selector: '' });
      const mqttTopic = 'shelly/washer@other/events/rpc';
      const saved = await h.registry.approveShellyObservations('tenant-demo', 'site-device-lab', deviceId,
        'operator@example.test', ['power'], mqttTopic);
      expect(saved).toMatchObject({ approved: true, approvalStatus: 'approved', fields: [{ metric: 'power', unit: 'W' }] });
      expect(h.installationStore.save).toHaveBeenCalledWith(expect.objectContaining({
        observationAuthority: {
          bindings: [{ deviceId, sourceId: 'shelly-mqtt', selector: mqttTopic, fields: { power: { rawKey: 'power', type: 'number' } } }],
          policy: { deviceId, allowedSourcesByField: { power: ['shelly-mqtt'] } },
        },
      }));
      expect(h.installationStore.append).toHaveBeenCalledWith(expect.objectContaining({
        deviceId, kind: 'observation_authority_approved', actor: 'operator@example.test',
        evidence: { sourceId: 'shelly-mqtt', selector: mqttTopic, fields: 'power' },
      }));
    } finally { h.restore(); }
  });

  it('does not expose an approval proposal outside the persisted tenant/site or without RPC power evidence', async () => {
    const wrongSite = setup({ siteId: 'site-home' });
    try {
      await wrongSite.registry.ensureInstallationsLoaded();
      await expect(wrongSite.registry.getShellyObservationApproval('tenant-demo', 'site-device-lab', deviceId)).resolves.toBeNull();
    } finally { wrongSite.restore(); }

    const noPower = setup({ hasPowerEvidence: false });
    try {
      await noPower.registry.ensureInstallationsLoaded();
      await expect(noPower.registry.getShellyObservationApproval('tenant-demo', 'site-device-lab', deviceId)).resolves.toBeNull();
    } finally { noPower.restore(); }
  });

  it('allows separate measurement approval for site-local RPC evidence after enrollment', async () => {
    const h = setup({ siteLocal: true });
    try {
      await h.registry.ensureInstallationsLoaded();
      await expect(h.registry.getShellyObservationApproval('tenant-demo', 'site-device-lab', deviceId))
        .resolves.toMatchObject({ approved: false, fields: [{ metric: 'power' }] });
    } finally { h.restore(); }
  });

  it('does not replace an existing installation observation authority', async () => {
    const h = setup({ authority: { bindings: [], policy: { deviceId } } });
    try {
      await h.registry.ensureInstallationsLoaded();
      await expect(h.registry.approveShellyObservations('tenant-demo', 'site-device-lab', deviceId, 'operator', ['power'], `${physicalId}/events/rpc`))
        .rejects.toThrow('A different observation authority already exists');
      expect(h.installationStore.save).not.toHaveBeenCalled();
    } finally { h.restore(); }
  });
});
