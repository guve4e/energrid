import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicLevel } from 'classic-level';
import {
  DeviceFirmwareDiagnosticsService,
  deriveFirmwareHealthEvents,
  parseFirmwareDiagnosticSample,
  type FirmwareDiagnosticSample,
} from './device-firmware-diagnostics';
import {
  applyDeviceHealthObservation,
  summarizeDailyFromHourly,
  type DeviceHealthBucketSummary,
  type DeviceHealthObservation,
} from './device-health-history';

const deviceId = 'device:upstream-lan:esp8266:324864';
const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
const sample = (overrides: Partial<FirmwareDiagnosticSample> = {}): FirmwareDiagnosticSample => ({
  schemaVersion: 1,
  deviceId: 'esp8266:324864',
  firmwareVersion: '0.3.0',
  bootSessionId: 'esp8266-324864-1234abcd',
  uptimeMs: 20_000,
  reset: { reason: 'External System', reasonCode: 6, exception: null },
  memory: { freeHeapBytes: 24_000, heapFragmentationPct: 12, largestFreeBlockBytes: 18_000 },
  wifi: { connected: true, rssiDbm: -53, disconnectCount: 0, reconnectCount: 0 },
  sensor: { sampleCount: 10, readFailureCount: 0 },
  ...overrides,
});

