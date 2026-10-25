import { DeviceIntelligenceQueryService } from './device-intelligence-query.service';
import { energridHttpObservationApproval } from './adapters/inbound/energrid/energrid-http-observation-approval';

const scope = { tenantId: 'tenant-lab', siteId: 'site-lab' };
const observedAt = new Date().toISOString();

function fixture(input: {
  id: string;
  capabilities?: any[];
  supportedCapabilities?: any[];
  authority?: any;
  trustStatus?: 'approved' | 'discovered' | 'blocked';
  enrollmentStatus?: 'enrolled' | 'suspended' | 'retired';
  observedFields?: Record<string, unknown>;
  control?: any;
  configured?: boolean;
  discovery?: any;
}) {
  const device = {
    id: input.id, ...scope, siteName: 'LAB', kind: 'physical' as const,
    trustStatus: input.trustStatus ?? 'approved', displayName: input.id,
    zoneId: 'room', zoneName: 'Room', metadata: { physicalId: input.id },
    capabilities: input.capabilities ?? [],
    supportedCapabilities: input.supportedCapabilities ?? [],
    discovery: input.discovery,
    adapter: { id: 'adapter', protocol: 'http', configured: input.configured ?? true },
    control: input.control,
    state: { values: {}, observedAt, source: 'state-store', status: 'online' },
    policy: { confirmationRequiredFor: [], requiresApproval: true },
  };
  const installation = {
    schemaVersion: 1, device, observationAuthority: input.authority,
    physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
    updatedAt: observedAt,
  };
  const registry = { ensureInstallationsLoaded: jest.fn(), getDevices: () => [device] };
  const installations = { get: jest.fn().mockResolvedValue(installation), list: jest.fn().mockResolvedValue([installation]) };
  const enrollment = {
    find: jest.fn().mockResolvedValue({ tenantId: scope.tenantId, siteId: scope.siteId, deviceId: input.id, status: input.enrollmentStatus ?? 'enrolled', enrolledAt: observedAt, version: 1 }),
  };
  const observationReader = {
    read: jest.fn().mockResolvedValue(input.observedFields ? {
      deviceId: input.id,
      fields: Object.fromEntries(Object.entries(input.observedFields).map(([field, value]) => [field, {
        value, sourceId: 'energrid-http-status', receivedAt: observedAt,
      }])),
    } : null),
  };
  const service = new DeviceIntelligenceQueryService(
    registry as never, installations as never, enrollment as never, observationReader as never,
  );
  return { service, device, installation, enrollment, installations, observationReader };
}

