import { queryDeviceHealthEvidence, type DeviceHealthQueryDataset } from './device-health-query';
import { applyDeviceHealthObservation, type DeviceHealthObservation } from './device-health-history';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
const observed = (at: string, value: number | null, boot = 'boot-a', deviceId = 'device-a'): DeviceHealthObservation => ({
  tenantId: scope.tenantId, siteId: scope.siteId, deviceId, physicalDeviceId: 'esp8266:324864',
  sampleId: `${at}:${deviceId}`, observedAt: at, bootSessionId: boot,
  resetEvidence: { reason: 'External System', code: 6, details: null, source: 'http:GET:/api/v1/diagnostics' },
  metrics: [{ name: 'wifi.rssi', value, unit: 'dBm', semantics: 'gauge', source: 'http:GET:/api/v1/diagnostics' }],
});
const dataset: DeviceHealthQueryDataset = {
  observations: [observed('2026-10-25T20:00:00.000Z', -70), observed('2026-10-25T20:01:00.000Z', null),
    observed('2026-10-25T20:03:00.000Z', -50, 'boot-b')],
  buckets: [], events: [{ tenantId: scope.tenantId, siteId: scope.siteId, id: 'boot-event', deviceId: 'device-a', physicalDeviceId: 'esp8266:324864',
    observedAt: '2026-10-25T20:02:30.000Z', kind: 'reboot-detected', bootSessionId: 'boot-b', confidence: 'confirmed',
    source: 'http:GET:/api/v1/diagnostics', summary: 'boot change', explanation: 'session changed',
    observedAtBasis: 'server-detection-time', detectedAt: '2026-10-25T20:02:30.000Z',
    inferredBootAt: { at: '2026-10-25T19:59:00.000Z', basis: 'collected-at-minus-reported-uptime' },
    evidenceReferences: [{ type: 'firmware-diagnostic-snapshot', observedAt: '2026-10-25T20:02:30.000Z', bootSessionId: 'boot-b' }] },
  { tenantId: scope.tenantId, siteId: scope.siteId, id: 'reset-event', deviceId: 'device-a', physicalDeviceId: 'esp8266:324864',
    observedAt: '2026-10-25T20:03:00.000Z', kind: 'exception-reset', bootSessionId: 'boot-b', confidence: 'confirmed',
    source: 'http:GET:/api/v1/diagnostics', summary: 'reset', explanation: 'reported exception',
    observedAtBasis: 'server-detection-time', detectedAt: '2026-10-25T20:03:00.000Z', inferredBootAt: null,
    evidenceReferences: [{ type: 'firmware-diagnostic-snapshot', observedAt: '2026-10-25T20:03:00.000Z', bootSessionId: 'boot-b' }] }],
  failures: [{ tenantId: scope.tenantId, siteId: scope.siteId, id: 'failure-1', deviceId: 'device-a', physicalDeviceId: 'esp8266:324864',
    attemptedAt: '2026-10-25T20:02:00.000Z', reason: 'request_timeout', source: 'http:GET:/api/v1/diagnostics' }],
  expectedIntervalMs: 60_000, supportedMetrics: [{ name: 'wifi.rssi', unit: 'dBm' }, { name: 'memory.free_heap', unit: 'bytes' }],
};
const request = { from: '2026-10-25T20:00:00.000Z', to: '2026-10-25T20:04:00.000Z', granularity: 'raw' as const };

