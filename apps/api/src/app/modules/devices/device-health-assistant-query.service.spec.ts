import { DeviceHealthAssistantQueryService } from './device-health-assistant-query.service';

const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
const garage = {
  id: 'device:upstream-lan:esp8266:324864', tenantId: scope.tenantId, siteId: scope.siteId,
  kind: 'physical', trustStatus: 'approved', displayName: 'Energrid ESP8266 DHT22', zoneName: 'Garage',
  adapter: { driver: 'energrid-esp8266' }, metadata: { networkScope: 'upstream-lan', physicalId: 'esp8266:324864' },
} as any;
const kitchen = {
  ...garage, id: 'device:eero-lan:esp8266:324b44', zoneName: 'Kitchen',
  metadata: { networkScope: 'eero-lan', physicalId: 'esp8266:324b44' },
} as any;

function makeService(options: {
  devices?: any[];
  enrolled?: Array<{ deviceId: string }>;
  history?: any;
  diagnostic?: any;
  observation?: any;
} = {}) {
  const registry = { getDevices: jest.fn(() => options.devices || [garage, kitchen]) };
  const intelligence = {
    listDevices: jest.fn().mockResolvedValue(options.enrolled || [{ deviceId: garage.id }, { deviceId: kitchen.id }]),
    readObservations: jest.fn().mockResolvedValue(options.observation || null),
  };
  const diagnostics = {
    get: jest.fn().mockResolvedValue(options.diagnostic || null),
    queryHistory: jest.fn().mockImplementation(async (_scope: unknown, query: { deviceId: string }) => {
      const history = options.history || {
      tenantId: scope.tenantId, siteId: scope.siteId, granularity: 'hourly',
      from: '2026-10-26T10:00:00.000Z', to: '2026-10-26T11:00:00.000Z', records: [],
      analysis: {
        schemaVersion: 1, tenantId: scope.tenantId, siteId: scope.siteId,
        from: '2026-10-26T10:00:00.000Z', to: '2026-10-26T11:00:00.000Z', timezone: 'Europe/Sofia',
        granularity: 'hourly', devices: [{
          deviceId: garage.id, physicalDeviceId: 'esp8266:324864',
          firstObservedAt: '2026-10-26T10:02:00.000Z', latestObservedAt: '2026-10-26T10:58:00.000Z',
          observedSampleCount: 12, expectedSampleCount: 13, missingSampleCount: 1, coverageRatio: 12 / 13,
          coverageBasis: 'observed-sample-span', metrics: [{ name: 'wifi.rssi', status: 'available', semantics: 'gauge', statistics: {
            minimum: -70, maximum: -55, average: -62.5, sum: -750, count: 12, missingCount: 0, unit: 'dBm', source: 'http:GET:/api/v1/diagnostics',
            first: { value: -70, at: '2026-10-26T10:02:00.000Z' }, latest: { value: -55, at: '2026-10-26T10:58:00.000Z' },
          } }], failureCount: 1, failures: [{ id: 'fail-1', attemptedAt: '2026-10-26T10:30:00.000Z', reason: 'request_timeout', source: 'http:GET:/api/v1/diagnostics',
            recoveryObservedAt: '2026-10-26T10:31:00.000Z', recoveryObservedAfterMs: 60_000 }],
          bootSessionTransitions: [{ from: 'boot-old', to: 'boot-new', observedAt: '2026-10-26T10:40:00.000Z', observedAtBasis: 'server-detection-time', eventId: 'event-1', evidenceReferences: [] }],
          resetEvidence: [], resetEvents: [], events: [{ id: 'event-1', observedAt: '2026-10-26T10:40:00.000Z', detectedAt: '2026-10-26T10:40:00.000Z',
            observedAtBasis: 'server-detection-time', inferredBootAt: { at: '2026-10-26T10:35:00.000Z', basis: 'collected-at-minus-reported-uptime' },
            summary: 'Boot session changed', explanation: 'Observed in diagnostics', evidenceReferences: [] }],
        }], site: { deviceCount: 1, observedSampleCount: 12, failureCount: 1, metricAverages: [] },
        series: [], page: { limit: 200, nextCursor: null, hasMore: false },
      },
      };
      if (options.history) return history;
      return { ...history, analysis: { ...history.analysis, devices: history.analysis.devices.map((device: any) => ({ ...device, deviceId: query.deviceId })) } };
    }),
  };
  return {
    service: new DeviceHealthAssistantQueryService(registry as any, intelligence as any, diagnostics as any),
    registry, intelligence, diagnostics,
  };
}