describe('DeviceIntelligenceQueryService canonical device read model', () => {
  const sensors = [
    'device:upstream-lan:esp8266:324864',
    'device:upstream-lan:esp8266:3254b7',
    'device:eero-lan:esp8266:324b44',
  ];

  it.each(sensors)('keeps approved DHT22 observations visible for %s when generic capabilities are empty', async id => {
    const authority = energridHttpObservationApproval(id);
    const h = fixture({ id, authority, observedFields: { temperature: 9.5, humidity: 73.3 } });
    const model = await h.service.readDeviceModel(scope, id);
    expect(model).toMatchObject({
      capabilities: { supportStatus: 'unknown', supported: [] },
      observationAuthorization: { status: 'approved', bindings: [{ fields: ['temperature', 'humidity'] }] },
      current: { observations: { temperature: { value: 9.5, authority: 'approved' }, humidity: { value: 73.3, authority: 'approved' } } },
    });
  });

  it('retains stale sensor history authority while making current freshness explicit', async () => {
    const id = sensors[2];
    const h = fixture({ id, authority: energridHttpObservationApproval(id), observedFields: { temperature: 8 } });
    h.observationReader.read.mockResolvedValue({ deviceId: id, fields: {
      temperature: { value: 8, sourceId: 'energrid-http-status', receivedAt: '2020-01-01T00:00:00.000Z' },
    } });
    const model = await h.service.readDeviceModel(scope, id);
    expect(model?.current.observations.temperature).toMatchObject({ value: 8, freshness: 'stale', authority: 'approved' });
    expect(model?.history.authorizedMetrics).toContain('temperature');
  });

  it('projects a relay-only device without invented measurements', async () => {
    const h = fixture({
      id: 'shellyplus1-test:switch:0',
      capabilities: [{ kind: 'switch', actions: ['read', 'turn_on', 'turn_off'] }],
      supportedCapabilities: [{ kind: 'switch', actions: ['read', 'turn_on', 'turn_off'] }],
      control: { status: 'ready' },
    });
    const model = await h.service.readDeviceModel(scope, h.device.id);
    expect(model).toMatchObject({ capabilities: { supportStatus: 'verified', supported: ['switch'] }, history: { authorizedMetrics: [] } });
    expect(model?.observationAuthorization.bindings).toEqual([]);
    expect(model?.commands.available).toHaveLength(2);
    expect(model?.current.observations).toEqual({});
  });

  it('exposes only authorized measurement streams on a power monitoring relay', async () => {
    const h = fixture({
      id: 'relay-power',
      capabilities: [{ kind: 'switch', actions: ['read', 'turn_on', 'turn_off'] }, { kind: 'power', actions: ['read'], unit: 'W' }],
      supportedCapabilities: [{ kind: 'switch', actions: ['read'] }, { kind: 'power', actions: ['read'] }],
      authority: { bindings: [{ deviceId: 'relay-power', sourceId: 'meter', selector: 'channel:0', fields: { power: { rawKey: 'power', type: 'number' }, energy: { rawKey: 'energy', type: 'number' } } }], policy: { deviceId: 'relay-power', allowedSourcesByField: { power: ['meter'], energy: ['meter'] } } },
      observedFields: { power: 18, energy: 20 },
    });
    const model = await h.service.readDeviceModel(scope, h.device.id);
    expect(model?.history.authorizedMetrics).toEqual(['power', 'energy']);
    expect(model?.current.observations).toHaveProperty('power');
    expect(model?.current.observations).toHaveProperty('energy');
  });

  it('combines sensing and switching without conflating their authorities', async () => {
    const id = 'multi-device';
    const h = fixture({ id, authority: energridHttpObservationApproval('device:lab-lan:esp8266:324864'), observedFields: { temperature: 21 } });
    h.installation.observationAuthority = { bindings: [{ deviceId: id, sourceId: 'sensor', selector: 'env', fields: { temperature: { rawKey: 't', type: 'number' } } }], policy: { deviceId: id, allowedSourcesByField: { temperature: ['sensor'] } } };
    h.device.capabilities = [{ kind: 'switch', actions: ['turn_on'] }];
    h.device.control = { status: 'ready' };
    const model = await h.service.readDeviceModel(scope, id);
    expect(model?.observationAuthorization.status).toBe('approved');
    expect(model?.current.observations.temperature.value).toBe(21);
    expect(model?.commands.available).toEqual([expect.objectContaining({ action: 'turn_on', available: true })]);
  });

  it('describes a discovered but unenrolled device without granting readings or commands', async () => {
    const h = fixture({ id: 'candidate', trustStatus: 'discovered' });
    await expect(h.service.readDeviceModel(scope, 'candidate')).resolves.toMatchObject({
      identity: { id: 'candidate' },
      installation: { status: 'not_enrolled' },
      observationAuthorization: { status: 'none', bindings: [] },
      current: { observations: {} },
      history: { availability: 'not_available' },
      commands: { available: [] },
    });
  });

  it('keeps supported but unapproved actions out of executable commands', async () => {
    const h = fixture({ id: 'unapproved-capability', supportedCapabilities: [{ kind: 'temperature' }] });
    const model = await h.service.readDeviceModel(scope, h.device.id);
    expect(model?.capabilities).toMatchObject({ supportStatus: 'verified', supported: ['temperature'] });
    expect(model?.observationAuthorization.status).toBe('none');
    expect(model?.commands.available).toEqual([]);
  });

  it('keeps partial evidence unknown and does not infer unsupported capabilities', async () => {
    const h = fixture({ id: 'partial', discovery: { source: 'http', confidence: 0.5, reason: 'identity only' } });
    const model = await h.service.readDeviceModel(scope, h.device.id);
    expect(model?.capabilities).toMatchObject({ supportStatus: 'unknown', supported: [], evidence: { source: 'http' } });
  });

  it('resolves case-normalized device identity while preserving canonical stored identity', async () => {
    const id = 'device:upstream-lan:esp8266:324864';
    const h = fixture({ id, authority: energridHttpObservationApproval(id), observedFields: { temperature: 10 } });
    const model = await h.service.readDeviceModel(scope, id.toUpperCase());
    expect(model?.identity.id).toBe(id);
    expect(model?.observationAuthorization.status).toBe('approved');
  });
});
