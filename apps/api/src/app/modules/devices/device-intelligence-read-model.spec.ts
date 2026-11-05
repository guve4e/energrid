import { DeviceIntelligenceQueryService } from './device-intelligence-query.service';
import { energridHttpObservationApproval } from './adapters/inbound/energrid/energrid-http-observation-approval';
import { shellyHttpEm1Approval } from './integrations/shelly/shelly-http-em1-observation-approval';
import { shellyMqttObservationApproval } from './adapters/inbound/shelly/shelly-mqtt-observation-approval';

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
  displayName?: string;
  measurementHistory?: any;
  telemetryConfig?: any;
}) {
  const device = {
    id: input.id, ...scope, siteName: 'LAB', kind: 'physical' as const,
    trustStatus: input.trustStatus ?? 'approved', displayName: input.displayName ?? input.id,
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
    input.measurementHistory as never, input.telemetryConfig as never,
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

  it.each([
    ['HTTP EM50', 'shellyproem50-8c4f00dbd258:em1:0', (id: string) => shellyHttpEm1Approval(id)],
    ['MQTT Pro 2PM', 'shellypro2pm-ec6260888084:switch:0', (id: string) => shellyMqttObservationApproval(id)],
  ])('projects transport-independent power history authorization for %s', async (_label, id, approval) => {
    const h = fixture({ id, authority: approval(id), observedFields: undefined });
    const model = await h.service.readDeviceModel(scope, id);
    expect(model?.history.authorizedMetrics).toEqual(['power']);
    expect(model?.observationAuthorization.bindings).toEqual([expect.objectContaining({ fields: ['power'] })]);
    expect(model?.history.endpoint).toContain(encodeURIComponent(id));
  });

  it('updates history eligibility when the persisted source authority is removed', async () => {
    const id = 'shellyproem50-8c4f00dbd258:em1:0';
    const h = fixture({ id, authority: shellyHttpEm1Approval(id) });
    await expect(h.service.readDeviceModel(scope, id)).resolves.toMatchObject({ history: { authorizedMetrics: ['power'] } });
    h.installation.observationAuthority = undefined;
    await expect(h.service.readDeviceModel(scope, id)).resolves.toMatchObject({ history: { authorizedMetrics: [] } });
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

  describe('authorized canonical measurement summaries', () => {
    const em50Id = 'shellyproem50-8c4f00dbd258:em1:0';

    function measurementRow(id = em50Id, source = 'shelly-http-em1', overrides: Record<string, unknown> = {}) {
      const timestamp = new Date(Date.now() - 2_000).toISOString();
      return {
        tenantId: scope.tenantId, siteId: scope.siteId, deviceId: id,
        physicalDeviceId: id.split(':')[0], componentId: 'device',
        channel: 'power', metric: 'power', unit: 'W', value: 1483.3,
        quality: 'measured', source, provenance: `approved:${source}`,
        sampleId: 'sample-1', observedAt: timestamp, receivedAt: timestamp,
        ...overrides,
      };
    }

    it.each([
      ['HTTP EM50', em50Id, (id: string) => shellyHttpEm1Approval(id), 'shelly-http-em1'],
      ['MQTT Pro 2PM', 'shellypro2pm-ec6260888084:switch:0', (id: string) => shellyMqttObservationApproval(id), 'shelly-mqtt'],
    ])('%s measurements use the same PostgreSQL read for current and history', async (_label, id, approve, source) => {
      const latest = measurementRow(id as string, source as string);
      const prior = measurementRow(id as string, source as string, { sampleId: 'sample-0', value: 1200, observedAt: new Date(Date.now() - 60_000).toISOString() });
      const history = { latest: jest.fn().mockResolvedValue(latest), read: jest.fn().mockResolvedValue([prior, latest]) };
      const h = fixture({
        id: id as string,
        displayName: 'House Mainline',
        authority: (approve as (id: string) => unknown)(id as string),
        observedFields: undefined,
        measurementHistory: history,
      });

      const byId = await h.service.readMeasurementSummary(scope, id as string, 'power', '24h');
      const byName = await h.service.readMeasurementSummary(scope, 'House Mainline', 'power', '24h');
      expect(byId).toMatchObject({
        status: 'available', deviceId: id, displayName: 'House Mainline', metric: 'power', unit: 'W',
        current: { status: 'fresh', value: 1483.3, source, observedAt: latest.observedAt },
        history: {
          status: 'available', sampleCount: 2, minimum: 1200, median: 1341.65, maximum: 1483.3, unit: 'W', sources: [source],
          energyEstimate: {
            status: 'partial_estimate', method: 'trapezoidal', signedEnergyKwh: expect.any(Number),
            coveredDurationSeconds: expect.any(Number), requestedDurationSeconds: 86400,
            maximumIntegratedIntervalSeconds: 300, uncoveredGaps: expect.any(Array),
          },
        },
      });
      const coveredSeconds = (byId as { history: { energyEstimate: { coveredDurationSeconds: number } } })
        .history.energyEstimate.coveredDurationSeconds;
      expect(coveredSeconds).toBeGreaterThanOrEqual(50);
      expect(coveredSeconds).toBeLessThanOrEqual(60);
      expect(byName).toMatchObject({ status: 'available', deviceId: id });
      expect(history.latest).toHaveBeenCalledWith(expect.objectContaining({ tenantId: scope.tenantId, siteId: scope.siteId, deviceId: id, componentId: 'device', channel: 'power', metric: 'power', sources: [source] }));
      expect(history.read).toHaveBeenCalledWith(expect.objectContaining({ tenantId: scope.tenantId, siteId: scope.siteId, deviceId: id, componentId: 'device', channel: 'power', metric: 'power', limit: 5000, sources: [source] }));
    });

    it('rejects a field without persisted source approval and never resolves outside the authenticated site', async () => {
      const history = { latest: jest.fn(), read: jest.fn() };
      const h = fixture({ id: em50Id, authority: shellyHttpEm1Approval(em50Id), measurementHistory: history });
      await expect(h.service.readMeasurementSummary(scope, em50Id, 'humidity'))
        .resolves.toEqual({ status: 'unauthorized', deviceId: em50Id, metric: 'humidity' });
      await expect(h.service.readMeasurementSummary({ ...scope, siteId: 'site-other' }, em50Id, 'power'))
        .resolves.toEqual({ status: 'not_found' });
      await expect(h.service.readMeasurementSummary(scope, `${em50Id}-other`, 'power'))
        .resolves.toEqual({ status: 'not_found' });
      expect(history.latest).not.toHaveBeenCalled();
      expect(history.read).not.toHaveBeenCalled();
    });

    it('rechecks source and field authority on each read and adds no device permissions', async () => {
      const latest = measurementRow();
      const history = { latest: jest.fn().mockResolvedValue(latest), read: jest.fn().mockResolvedValue([latest]) };
      const h = fixture({ id: em50Id, authority: shellyHttpEm1Approval(em50Id), measurementHistory: history });
      const before = structuredClone(h.device.capabilities);
      await expect(h.service.readMeasurementSummary(scope, em50Id, 'power'))
        .resolves.toMatchObject({ status: 'available', authority: 'approved' });
      h.installation.observationAuthority = undefined;
      await expect(h.service.readMeasurementSummary(scope, em50Id, 'power'))
        .resolves.toEqual({ status: 'unauthorized', deviceId: em50Id, metric: 'power' });
      expect(h.device.capabilities).toEqual(before);
      expect(history.latest).toHaveBeenCalledTimes(1);
      expect(history.read).toHaveBeenCalledTimes(1);
    });

    it('uses a stricter configured power heartbeat but never loosens the five-minute integration cap', async () => {
      const latest = measurementRow(em50Id, 'shelly-http-em1', { observedAt: new Date(Date.now() - 2_000).toISOString() });
      const prior = measurementRow(em50Id, 'shelly-http-em1', { sampleId: 'older', observedAt: new Date(Date.now() - 8 * 60_000).toISOString() });
      const history = { latest: jest.fn().mockResolvedValue(latest), read: jest.fn().mockResolvedValue([prior, latest]) };
      const h = fixture({
        id: em50Id,
        authority: shellyHttpEm1Approval(em50Id),
        measurementHistory: history,
        telemetryConfig: { historyPolicies: { power: { meaningfulChange: 5, maxHeartbeatMs: 10 * 60_000 } } },
      });
      await expect(h.service.readMeasurementSummary(scope, em50Id, 'power', '1h'))
        .resolves.toMatchObject({ history: { energyEstimate: { status: 'insufficient_coverage', signedEnergyKwh: null, maximumIntegratedIntervalSeconds: 300 } } });
    });

    it('distinguishes missing, stale, invalid, and possibly incomplete history', async () => {
      const emptyHistory = { latest: jest.fn().mockResolvedValue(null), read: jest.fn().mockResolvedValue([]) };
      const missing = fixture({ id: em50Id, authority: shellyHttpEm1Approval(em50Id), measurementHistory: emptyHistory });
      await expect(missing.service.readMeasurementSummary(scope, em50Id, 'power'))
        .resolves.toMatchObject({ current: { status: 'unavailable' }, history: { status: 'empty', sampleCount: 0, coverage: { firstObservedAt: null } } });

      const staleRow = measurementRow(em50Id, 'shelly-http-em1', { observedAt: '2020-01-01T00:00:00.000Z', receivedAt: '2020-01-01T00:00:01.000Z' });
      const staleHistory = { latest: jest.fn().mockResolvedValue(staleRow), read: jest.fn().mockResolvedValue([]) };
      const stale = fixture({ id: em50Id, authority: shellyHttpEm1Approval(em50Id), measurementHistory: staleHistory });
      await expect(stale.service.readMeasurementSummary(scope, em50Id, 'power'))
        .resolves.toMatchObject({ current: { status: 'stale', value: 1483.3 }, history: { status: 'empty' } });

      const invalidHistory = { latest: jest.fn().mockResolvedValue(measurementRow(em50Id, 'shelly-http-em1', { quality: 'invalid', value: null })), read: jest.fn().mockResolvedValue([]) };
      const invalid = fixture({ id: em50Id, authority: shellyHttpEm1Approval(em50Id), measurementHistory: invalidHistory });
      await expect(invalid.service.readMeasurementSummary(scope, em50Id, 'power'))
        .resolves.toMatchObject({ current: { status: 'invalid', value: null } });

      const boundedRows = Array.from({ length: 5000 }, (_, index) => measurementRow(em50Id, 'shelly-http-em1', { sampleId: `sample-${index}`, value: index }));
      const fullHistory = { latest: jest.fn().mockResolvedValue(measurementRow()), read: jest.fn().mockResolvedValue(boundedRows) };
      const full = fixture({ id: em50Id, authority: shellyHttpEm1Approval(em50Id), measurementHistory: fullHistory });
      await expect(full.service.readMeasurementSummary(scope, em50Id, 'power'))
        .resolves.toMatchObject({ history: { status: 'possibly_incomplete', sampleCount: 5000 } });
    });
  });
});