describe('Core device health query', () => {
  it('calculates observed extrema, average, first/latest and real coverage without converting gaps to zero', () => {
    const result = queryDeviceHealthEvidence(scope, request, dataset);
    const device = result.devices[0];
    expect(device.metrics).toEqual(expect.arrayContaining([
      { name: 'wifi.rssi', status: 'available', statistics: expect.objectContaining({
        minimum: -70, maximum: -50, average: -60, count: 2, missingCount: 1, unit: 'dBm',
        first: { value: -70, at: '2026-10-25T20:00:00.000Z' }, latest: { value: -50, at: '2026-10-25T20:03:00.000Z' },
      }) },
      { name: 'memory.free_heap', status: 'unavailable', reason: 'no_samples_in_range' },
    ]));
    expect(device.observedSampleCount).toBe(3);
    expect(device.missingSampleCount).toBe(1);
  });

  it('correlates failures with a later observed recovery and exposes boot transitions with provenance', () => {
    const result = queryDeviceHealthEvidence(scope, request, dataset);
    expect(result.devices[0].failures[0]).toMatchObject({ recoveryObservedAt: '2026-10-25T20:03:00.000Z', recoveryObservedAfterMs: 60_000 });
    expect(result.devices[0].bootSessionTransitions).toEqual([
      { from: 'boot-a', to: 'boot-b', observedAt: '2026-10-25T20:03:00.000Z',
        observedAtBasis: 'sample-collected', eventId: 'boot-event', evidenceReferences: dataset.events[0].evidenceReferences },
    ]);
    expect(result.devices[0].events[0]).toMatchObject({
      observedAtBasis: 'server-detection-time', detectedAt: '2026-10-25T20:02:30.000Z',
      inferredBootAt: { at: '2026-10-25T19:59:00.000Z', basis: 'collected-at-minus-reported-uptime' },
      evidenceReferences: [{ type: 'firmware-diagnostic-snapshot', observedAt: '2026-10-25T20:02:30.000Z', bootSessionId: 'boot-b' }],
    });
    expect(result.devices[0].resetEvidence[0]).toMatchObject({ code: 6, reason: 'External System', source: 'http:GET:/api/v1/diagnostics' });
  });

  it('keeps counters partitioned by boot session instead of averaging them as gauges', () => {
    const counterObservation = (at: string, value: number, boot: string): DeviceHealthObservation => ({
      ...observed(at, value, boot), metrics: [{ name: 'uptime', value, unit: 'ms', semantics: 'counter', source: 'http:GET:/api/v1/diagnostics' }],
    });
    const result = queryDeviceHealthEvidence(scope, request, { ...dataset,
      observations: [counterObservation('2026-10-25T20:00:00.000Z', 10, 'boot-a'),
        counterObservation('2026-10-25T20:01:00.000Z', 70, 'boot-a'),
        counterObservation('2026-10-25T20:03:00.000Z', 5, 'boot-b')],
      supportedMetrics: [{ name: 'uptime', unit: 'ms', semantics: 'counter' }],
    });
    const uptime = result.devices[0].metrics[0];
    expect(uptime.statistics).toBeUndefined();
    expect(uptime.counterSeries).toEqual([
      expect.objectContaining({ bootSessionId: 'boot-a', firstValue: 10, lastValue: 70, delta: 60, orderingComplete: true }),
      expect.objectContaining({ bootSessionId: 'boot-b', firstValue: 5, lastValue: 5, delta: 0 }),
    ]);
  });

  it('combines older rollups with raw history without double-counting the overlapping bucket', () => {
    const old = observed('2026-10-24T20:00:00.000Z', -80);
    const oldBucket = applyDeviceHealthObservation(null, old, 'hourly', 60_000);
    const overlappingBucket = applyDeviceHealthObservation(null, observed('2026-10-25T20:00:00.000Z', -70), 'hourly', 60_000);
    const result = queryDeviceHealthEvidence(scope, { from: '2026-10-24T20:00:00.000Z',
      to: '2026-10-25T21:00:00.000Z', granularity: 'hourly' }, { ...dataset,
      observations: [observed('2026-10-25T20:00:00.000Z', -70), observed('2026-10-25T20:01:00.000Z', -50)],
      buckets: [oldBucket, overlappingBucket],
    });
    const rssi = result.devices[0].metrics.find(metric => metric.name === 'wifi.rssi')?.statistics;
    expect(rssi).toMatchObject({ minimum: -80, maximum: -50, count: 3 });
    expect(rssi?.average).toBeCloseTo(-200 / 3, 5);
    expect(result.devices[0].observedSampleCount).toBe(3);
    expect(result.devices[0].firstObservedAt).toBe(old.observedAt);
  });

  it('composes site statistics from trusted same-site records and rejects records from other scopes', () => {
    const otherSite = observed('2026-10-25T20:01:30.000Z', -1);
    otherSite.siteId = 'site-device-lab';
    const result = queryDeviceHealthEvidence(scope, request, { ...dataset, observations: [...dataset.observations, otherSite] });
    expect(result.site.deviceCount).toBe(1);
    expect(result.site.observedSampleCount).toBe(3);
    expect(result.devices[0].metrics.find(item => item.name === 'wifi.rssi')?.statistics?.minimum).toBe(-70);
  });

  it('marks unsupported metrics, paginates deterministically and validates time ranges and time zones', () => {
    const first = queryDeviceHealthEvidence(scope, { ...request, metrics: ['cpu.temperature'], limit: 1 }, dataset);
    expect(first.devices[0].metrics).toEqual([{ name: 'cpu.temperature', status: 'unsupported', reason: 'metric_not_supported' }]);
    expect(first.page.hasMore).toBe(true);
    const second = queryDeviceHealthEvidence(scope, { ...request, limit: 1, cursor: first.page.nextCursor! }, dataset);
    expect(second.series).toHaveLength(1);
    expect(second.series[0]).not.toEqual(first.series[0]);
    expect(() => queryDeviceHealthEvidence(scope, { ...request, to: '2029-10-25T20:04:00.000Z' }, dataset)).toThrow('Invalid device health query');
    expect(() => queryDeviceHealthEvidence(scope, { ...request, timezone: 'Invalid/Zone' }, dataset)).toThrow('Invalid device health query');
  });

  it('reproduces the sanitized three-device first-night evidence report from Core domain queries', () => {
    const fixturePath = join(__dirname, '../../../../apps/api/src/app/modules/devices/fixtures/device-health-overnight-redacted.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      expectedIntervalMs: number;
      devices: Array<{ alias: string; samples: Array<Record<string, unknown>>;
        events: Array<Record<string, unknown>>; failures: Array<Record<string, unknown>> }>;
    };
    const baseAt = Date.UTC(2026, 0, 1);
    const metricFields = [
      ['wifi.rssi', 'rssiDbm', 'dBm', 'gauge'], ['memory.free_heap', 'freeHeapBytes', 'bytes', 'gauge'],
      ['memory.fragmentation', 'heapFragmentationPct', '%', 'gauge'], ['memory.largest_free_block', 'largestFreeBlockBytes', 'bytes', 'gauge'],
      ['uptime', 'uptimeMs', 'ms', 'counter'], ['wifi.disconnect_count', 'disconnectCount', 'count', 'counter'],
      ['wifi.reconnect_count', 'reconnectCount', 'count', 'counter'], ['sensor.sample_count', 'sensorSampleCount', 'count', 'counter'],
      ['sensor.read_failure_count', 'sensorReadFailureCount', 'count', 'counter'],
    ] as const;
    const observations: DeviceHealthObservation[] = [];
    const events: DeviceHealthQueryDataset['events'] = [];
    const failures: DeviceHealthQueryDataset['failures'] = [];
    for (const device of fixture.devices) {
      for (const row of device.samples) {
        const observedAt = new Date(baseAt + Number(row.offsetMs)).toISOString();
        observations.push({ tenantId: scope.tenantId, siteId: scope.siteId, deviceId: device.alias,
          physicalDeviceId: `esp8266:${device.alias.slice(-6)}`, sampleId: `${device.alias}:${row.offsetMs}`,
          observedAt, bootSessionId: String(row.bootSession),
          resetEvidence: { reason: `code-${row.resetReasonCode}`, code: Number(row.resetReasonCode), details: null, source: 'http:GET:/api/v1/diagnostics' },
          metrics: metricFields.map(([name, field, unit, semantics]) => ({ name,
            value: typeof row[field] === 'number' ? Number(row[field]) : null, unit, semantics,
            source: 'http:GET:/api/v1/diagnostics' })) });
      }
      for (const row of device.events) events.push({ tenantId: scope.tenantId, siteId: scope.siteId,
        id: `${device.alias}:${row.deduplicationKey}`, deviceId: device.alias,
        physicalDeviceId: `esp8266:${device.alias.slice(-6)}`, observedAt: new Date(baseAt + Number(row.offsetMs)).toISOString(),
        kind: String(row.kind), bootSessionId: String(row.bootSession),
        confidence: row.confidence === 'possible' ? 'possible' : 'confirmed', source: String(row.source), summary: String(row.kind), explanation: '',
        observedAtBasis: 'server-detection-time', detectedAt: new Date(baseAt + Number(row.offsetMs)).toISOString(),
        inferredBootAt: null,
        evidenceReferences: [{ type: 'firmware-diagnostic-snapshot', observedAt: new Date(baseAt + Number(row.offsetMs)).toISOString(),
          bootSessionId: String(row.bootSession) }] });
      for (const row of device.failures) failures.push({ tenantId: scope.tenantId, siteId: scope.siteId,
        id: `${device.alias}:${row.offsetMs}`, deviceId: device.alias,
        physicalDeviceId: `esp8266:${device.alias.slice(-6)}`, attemptedAt: new Date(baseAt + Number(row.offsetMs)).toISOString(),
        reason: String(row.reason), source: 'http:GET:/api/v1/diagnostics' });
    }
    const from = new Date(baseAt - 36 * 60 * 60_000).toISOString();
    const to = new Date(baseAt + 8 * 60 * 60_000 + 40 * 60_000).toISOString();
    const report = queryDeviceHealthEvidence(scope, { from, to, timezone: 'Europe/Sofia', granularity: 'raw', limit: 1000 }, {
      observations, buckets: [], events, failures, expectedIntervalMs: fixture.expectedIntervalMs,
      supportedMetrics: metricFields.map(([name, , unit, semantics]) => ({ name, unit, semantics })),
    });
    expect(report.site).toMatchObject({ deviceCount: 3, observedSampleCount: 1510, failureCount: 8 });
    expect(report.devices.map(device => device.observedSampleCount).sort((a, b) => a - b)).toEqual([500, 504, 506]);
    expect(report.devices.reduce((count, device) => count + device.resetEvidence.length, 0)).toBe(1510);
    expect(report.devices.reduce((count, device) => count + device.events.length, 0)).toBe(99);
    for (const fixtureDevice of fixture.devices) {
      const analysis = report.devices.find(device => device.deviceId === fixtureDevice.alias)!;
      for (const [metricName, field] of [['wifi.rssi', 'rssiDbm'], ['memory.free_heap', 'freeHeapBytes']] as const) {
        const values = fixtureDevice.samples.map(row => Number(row[field]));
        const statistics = analysis.metrics.find(metric => metric.name === metricName)?.statistics;
        expect(statistics).toMatchObject({ minimum: Math.min(...values), maximum: Math.max(...values), count: values.length });
        expect(statistics?.average).toBeCloseTo(values.reduce((sum, value) => sum + value, 0) / values.length, 5);
      }
    }
    expect(report.timezone).toBe('Europe/Sofia');
  });
});