describe('firmware diagnostics', () => {
  it('parses only the expected bounded physical identity and preserves reset evidence', () => {
    const source = sample({ reset: { reason: 'Hardware Watchdog', reasonCode: 1, exception: null } });
    expect(parseFirmwareDiagnosticSample(source, source.deviceId)).toEqual(source);
    expect(parseFirmwareDiagnosticSample({ ...source, deviceId: 'ESP8266:324864' }, source.deviceId)?.deviceId).toBe(source.deviceId);
    expect(parseFirmwareDiagnosticSample({ ...source, deviceId: 'esp8266:ffffff' }, source.deviceId)).toBeNull();
    expect(parseFirmwareDiagnosticSample({ ...source, uptimeMs: Number.MAX_SAFE_INTEGER + 1 }, source.deviceId)).toBeNull();
    expect(parseFirmwareDiagnosticSample({ ...source, bootSessionId: 'new-session' }, source.deviceId)).toBeNull();
    expect(parseFirmwareDiagnosticSample({ ...source, wifi: { ...source.wifi, connected: false, rssiDbm: null } }, source.deviceId)?.wifi.rssiDbm).toBeNull();
  });

  it('classifies watchdog, exception, unknown resets and repeated boot sessions without claiming a power fault', () => {
    const at = '2026-10-24T10:00:00.000Z';
    expect(deriveFirmwareHealthEvents(null, sample({ reset: { reason: 'Hardware Watchdog', reasonCode: 1, exception: null } }), at)
      .map(item => item.kind)).toContain('watchdog-reset');
    expect(deriveFirmwareHealthEvents(null, sample({ reset: { reason: 'Exception', reasonCode: 2, exception: {
      cause: 3, epc1: 1, epc2: 0, epc3: 0, address: 10, depc: 0,
    } } }), at).map(item => item.kind)).toContain('exception-reset');
    const unknown = deriveFirmwareHealthEvents(null, sample({ reset: { reason: 'Unknown', reasonCode: 0, exception: null } }), at)
      .find(item => item.kind === 'reset-cause-unknown');
    expect(unknown?.confidence).toBe('possible');
    expect(unknown?.explanation).toContain('do not establish a power-supply fault');
    expect(deriveFirmwareHealthEvents(null, sample({
      memory: { freeHeapBytes: 7000, heapFragmentationPct: 55, largestFreeBlockBytes: 2000 },
      wifi: { connected: false, rssiDbm: null, disconnectCount: 3, reconnectCount: 2 },
    }), at).map(item => item.kind)).toEqual(expect.arrayContaining(['memory-warning', 'wifi-instability']));
    const previous = { current: sample(), deviceId, tenantId: scope.tenantId, siteId: scope.siteId,
      sampledAt: at, events: [], restartCount10m: 0, connectivity: 'connected' as const };
    const next = sample({ bootSessionId: 'esp8266-324864-1234abce', uptimeMs: 100 });
    const transition = deriveFirmwareHealthEvents(previous, next, at).find(item => item.kind === 'reboot-detected');
    expect(transition).toMatchObject({ observedAt: at, observedAtBasis: 'server-detection-time', detectedAt: at,
      inferredBootAt: { at: '2026-10-24T09:59:59.900Z', basis: 'collected-at-minus-reported-uptime' },
      evidenceReferences: [{ type: 'firmware-diagnostic-snapshot', observedAt: at, bootSessionId: next.bootSessionId }] });
    expect(deriveFirmwareHealthEvents(previous, sample({ uptimeMs: 100 }), at)
      .find(item => item.kind === 'reboot-detected')?.explanation).toContain('uptime decreased');
    const rebootEvents = [
      { id: '1', kind: 'reboot-detected' as const, observedAt: at, bootSessionId: '1', confidence: 'confirmed' as const, summary: '', explanation: '' },
      { id: '2', kind: 'reboot-detected' as const, observedAt: at, bootSessionId: '2', confidence: 'confirmed' as const, summary: '', explanation: '' },
    ];
    expect(deriveFirmwareHealthEvents(previous, next, at, rebootEvents).map(item => item.kind)).toContain('repeated-reboots');
  });

  it('deduplicates repeated evidence, detects reboots, bounds history and recovers after restart with scope isolation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-fw-diagnostics-'));
    const first = new DeviceFirmwareDiagnosticsService(directory);
    try {
      const at = '2026-10-24T10:00:00.000Z';
      await first.record(scope, deviceId, 'esp8266:324864', sample(), at);
      await first.record(scope, deviceId, 'esp8266:324864', sample(), '2026-10-24T10:00:01.000Z');
      let stored = await first.get(scope, deviceId);
      expect(stored?.events.map(item => item.kind)).not.toContain('reboot-detected');
      const restarted = sample({ bootSessionId: 'esp8266-324864-1234abce', uptimeMs: 100,
        reset: { reason: 'Software Watchdog', reasonCode: 3, exception: null } });
      await first.record(scope, deviceId, 'esp8266:324864', restarted, '2026-10-24T10:00:02.000Z');
    } finally {
      await first.onModuleDestroy();
    }
    const recovered = new DeviceFirmwareDiagnosticsService(directory);
    try {
      const stored = await recovered.get(scope, deviceId);
      expect(stored?.current.bootSessionId).toBe('esp8266-324864-1234abce');
      expect(stored?.events.filter(item => item.kind === 'watchdog-reset')).toHaveLength(1);
      expect(stored?.events.filter(item => item.kind === 'reboot-detected')).toHaveLength(1);
      expect(await recovered.get({ tenantId: 'other', siteId: scope.siteId }, deviceId)).toBeNull();
      expect(await recovered.get(scope, 'another-device')).toBeNull();
      for (let index = 0; index < 110; index++) {
        const session = `esp8266-324864-${index.toString(16).padStart(8, '0')}`;
        await recovered.record(scope, deviceId, 'esp8266:324864', sample({ bootSessionId: session, uptimeMs: 0 }),
          new Date(Date.parse('2026-10-24T10:01:00.000Z') + index * 1000).toISOString());
      }
      expect((await recovered.get(scope, deviceId))?.events.length).toBeLessThanOrEqual(100);
      const durableEvents = await recovered.queryHistory(scope, { deviceId, granularity: 'events', limit: 1000,
        from: '2026-10-24T10:00:00.000Z', to: '2026-10-24T10:10:00.000Z' });
      expect(durableEvents.records.length).toBeGreaterThan(100);
      expect(new Set(durableEvents.records.map(item => (item as { id: string }).id)).size).toBe(durableEvents.records.length);
    } finally {
      await recovered.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains successful snapshots when a bounded collection failure is recorded and recovers both after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-fw-failure-'));
    const first = new DeviceFirmwareDiagnosticsService(directory);
    const successAt = '2026-10-24T10:00:00.000Z';
    const failedAt = '2026-10-24T10:01:00.000Z';
    const context = {
      observer: { id: 'Mac-LAB/darwin', host: 'Mac-LAB', platform: 'darwin', localScopes: [
        { interfaceName: 'en0', cidr: '192.168.1.25/24', address: '192.168.1.25' },
      ] },
      target: { endpoint: 'http://192.168.7.48', ipAddress: '192.168.7.48', networkScopeId: 'eero-lan', networkScopeName: 'Eero LAN' },
    };
    try {
      await first.record(scope, deviceId, 'esp8266:324864', sample(), successAt);
      const afterFailure = await first.recordFailure(scope, deviceId, 'esp8266:324864', 'request_timeout', failedAt, context);
      expect(afterFailure.current).toEqual(sample());
      expect(afterFailure.snapshots).toHaveLength(1);
      expect(afterFailure.lastSuccessfulContactAt).toBe(successAt);
      expect(afterFailure.lastAttemptAt).toBe(failedAt);
      expect(afterFailure.collectionStatus).toBe('failed');
      expect(afterFailure.collectionFailures).toEqual([
        expect.objectContaining({ attemptedAt: failedAt, reason: 'request_timeout', context }),
      ]);
      // A remote communications failure is not evidence that device Wi-Fi disconnected.
      expect(afterFailure.connectivity).toBe('connected');
    } finally {
      await first.onModuleDestroy();
    }
    const recovered = new DeviceFirmwareDiagnosticsService(directory);
    try {
      const afterRestart = await recovered.get(scope, deviceId);
      expect(afterRestart?.current).toEqual(sample());
      expect(afterRestart?.snapshots[0]).toEqual(expect.objectContaining({
        collectedAt: successAt,
        deviceObservedAt: null,
        protocol: 'http',
        method: 'GET',
        path: '/api/v1/diagnostics',
      }));
      expect(afterRestart?.collectionFailures[0].reason).toBe('request_timeout');
      expect(afterRestart?.collectionFailures[0].context).toEqual(context);
      expect(afterRestart?.lastSuccessfulContactAt).toBe(successAt);
    } finally {
      await recovered.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('exposes typed Core statistics and recovery correlation through the scoped history adapter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-fw-query-'));
    const store = new DeviceFirmwareDiagnosticsService(directory, { expectedIntervalMs: 60_000 });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T12:00:00.000Z'));
    const firstAt = '2026-10-25T20:00:00.000Z';
    const failedAt = '2026-10-25T20:01:00.000Z';
    const recoveredAt = '2026-10-25T20:02:00.000Z';
    try {
      await store.record(scope, deviceId, 'esp8266:324864', sample({ wifi: { ...sample().wifi, rssiDbm: -70 } }), firstAt);
      await store.recordFailure(scope, deviceId, 'esp8266:324864', 'request_timeout', failedAt);
      await store.record(scope, deviceId, 'esp8266:324864', sample({ wifi: { ...sample().wifi, rssiDbm: -50 },
        bootSessionId: 'esp8266-324864-1234abce' }), recoveredAt);
      const result = await store.queryHistory(scope, { deviceId, granularity: 'hourly',
        from: firstAt, to: '2026-10-25T21:00:00.000Z', timezone: 'Europe/Sofia' });
      expect(result.analysis).toMatchObject({ tenantId: scope.tenantId, siteId: scope.siteId,
        timezone: 'Europe/Sofia', site: { deviceCount: 1, failureCount: 1 } });
      const device = result.analysis!.devices[0];
      expect(device.metrics.find(metric => metric.name === 'wifi.rssi')?.statistics)
        .toMatchObject({ minimum: -70, maximum: -50, average: -60, count: 2, unit: 'dBm' });
      expect(device.failures[0]).toMatchObject({ recoveryObservedAt: recoveredAt, recoveryObservedAfterMs: 60_000 });
      expect(device.bootSessionTransitions).toHaveLength(1);
      const firstPage = await store.queryHistory(scope, { deviceId, granularity: 'raw', from: firstAt, to: recoveredAt, limit: 1 });
      const nextPage = await store.queryHistory(scope, { deviceId, granularity: 'raw', from: firstAt, to: recoveredAt,
        limit: 1, cursor: firstPage.analysis!.page.nextCursor! });
      expect(firstPage.records).toHaveLength(1);
      expect(nextPage.records).toHaveLength(1);
      expect((firstPage.records[0] as { collectedAt: string }).collectedAt)
        .not.toBe((nextPage.records[0] as { collectedAt: string }).collectedAt);
      expect((await store.queryHistory({ ...scope, siteId: 'site-device-lab' }, { deviceId, granularity: 'hourly',
        from: firstAt, to: '2026-10-25T21:00:00.000Z' })).analysis?.devices).toEqual([]);
      expect((await store.queryHistory(scope, { granularity: 'hourly', from: firstAt,
        to: '2026-10-25T21:00:00.000Z' }, [])).analysis?.devices).toEqual([]);
    } finally {
      clock.mockRestore();
      await store.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stores a failure without fabricating a successful sample', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-fw-first-failure-'));
    const store = new DeviceFirmwareDiagnosticsService(directory);
    try {
      const view = await store.recordFailure(scope, deviceId, 'esp8266:324864', 'endpoint_unverified', '2026-10-24T10:00:00.000Z');
      expect(view.current).toBeNull();
      expect(view.snapshots).toEqual([]);
      expect(view.lastSuccessfulContactAt).toBeNull();
      expect(view.connectivity).toBe('unknown');
      expect(view.collectionFailures[0].reason).toBe('endpoint_unverified');
    } finally {
      await store.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates idempotent UTC summaries with gauge extrema, weighted counts, missing coverage, and boot-scoped counters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-health-summary-'));
    const store = new DeviceFirmwareDiagnosticsService(directory, { expectedIntervalMs: 60_000 });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T12:00:00.000Z'));
    try {
      await store.record(scope, deviceId, 'esp8266:324864', sample({
        memory: { freeHeapBytes: 20_000, heapFragmentationPct: null, largestFreeBlockBytes: 15_000 },
        wifi: { connected: true, rssiDbm: -50, disconnectCount: 4, reconnectCount: 2 },
        uptimeMs: 10_000,
      }), '2026-10-24T10:00:00.000Z');
      const second = sample({
        memory: { freeHeapBytes: 18_000, heapFragmentationPct: 20, largestFreeBlockBytes: 12_000 },
        wifi: { connected: true, rssiDbm: -70, disconnectCount: 5, reconnectCount: 2 },
        uptimeMs: 70_000,
      });
      await store.record(scope, deviceId, 'esp8266:324864', second, '2026-10-24T10:02:00.000Z');
      // Reprocessing the same stored observation is idempotent.
      const view = await store.get(scope, deviceId);
      const duplicate = view!.snapshots[1];
      await store.record(scope, deviceId, 'esp8266:324864', duplicate.sample, duplicate.collectedAt);
      const range = { from: '2026-10-24T10:00:00.000Z', to: '2026-10-24T11:00:00.000Z' };
      const hourly = await store.queryHistory(scope, { deviceId, granularity: 'hourly', ...range });
      const hour = hourly.records[0] as { sampleCount: number; expectedSampleCount: number; missingSampleCount: number;
        metrics: Record<string, { minimum: number; maximum: number; sum: number; sampleCount: number; missingSampleCount: number }>;
        counters: Record<string, Array<{ bootSessionId: string; delta: number | null }>> };
      expect(hour.sampleCount).toBe(2);
      expect(hour.expectedSampleCount).toBe(3);
      expect(hour.missingSampleCount).toBe(1);
      expect(hour.metrics['wifi.rssi']).toMatchObject({ minimum: -70, maximum: -50, sum: -120, sampleCount: 2, missingSampleCount: 1 });
      expect(hour.metrics['memory.fragmentation']).toMatchObject({ minimum: 20, maximum: 20, sampleCount: 1, missingSampleCount: 2 });
      expect(hour.counters.uptime).toHaveLength(1);
      expect(hour.counters.uptime[0]).toMatchObject({ bootSessionId: sample().bootSessionId, delta: 60_000 });
      const daily = await store.queryHistory(scope, { deviceId, granularity: 'daily',
        from: '2026-10-24T00:00:00.000Z', to: '2026-10-25T00:00:00.000Z' });
      expect((daily.records[0] as { sampleCount: number }).sampleCount).toBe(2);
      expect((await store.queryHistory({ ...scope, siteId: 'site-device-lab' }, { granularity: 'hourly', ...range })).records).toEqual([]);
      expect((await store.queryHistory(scope, { deviceId, granularity: 'raw', ...range })).records).toHaveLength(2);
    } finally {
      clock.mockRestore();
      await store.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves daily evidence and independent incidents across raw/hourly expiry and process restart', async () => {
    // Keep the fixed Oct 26 samples inside this test's one-day raw window regardless
    // of the wall clock when the suite is run. Retention behavior stays unchanged.
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T12:00:00.000Z'));
    const directory = await mkdtemp(join(tmpdir(), 'energrid-health-retention-'));
    const options = { rawSampleDays: 1, hourlySummaryDays: 2, dailySummaryDays: 30,
      significantEventDays: 3650, communicationFailureDays: 5, expectedIntervalMs: 60_000,
      retentionSweepIntervalMs: 0 };
    const first = new DeviceFirmwareDiagnosticsService(directory, options);
    try {
      await first.record(scope, deviceId, 'esp8266:324864', sample({
        reset: { reason: 'Exception', reasonCode: 2, exception: null },
      }), '2026-10-20T10:00:00.000Z');
      await first.recordFailure(scope, deviceId, 'esp8266:324864', 'request_timeout', '2026-10-20T10:01:00.000Z');
      await first.record(scope, deviceId, 'esp8266:324864', sample({ uptimeMs: 200_000 }), '2026-10-26T10:00:00.000Z');
    } finally {
      await first.onModuleDestroy();
    }
    const recovered = new DeviceFirmwareDiagnosticsService(directory, options);
    try {
      const recent = { from: '2026-10-26T00:00:00.000Z', to: '2026-10-26T11:00:00.000Z' };
      const retained = { from: '2026-10-20T00:00:00.000Z', to: '2026-10-26T12:00:00.000Z' };
      expect((await recovered.queryHistory(scope, { deviceId, granularity: 'raw', ...recent })).records).toHaveLength(1);
      expect((await recovered.queryHistory(scope, { deviceId, granularity: 'hourly', ...retained })).records)
        .toEqual(expect.arrayContaining([expect.objectContaining({ bucketStartAt: '2026-10-26T10:00:00.000Z' })]));
      expect((await recovered.queryHistory(scope, { deviceId, granularity: 'hourly', ...retained })).records)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ bucketStartAt: '2026-10-20T10:00:00.000Z' })]));
      expect((await recovered.queryHistory(scope, { deviceId, granularity: 'daily',
        from: '2026-10-20T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' })).records)
        .toEqual(expect.arrayContaining([expect.objectContaining({ bucketStartAt: '2026-10-20T00:00:00.000Z', sampleCount: 1 })]));
      const events = await recovered.queryHistory(scope, { deviceId, granularity: 'events', ...retained });
      expect(events.records).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: 'exception-reset', tenantId: scope.tenantId, siteId: scope.siteId,
        physicalDeviceId: 'esp8266:324864', observedAtBasis: 'server-detection-time',
      })]));
      expect((await recovered.queryHistory(scope, { deviceId, granularity: 'failures', ...retained })).records)
        .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'request_timeout', physicalDeviceId: 'esp8266:324864' })]));
    } finally {
      await recovered.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
      now.mockRestore();
    }
  });

  it('migrates legacy history on a failed poll, preserves unknown legacy provenance, and keeps migrated events beyond the view limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-health-legacy-migration-'));
    const legacyAt = '2026-10-24T08:59:30.172Z';
    const oldEvents = Array.from({ length: 87 }, (_, index) => ({
      id: `legacy-event-${index}`,
      kind: index < 45 ? 'reboot-detected' : index < 80 ? 'repeated-reboots' : index < 86 ? 'exception-reset' : 'wifi-instability',
      observedAt: new Date(Date.parse(legacyAt) + index * 1000).toISOString(),
      bootSessionId: `legacy-boot-${index}`,
      confidence: 'confirmed',
      summary: `Legacy event ${index}`,
      explanation: 'Redacted migration fixture.',
    }));
    const oldFailures = Array.from({ length: 8 }, (_, index) => ({
      id: `legacy-failure-${index}`,
      attemptedAt: new Date(Date.parse(legacyAt) + index * 60_000).toISOString(),
      reason: 'request_timeout',
    }));
    const seed = new ClassicLevel<string, unknown>(directory, { valueEncoding: 'json' });
    await seed.open();
    await seed.put(`firmware-diagnostics:${scope.tenantId}:${scope.siteId}:${encodeURIComponent(deviceId)}`, {
      schemaVersion: 1, deviceId, tenantId: scope.tenantId, siteId: scope.siteId,
      sampledAt: legacyAt, current: sample(),
      snapshots: [{ collectedAt: legacyAt, deviceObservedAt: null, protocol: 'http', method: 'GET',
        path: '/api/v1/diagnostics', identityVerifiedAt: legacyAt, sample: sample() }],
      lastAttemptAt: legacyAt, lastSuccessfulContactAt: legacyAt, collectionStatus: 'success',
      collectionFailures: oldFailures, events: oldEvents, restartCount10m: 0, connectivity: 'connected',
    });
    await seed.close();
    const store = new DeviceFirmwareDiagnosticsService(directory);
    try {
      // A failed poll is sufficient to migrate history; no successful response from the device is needed.
      await store.recordFailure(scope, deviceId, 'esp8266:324864', 'request_timeout', '2026-10-26T10:00:00.000Z');
    } finally {
      await store.onModuleDestroy();
    }
    const recovered = new DeviceFirmwareDiagnosticsService(directory);
    let recoveredClosed = false;
    try {
      const legacyRange = { from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T11:00:00.000Z' };
      const events = await recovered.queryHistory(scope, { deviceId, granularity: 'events', limit: 1000, ...legacyRange });
      const failures = await recovered.queryHistory(scope, { deviceId, granularity: 'failures', limit: 1000, ...legacyRange });
      expect(events.records).toHaveLength(87);
      expect(events.records[0]).toMatchObject({
        id: 'legacy-event-0', observedAt: legacyAt,
        deduplicationKey: 'reboot-detected:legacy-boot-0',
        tenantId: scope.tenantId, siteId: scope.siteId, physicalDeviceId: 'esp8266:324864',
      });
      expect(events.records[0]).not.toHaveProperty('source');
      expect(events.records[0]).not.toHaveProperty('observedAtBasis');
      expect(events.analysis?.devices[0].events[0]).toMatchObject({
        source: null, observedAtBasis: null, detectedAt: null, inferredBootAt: null, evidenceReferences: [],
      });
      expect(failures.records).toHaveLength(9); // eight historical rows plus the unavailable-device attempt
      expect(failures.records[0]).toMatchObject({ id: 'legacy-failure-0', attemptedAt: legacyAt, reason: 'request_timeout' });

      // More than 100 subsequent events can trim the compatibility view without evicting
      // independently persisted legacy event rows.
      for (let index = 0; index < 110; index++) {
        await recovered.record(scope, deviceId, 'esp8266:324864', sample({
          bootSessionId: `new-session-${index.toString().padStart(3, '0')}`, uptimeMs: 1,
        }), new Date(Date.parse('2026-10-26T10:01:00.000Z') + index * 1000).toISOString());
      }
      expect((await recovered.get(scope, deviceId))?.events.length).toBeLessThanOrEqual(100);
      const durableAfterRotation = await recovered.queryHistory(scope, { deviceId, granularity: 'events', limit: 1000, ...legacyRange });
      expect(durableAfterRotation.records.filter(item => String((item as { id: string }).id).startsWith('legacy-event-'))).toHaveLength(87);
      expect(durableAfterRotation.records.length).toBeGreaterThan(100);
      expect(new Set(durableAfterRotation.records.map(item => (item as { id: string }).id)).size).toBe(durableAfterRotation.records.length);
      await recovered.onModuleDestroy();
      recoveredClosed = true;
      const audit = new ClassicLevel<string, unknown>(directory, { valueEncoding: 'json' });
      await audit.open();
      try {
        const devicePart = encodeURIComponent(deviceId);
        expect(await audit.get(`device-health:meta:${scope.tenantId}:${scope.siteId}:${devicePart}:events-v1-migrated`))
          .toEqual({ completedAt: '2026-10-26T10:00:00.000Z' });
        expect(await audit.get(`device-health:meta:${scope.tenantId}:${scope.siteId}:${devicePart}:failures-v1-migrated`))
          .toEqual({ completedAt: '2026-10-26T10:00:00.000Z' });
        let durableLegacyEventRows = 0;
        for await (const [_key, value] of audit.iterator({
          gte: `device-health:event:${scope.tenantId}:${scope.siteId}:${devicePart}:`,
          lte: `device-health:event:${scope.tenantId}:${scope.siteId}:${devicePart}:\xff`,
        })) {
          if (value && typeof value === 'object' && 'id' in value &&
              String((value as { id: unknown }).id).startsWith('legacy-event-')) durableLegacyEventRows++;
        }
        expect(durableLegacyEventRows).toBe(87);
      } finally {
        await audit.close();
      }
    } finally {
      if (!recoveredClosed) await recovered.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('faithfully rolls up the sanitized first-night capture without retaining local identities or absolute timestamps', async () => {
    const fixturePath = join(__dirname, 'fixtures', 'device-health-overnight-redacted.json');
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      expectedIntervalMs: number;
      devices: Array<{ alias: string; samples: Array<Record<string, unknown>>; events: unknown[]; failures: unknown[] }>;
    };
    const serializedFixture = JSON.stringify(fixture);
    expect(serializedFixture).not.toContain('324864');
    expect(serializedFixture).not.toContain('324b44');
    expect(serializedFixture).not.toContain('3254b7');
    expect(serializedFixture).not.toContain('192.168.');
    expect(fixture.devices.reduce((count, item) => count + item.samples.length, 0)).toBe(1510);
    expect(fixture.devices.reduce((count, item) => count + item.failures.length, 0)).toBe(8);
    expect(fixture.devices.map(item => item.events.length)).toEqual([87, 1, 11]);
    const metricKeys = [
      ['wifi.rssi', 'rssiDbm', 'dBm', 'gauge'],
      ['memory.free_heap', 'freeHeapBytes', 'bytes', 'gauge'],
      ['memory.fragmentation', 'heapFragmentationPct', '%', 'gauge'],
      ['memory.largest_free_block', 'largestFreeBlockBytes', 'bytes', 'gauge'],
      ['uptime', 'uptimeMs', 'ms', 'counter'],
      ['wifi.disconnect_count', 'disconnectCount', 'count', 'counter'],
      ['wifi.reconnect_count', 'reconnectCount', 'count', 'counter'],
      ['sensor.sample_count', 'sensorSampleCount', 'count', 'counter'],
      ['sensor.read_failure_count', 'sensorReadFailureCount', 'count', 'counter'],
    ] as const;
    const syntheticBase = Date.UTC(2026, 0, 1);
    for (const item of fixture.devices) {
      const hourly = new Map<string, DeviceHealthBucketSummary>();
      const directValues = new Map<string, number[]>();
      for (const row of item.samples) {
        const observedAt = new Date(syntheticBase + Number(row.offsetMs)).toISOString();
        const observation: DeviceHealthObservation = {
          tenantId: 'fixture-tenant', siteId: 'fixture-site', deviceId: `device:${item.alias}`,
          physicalDeviceId: 'esp8266:aaaaaa', sampleId: `${item.alias}:${row.offsetMs}`,
          observedAt, bootSessionId: String(row.bootSession),
          metrics: metricKeys.map(([name, field, unit, semantics]) => ({ name,
            value: typeof row[field] === 'number' ? Number(row[field]) : null,
            unit, semantics, source: 'http:GET:/api/v1/diagnostics' })),
        };
        for (const [name, field, , semantics] of metricKeys) {
          if (semantics === 'gauge' && typeof row[field] === 'number') {
            const values = directValues.get(name) || [];
            values.push(Number(row[field]));
            directValues.set(name, values);
          }
        }
        const bucketStart = new Date(Date.parse(observedAt) - Date.parse(observedAt) % 3_600_000).toISOString();
        hourly.set(bucketStart, applyDeviceHealthObservation(hourly.get(bucketStart) || null,
          observation, 'hourly', fixture.expectedIntervalMs));
      }
      const days = new Set([...hourly.values()].map(bucket => bucket.bucketStartAt.slice(0, 10)));
      const daily = [...days].map(day => summarizeDailyFromHourly([...hourly.values()], `${day}T00:00:00.000Z`, fixture.expectedIntervalMs))
        .filter((bucket): bucket is DeviceHealthBucketSummary => !!bucket);
      const hourlyCount = [...hourly.values()].reduce((sum, bucket) => sum + bucket.sampleCount, 0);
      expect(hourlyCount).toBe(item.samples.length);
      expect(daily.reduce((sum, bucket) => sum + bucket.sampleCount, 0)).toBe(item.samples.length);
      for (const [name, values] of directValues) {
        const dailyMetric = daily.flatMap(bucket => bucket.metrics[name] ? [bucket.metrics[name]] : []);
        expect(dailyMetric.reduce((sum, metric) => sum + metric.sum, 0)).toBe(values.reduce((sum, value) => sum + value, 0));
        expect(Math.min(...dailyMetric.map(metric => metric.minimum))).toBe(Math.min(...values));
        expect(Math.max(...dailyMetric.map(metric => metric.maximum))).toBe(Math.max(...values));
      }
    }
  });
});