describe('DeviceHealthAssistantQueryService', () => {
  it('queries only an enrolled device in the server scope and preserves Core statistics and provenance', async () => {
    const diagnostic = {
      tenantId: scope.tenantId, siteId: scope.siteId, deviceId: garage.id,
      sampledAt: '2026-10-26T10:58:00.000Z', lastSuccessfulContactAt: '2026-10-26T10:58:00.000Z',
      lastAttemptAt: '2026-10-26T10:59:00.000Z', collectionStatus: 'failed', connectivity: 'connected',
      current: { firmwareVersion: '0.3.0', bootSessionId: 'boot-new', uptimeMs: 1_000,
        reset: { reason: 'Power on', reasonCode: 1, exception: null },
        wifi: { connected: true, rssiDbm: -55, disconnectCount: 0, reconnectCount: 0 },
        memory: { freeHeapBytes: 30_000, heapFragmentationPct: 2, largestFreeBlockBytes: 29_000 },
        sensor: { sampleCount: 10, readFailureCount: 0 } },
      snapshots: [{ collectedAt: '2026-10-26T10:58:00.000Z', deviceObservedAt: null, protocol: 'http', method: 'GET', path: '/api/v1/diagnostics', identityVerifiedAt: '2026-10-26T10:58:00.000Z' }],
      collectionFailures: [{ id: 'failure-last', attemptedAt: '2026-10-26T10:59:00.000Z', reason: 'request_timeout', context: {
        observer: { id: 'mac', host: 'Mac-LAB', platform: 'darwin', localScopes: [{ interfaceName: 'en0', cidr: '192.168.1.25/24', address: '192.168.1.25' }] },
        target: { endpoint: 'http://192.168.1.6/api/v1/diagnostics', ipAddress: '192.168.1.6', networkScopeId: 'upstream-lan', networkScopeName: 'Upstream LAN' },
      } }],
    };
    const observation = { fields: { temperature: { value: 19.1, sourceId: 'energrid-http-status', receivedAt: '2026-10-26T10:57:00.000Z', measuredAt: '2026-10-26T10:56:59.000Z', ageSeconds: 61, freshness: 'stale' } } };
    const { service, diagnostics, intelligence } = makeService({ diagnostic, observation });

    const result = await service.read(scope, { device: 'garage sensor', range: '24h' });

    expect(result.status).toBe('available');
    expect(result.device).toMatchObject({ deviceId: garage.id, tenantId: scope.tenantId, siteId: scope.siteId, room: 'Garage' });
    expect(result.latestDiagnostic).toMatchObject({
      lastSuccessfulContactAt: diagnostic.lastSuccessfulContactAt,
      lastSuccessfulContactAtBasis: 'server-collection-time',
      observerCollectionStatus: 'failed',
      wifi: { connected: true, rssiDbm: -55 },
      provenance: { protocol: 'http', path: '/api/v1/diagnostics', deviceWallClockTimestamp: null },
    });
    expect(result.observerReachability).toMatchObject({ latestRequestSucceeded: false, latestFailure: { reason: 'request_timeout', observer: { id: 'mac' } } });
    expect(result.observerReachability.interpretation).toMatch(/does not prove/);
    expect(result.measurementFreshness.temperature).toMatchObject({ status: 'stale', value: 19.1, ageSeconds: 61 });
    expect(result.measurementFreshness.humidity.status).toBe('unavailable');
    expect(result.history.metrics[0].statistics).toMatchObject({ minimum: -70, maximum: -55, average: -62.5, count: 12 });
    expect(result.history.events[0]).toMatchObject({ observedAtBasis: 'server-detection-time', inferredBootAt: { basis: 'collected-at-minus-reported-uptime' } });
    expect(diagnostics.queryHistory).toHaveBeenCalledWith(scope, expect.objectContaining({ granularity: 'hourly', deviceId: garage.id, limit: 200 }), [
      { deviceId: garage.id, physicalDeviceId: 'esp8266:324864' },
    ]);
    expect(intelligence.readObservations).toHaveBeenCalledWith(scope, garage.id);
  });

  it('supports Bulgarian room references for a matching authorized device', async () => {
    const { service, diagnostics } = makeService({ enrolled: [{ deviceId: kitchen.id }], devices: [kitchen] });
    await service.read(scope, { device: 'датчикът в кухнята', range: '7d' });
    expect(diagnostics.queryHistory).toHaveBeenCalledWith(scope, expect.objectContaining({ deviceId: kitchen.id, granularity: 'hourly' }), [
      { deviceId: kitchen.id, physicalDeviceId: 'esp8266:324b44' },
    ]);
  });

  it('defaults an omitted range to 24 hours and uses daily summaries for 30 days', async () => {
    const { service, diagnostics } = makeService();
    await service.read(scope, { device: 'garage' });
    expect(diagnostics.queryHistory).toHaveBeenLastCalledWith(scope, expect.objectContaining({ granularity: 'hourly', limit: 200 }), expect.any(Array));
    await service.read(scope, { device: 'garage', range: '1h' });
    expect(diagnostics.queryHistory).toHaveBeenLastCalledWith(scope, expect.objectContaining({ granularity: 'raw' }), expect.any(Array));
    await service.read(scope, { device: 'garage', range: '7d' });
    expect(diagnostics.queryHistory).toHaveBeenLastCalledWith(scope, expect.objectContaining({ granularity: 'hourly' }), expect.any(Array));
    await service.read(scope, { device: 'garage', range: '30d' });
    expect(diagnostics.queryHistory).toHaveBeenLastCalledWith(scope, expect.objectContaining({ granularity: 'daily' }), expect.any(Array));
  });

  it('does not expose a device from another site or query its diagnostic store', async () => {
    const foreign = { ...garage, id: 'device:virtual-lan:esp8266:abcdef', siteId: 'site-device-lab', zoneName: 'Lab',
      metadata: { networkScope: 'virtual-lan', physicalId: 'esp8266:abcdef' } };
    const { service, diagnostics } = makeService({ devices: [garage, foreign], enrolled: [{ deviceId: garage.id }] });
    const result = await service.read(scope, { device: foreign.id });
    expect(result).toMatchObject({ status: 'not_found' });
    expect(diagnostics.get).not.toHaveBeenCalled();
    expect(diagnostics.queryHistory).not.toHaveBeenCalled();
  });

  it('does not query a same-site approved device that has no durable enrollment', async () => {
    const { service, diagnostics } = makeService({ enrolled: [{ deviceId: kitchen.id }] });
    const result = await service.read(scope, { device: 'garage' });
    expect(result).toMatchObject({ status: 'not_found' });
    expect(diagnostics.queryHistory).not.toHaveBeenCalled();
  });

  it('returns a bounded ambiguity result instead of guessing duplicate friendly names', async () => {
    const { service, diagnostics } = makeService();
    const result = await service.read(scope, { device: 'Energrid ESP8266 DHT22' });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(diagnostics.queryHistory).not.toHaveBeenCalled();
  });

  it('reports unknown names, invalid ranges and missing history without inventing findings', async () => {
    const { service } = makeService();
    expect(await service.read(scope, { device: 'unassigned device' })).toMatchObject({ status: 'not_found' });
    expect(await service.read(scope, { device: 'garage', range: '90d' as any })).toMatchObject({ status: 'invalid_request' });
    const noHistory = makeService({ history: { tenantId: scope.tenantId, siteId: scope.siteId, granularity: 'hourly', from: null, to: null, records: [],
      analysis: { schemaVersion: 1, tenantId: scope.tenantId, siteId: scope.siteId, from: '', to: '', timezone: 'UTC', granularity: 'hourly', devices: [{ deviceId: garage.id,
        physicalDeviceId: 'esp8266:324864', firstObservedAt: null, latestObservedAt: null, observedSampleCount: 0, expectedSampleCount: 1, missingSampleCount: 1,
        coverageRatio: null, coverageBasis: 'requested-window-no-samples', metrics: [{ name: 'wifi.rssi', status: 'unavailable', reason: 'no_samples_in_range' }],
        failureCount: 0, failures: [], bootSessionTransitions: [], resetEvidence: [], resetEvents: [], events: [] }],
        site: { deviceCount: 1, observedSampleCount: 0, failureCount: 0, metricAverages: [] }, series: [], page: { limit: 200, nextCursor: null, hasMore: false } } } });
    const result = await noHistory.service.read(scope, { device: 'garage' });
    expect(result).toMatchObject({ status: 'no_history', history: { coverage: { observedSampleCount: 0, coverageRatio: null } } });
  });

  it('rejects a query response containing a different device or site', async () => {
    const bad = makeService({ history: { tenantId: scope.tenantId, siteId: scope.siteId, granularity: 'hourly', from: null, to: null, records: [],
      analysis: { tenantId: scope.tenantId, siteId: scope.siteId, timezone: 'UTC', devices: [{ deviceId: kitchen.id }] } } });
    await expect(bad.service.read(scope, { device: 'garage' })).rejects.toThrow(/invalid scope or device/);
  });
});
