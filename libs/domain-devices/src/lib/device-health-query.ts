import type { DeviceHealthBucketSummary, DeviceHealthCounterSummary, DeviceHealthObservation } from './device-health-history';

export type DeviceHealthQueryGranularity = 'raw' | 'hourly' | 'daily' | 'events' | 'failures';

/** Scope is supplied by the authenticated server context, never by request data. */
export interface DeviceHealthQueryScope { tenantId: string; siteId: string }
export interface DeviceHealthQueryRequest {
  from: string;
  to: string;
  granularity: DeviceHealthQueryGranularity;
  timezone?: string;
  deviceId?: string;
  metrics?: string[];
  limit?: number;
  cursor?: string;
}

export interface DeviceHealthEventEvidence {
  tenantId: string; siteId: string;
  id: string; deviceId: string; physicalDeviceId: string; observedAt: string;
  kind: string; bootSessionId: string; confidence: 'confirmed' | 'possible';
  source: string | null; summary: string; explanation: string;
  /** Null means the legacy record did not preserve timestamp provenance. */
  observedAtBasis: 'server-detection-time' | null;
  detectedAt: string | null;
  /** Estimate from a diagnostic sample, not an observed physical reboot time. */
  inferredBootAt: { at: string; basis: 'collected-at-minus-reported-uptime' } | null;
  evidenceReferences: Array<{ type: 'firmware-diagnostic-snapshot'; observedAt: string; bootSessionId: string }>;
}
export interface DeviceHealthFailureEvidence {
  tenantId: string; siteId: string;
  id: string; deviceId: string; physicalDeviceId: string; attemptedAt: string;
  reason: string; source: string; requestDurationMs?: number | null;
}

export interface DeviceHealthMetricStatistics {
  minimum: number; maximum: number; average: number; sum: number;
  count: number; missingCount: number; unit: string; source: string;
  first: { value: number; at: string };
  latest: { value: number; at: string };
}
export interface DeviceHealthReportedResetEvidence {
  observedAt: string; reason: string; code: number; details: Record<string, number> | null; source: string;
}
export interface DeviceHealthMetricAvailability {
  name: string; status: 'available' | 'unavailable' | 'unsupported'; reason?: 'no_samples_in_range' | 'metric_not_supported';
  semantics?: 'gauge' | 'counter';
  statistics?: DeviceHealthMetricStatistics;
  counterSeries?: DeviceHealthCounterSummary[];
}
export interface DeviceHealthDeviceAnalysis {
  deviceId: string; physicalDeviceId: string | null;
  firstObservedAt: string | null; latestObservedAt: string | null;
  observedSampleCount: number; expectedSampleCount: number; missingSampleCount: number;
  coverageRatio: number | null;
  coverageBasis: 'observed-sample-span' | 'requested-window-no-samples';
  metrics: DeviceHealthMetricAvailability[];
  failureCount: number; failures: Array<DeviceHealthFailureEvidence & {
    recoveryObservedAt: string | null; recoveryObservedAfterMs: number | null;
  }>;
  bootSessionTransitions: Array<{ from: string; to: string; observedAt: string;
    observedAtBasis: 'sample-collected' | 'summary-first-observation' | 'server-detection-time';
    eventId: string | null; evidenceReferences: DeviceHealthEventEvidence['evidenceReferences'] }>;
  resetEvidence: DeviceHealthReportedResetEvidence[];
  resetEvents: DeviceHealthEventEvidence[];
  events: DeviceHealthEventEvidence[];
}
export interface DeviceHealthQueryResult {
  schemaVersion: 1; tenantId: string; siteId: string;
  from: string; to: string; timezone: string;
  granularity: DeviceHealthQueryGranularity;
  devices: DeviceHealthDeviceAnalysis[];
  site: { deviceCount: number; observedSampleCount: number; failureCount: number;
    metricAverages: Array<{ name: string; average: number; count: number; unit: string; sources: string[] }> };
  series: Array<DeviceHealthObservation | DeviceHealthBucketSummary | DeviceHealthEventEvidence | DeviceHealthFailureEvidence>;
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
}
export interface DeviceHealthQueryDataset {
  observations: DeviceHealthObservation[];
  buckets: DeviceHealthBucketSummary[];
  events: DeviceHealthEventEvidence[];
  failures: DeviceHealthFailureEvidence[];
  expectedIntervalMs: number;
  /** Stable metric vocabulary allows callers to distinguish unsupported from empty. */
  supportedMetrics: Array<{ name: string; unit: string; semantics: 'gauge' | 'counter' }>;
  authorizedDevices?: Array<{ tenantId: string; siteId: string; deviceId: string; physicalDeviceId: string | null }>;
}

/** Core application service façade over the deterministic read-only query. */
export class DeviceHealthQueryService {
  query(scope: DeviceHealthQueryScope, request: DeviceHealthQueryRequest, dataset: DeviceHealthQueryDataset): DeviceHealthQueryResult {
    return queryDeviceHealthEvidence(scope, request, dataset);
  }
}

const defaultLimit = 500;
const maxLimit = 1000;
const maxRangeMs = 730 * 86_400_000;
const maxEvidenceRows = 20_000;
const maxSiteDevices = 100;
const defaultTimezone = 'UTC';

function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); return true; } catch { return false; }
}
function validOffsetDate(value: string): boolean {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}
function inRange(at: string, from: number, to: number): boolean {
  const time = Date.parse(at); return Number.isFinite(time) && time >= from && time <= to;
}
function scopeMatches(scope: DeviceHealthQueryScope, record: { tenantId: string; siteId: string }): boolean {
  return record.tenantId === scope.tenantId && record.siteId === scope.siteId;
}
function round(value: number): number { return Number(value.toFixed(6)); }

function metricStats(observations: DeviceHealthObservation[], name: string,
  unit: string, source: string): DeviceHealthMetricStatistics | null {
  const all = observations.flatMap(item => item.metrics.filter(metric => metric.name === name));
  const valid = observations.flatMap(item => item.metrics
    .filter(metric => metric.name === name && metric.value !== null && Number.isFinite(metric.value))
    .map(metric => ({ value: metric.value as number, at: item.observedAt, unit: metric.unit, source: metric.source })));
  if (!valid.length) return null;
  if (valid.some(item => item.unit !== unit || item.source !== source)) {
    throw new Error(`Device health query metric ${name} has inconsistent unit or provenance`);
  }
  valid.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const sum = valid.reduce((total, item) => total + item.value, 0);
  return { minimum: Math.min(...valid.map(item => item.value)), maximum: Math.max(...valid.map(item => item.value)),
    average: round(sum / valid.length), sum, count: valid.length,
    missingCount: Math.max(0, observations.length - valid.length), unit, source,
    first: { value: valid[0].value, at: valid[0].at }, latest: { value: valid.at(-1)!.value, at: valid.at(-1)!.at } };
}

function bucketMetricStats(buckets: DeviceHealthBucketSummary[], name: string): DeviceHealthMetricStatistics | null {
  const values = buckets.flatMap(bucket => {
    const item = bucket.metrics[name]; return item ? [{ bucket, item }] : [];
  });
  if (!values.length) return null;
  const { unit, source } = values[0].item;
  if (values.some(({ item }) => item.unit !== unit || item.source !== source)) {
    throw new Error(`Device health query metric ${name} has inconsistent unit or provenance`);
  }
  const count = values.reduce((total, { item }) => total + item.sampleCount, 0);
  const sum = values.reduce((total, { item }) => total + item.sum, 0);
  const first = values.reduce((oldest, current) => Date.parse(current.item.firstObservedAt) < Date.parse(oldest.item.firstObservedAt) ? current : oldest);
  const latest = values.reduce((newest, current) => Date.parse(current.item.lastObservedAt) > Date.parse(newest.item.lastObservedAt) ? current : newest);
  return { minimum: Math.min(...values.map(({ item }) => item.minimum)), maximum: Math.max(...values.map(({ item }) => item.maximum)),
    average: round(sum / count), sum, count,
    missingCount: values.reduce((total, { item }) => total + item.missingSampleCount, 0), unit, source,
    first: { value: first.item.firstValue, at: first.item.firstObservedAt },
    latest: { value: latest.item.lastValue, at: latest.item.lastObservedAt } };
}

/** Pure Core query/statistics logic. It performs no storage, authorization, or network I/O. */
export function queryDeviceHealthEvidence(scope: DeviceHealthQueryScope,
  request: DeviceHealthQueryRequest, dataset: DeviceHealthQueryDataset): DeviceHealthQueryResult {
  const fromMs = Date.parse(request.from), toMs = Date.parse(request.to);
  const timezone = request.timezone || defaultTimezone;
  if (!scope.tenantId.trim() || !scope.siteId.trim() || !validOffsetDate(request.from) || !validOffsetDate(request.to) ||
      fromMs > toMs || toMs - fromMs > maxRangeMs || !validTimezone(timezone) ||
      !['raw', 'hourly', 'daily', 'events', 'failures'].includes(request.granularity) ||
      (request.granularity === 'hourly' && (fromMs % 3_600_000 !== 0 || toMs % 3_600_000 !== 0)) ||
      (request.granularity === 'daily' && (fromMs % 86_400_000 !== 0 || toMs % 86_400_000 !== 0)) ||
      !Number.isSafeInteger(dataset.expectedIntervalMs) || dataset.expectedIntervalMs <= 0 ||
      (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > maxLimit)) ||
      (request.deviceId !== undefined && (request.deviceId.length < 1 || request.deviceId.length > 240)) ||
      (request.metrics !== undefined && (request.metrics.length > 25 || request.metrics.some(name => !/^[a-z][a-z0-9_.-]{0,79}$/.test(name))))) {
    throw new Error('Invalid device health query range, scope or options');
  }
  const limit = Math.max(1, Math.min(maxLimit, Math.floor(request.limit ?? defaultLimit)));
  const observations = dataset.observations.filter(item => scopeMatches(scope, item) &&
    (!request.deviceId || item.deviceId === request.deviceId) && inRange(item.observedAt, fromMs, toMs));
  const buckets = dataset.buckets.filter(item => scopeMatches(scope, item) &&
    (!request.deviceId || item.deviceId === request.deviceId) && inRange(item.bucketStartAt, fromMs, toMs));
  const events = dataset.events.filter(item => scopeMatches(scope, item) && (!request.deviceId || item.deviceId === request.deviceId))
    .filter(item => inRange(item.observedAt, fromMs, toMs));
  const failures = dataset.failures.filter(item => scopeMatches(scope, item) && (!request.deviceId || item.deviceId === request.deviceId))
    .filter(item => inRange(item.attemptedAt, fromMs, toMs));
  const deviceIds = new Set([...observations.map(item => item.deviceId), ...buckets.map(item => item.deviceId),
    ...events.map(item => item.deviceId), ...failures.map(item => item.deviceId),
    ...(dataset.authorizedDevices || []).filter(item => scopeMatches(scope, item)).map(item => item.deviceId)]);
  if (deviceIds.size > maxSiteDevices || observations.length + buckets.length + events.length + failures.length > maxEvidenceRows) {
    throw new Error('Device health query exceeds bounded result size');
  }
  const devices = [...deviceIds].sort().map(deviceId => {
    const deviceObservations = observations.filter(item => item.deviceId === deviceId).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    const deviceBuckets = buckets.filter(item => item.deviceId === deviceId).sort((a, b) => Date.parse(a.bucketStartAt) - Date.parse(b.bucketStartAt));
    const rawStart = deviceObservations.length ? Date.parse(deviceObservations[0].observedAt) : Number.NaN;
    const rawEnd = deviceObservations.length ? Date.parse(deviceObservations.at(-1)!.observedAt) : Number.NaN;
    // Use rollups outside the exact raw interval, avoiding duplicate samples.
    const nonOverlappingBuckets = deviceObservations.length ? deviceBuckets.filter(bucket =>
      Date.parse(bucket.lastObservedAt) < rawStart || Date.parse(bucket.firstObservedAt) > rawEnd) : deviceBuckets;
    const deviceEvents = events.filter(item => item.deviceId === deviceId);
    const deviceFailures = failures.filter(item => item.deviceId === deviceId).sort((a, b) => Date.parse(a.attemptedAt) - Date.parse(b.attemptedAt));
    const physicalDeviceId = deviceObservations[0]?.physicalDeviceId || deviceBuckets[0]?.physicalDeviceId ||
      deviceEvents[0]?.physicalDeviceId || deviceFailures[0]?.physicalDeviceId ||
      dataset.authorizedDevices?.find(item => item.deviceId === deviceId && scopeMatches(scope, item))?.physicalDeviceId || null;
    const allFirstTimes = [...deviceObservations.slice(0, 1).map(item => item.observedAt), ...nonOverlappingBuckets.map(item => item.firstObservedAt)];
    const allLastTimes = [...deviceObservations.slice(-1).map(item => item.observedAt), ...nonOverlappingBuckets.map(item => item.lastObservedAt)];
    const firstObservedAt = allFirstTimes.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
    const latestObservedAt = allLastTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    const observedSampleCount = deviceObservations.length + nonOverlappingBuckets.reduce((n, item) => n + item.sampleCount, 0);
    const expectedSampleCount = firstObservedAt && latestObservedAt
      ? Math.max(1, Math.floor((Date.parse(latestObservedAt) - Date.parse(firstObservedAt)) / dataset.expectedIntervalMs) + 1)
      : Math.max(1, Math.floor((toMs - fromMs) / dataset.expectedIntervalMs) + 1);
    const missingSampleCount = Math.max(0, expectedSampleCount - observedSampleCount);
    const requestedMetrics = request.metrics?.length ? request.metrics : dataset.supportedMetrics.map(metric => metric.name);
    const metricAvailability = requestedMetrics.map(name => {
      const metric = dataset.supportedMetrics.find(item => item.name === name);
      if (!metric) return { name, status: 'unsupported' as const, reason: 'metric_not_supported' as const };
      if (metric.semantics === 'counter') {
        const rawCounters = deviceObservations.length
          ? rawCounterSeries(deviceObservations, metric.name, metric.unit, dataset.expectedIntervalMs) : [];
        const counterSeries = mergeCounterSeries(rawCounters,
          bucketCounterSeries(nonOverlappingBuckets, metric.name, dataset.expectedIntervalMs), dataset.expectedIntervalMs);
        return counterSeries.length ? { name: metric.name, status: 'available' as const, semantics: metric.semantics, counterSeries }
          : { name: metric.name, status: 'unavailable' as const, reason: 'no_samples_in_range' as const, semantics: metric.semantics };
      }
      const rawStatistics = deviceObservations.length
        ? metricStats(deviceObservations, metric.name, deviceObservations.flatMap(o => o.metrics).find(m => m.name === metric.name)?.unit || metric.unit,
          deviceObservations.flatMap(o => o.metrics).find(m => m.name === metric.name)?.source || '') : null;
      const statistics = combineMetricStats(rawStatistics, bucketMetricStats(nonOverlappingBuckets, metric.name));
      return statistics ? { name: metric.name, status: 'available' as const, semantics: metric.semantics, statistics }
        : { name: metric.name, status: 'unavailable' as const, reason: 'no_samples_in_range' as const, semantics: metric.semantics };
    });
    const bootTimes = new Map<string, { at: string; basis: 'sample-collected' | 'summary-first-observation' | 'server-detection-time';
      eventId: string | null; evidenceReferences: DeviceHealthEventEvidence['evidenceReferences'] }>();
    for (const observation of deviceObservations) {
      const previous = bootTimes.get(observation.bootSessionId);
      if (!previous || Date.parse(observation.observedAt) < Date.parse(previous.at)) bootTimes.set(observation.bootSessionId, {
        at: observation.observedAt, basis: 'sample-collected', eventId: null, evidenceReferences: [],
      });
    }
    for (const bucket of nonOverlappingBuckets) for (const series of Object.values(bucket.counters)) for (const counter of series) {
      const previous = bootTimes.get(counter.bootSessionId);
      if (!previous || Date.parse(counter.firstObservedAt) < Date.parse(previous.at)) bootTimes.set(counter.bootSessionId, {
        at: counter.firstObservedAt, basis: 'summary-first-observation', eventId: null, evidenceReferences: [],
      });
    }
    // Events can establish when a transition was detected, but inferred boot-time estimates
    // are never used to order observed boot sessions. Legacy events without basis are excluded.
    for (const item of deviceEvents.filter(event => event.kind === 'reboot-detected' &&
      event.observedAtBasis === 'server-detection-time' && event.detectedAt)) {
      if (!bootTimes.has(item.bootSessionId)) bootTimes.set(item.bootSessionId, {
        at: item.detectedAt!, basis: 'server-detection-time', eventId: item.id, evidenceReferences: item.evidenceReferences,
      });
    }
    const orderedBoots = [...bootTimes.entries()].sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
    const bootSessionTransitions = orderedBoots.slice(1).map((boot, index) => {
      const priorBoot = orderedBoots[index][0];
      const matchedEvent = deviceEvents.find(item => item.kind === 'reboot-detected' && item.bootSessionId === boot[0]);
      return { from: priorBoot, to: boot[0], observedAt: boot[1].at, observedAtBasis: boot[1].basis,
        eventId: boot[1].eventId || matchedEvent?.id || null,
        evidenceReferences: boot[1].evidenceReferences.length ? boot[1].evidenceReferences : matchedEvent?.evidenceReferences || [] };
    });
    const recoveredFailures = deviceFailures.map(failure => {
      const recoveryAt = [...deviceObservations.map(item => item.observedAt), ...deviceBuckets.map(item => item.firstObservedAt)]
        .filter(at => Date.parse(at) >= Date.parse(failure.attemptedAt)).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
      return { ...failure, requestDurationMs: failure.requestDurationMs ?? null, recoveryObservedAt: recoveryAt,
        recoveryObservedAfterMs: recoveryAt ? Date.parse(recoveryAt) - Date.parse(failure.attemptedAt) : null };
    });
    return { deviceId, physicalDeviceId, firstObservedAt, latestObservedAt, observedSampleCount,
      expectedSampleCount, missingSampleCount,
      coverageRatio: expectedSampleCount ? Math.min(1, observedSampleCount / expectedSampleCount) : null,
      coverageBasis: observedSampleCount > 0 ? 'observed-sample-span' as const : 'requested-window-no-samples' as const,
      metrics: metricAvailability, failureCount: deviceFailures.length, failures: recoveredFailures,
      bootSessionTransitions,
      resetEvidence: deviceObservations.flatMap(item => item.resetEvidence
        ? [{ observedAt: item.observedAt, ...item.resetEvidence }] : []),
      resetEvents: deviceEvents.filter(item => item.kind === 'watchdog-reset' || item.kind === 'exception-reset' || item.kind === 'reset-cause-unknown'),
      events: deviceEvents };
  });
  const selectedSeries = request.granularity === 'raw' ? observations
    : request.granularity === 'hourly' || request.granularity === 'daily' ? buckets.filter(item => item.granularity === request.granularity)
      : request.granularity === 'events' ? events : failures;
  const sortedSeries = [...selectedSeries].sort((a, b) => seriesCursor(a).localeCompare(seriesCursor(b)));
  if (request.cursor && (!/^\d{4}-\d\d-\d\dT[^|]+\|[^|]{1,240}\|[^|]{1,240}$/.test(request.cursor) ||
      !Number.isFinite(Date.parse(request.cursor.split('|', 1)[0])))) throw new Error('Invalid device health query cursor');
  const afterCursor = sortedSeries.filter(item => !request.cursor || seriesCursor(item) > request.cursor);
  const page = afterCursor.slice(0, limit);
  const metricAverages = dataset.supportedMetrics.flatMap(metric => {
    if (metric.semantics === 'counter') return [];
    const stats = devices.flatMap(device => device.metrics).find(item => item.name === metric.name && item.status === 'available')?.statistics;
    if (!stats) return [];
    const all = devices.flatMap(device => device.metrics).filter(item => item.name === metric.name && item.status === 'available')
      .map(item => item.statistics!);
    const count = all.reduce((n, item) => n + item.count, 0);
    return [{ name: metric.name, average: round(all.reduce((n, item) => n + item.sum, 0) / count), count,
      unit: stats.unit, sources: [...new Set(all.map(item => item.source))].sort() }];
  });
  return { schemaVersion: 1, tenantId: scope.tenantId, siteId: scope.siteId,
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), timezone,
    granularity: request.granularity, devices,
    site: { deviceCount: devices.length, observedSampleCount: devices.reduce((n, item) => n + item.observedSampleCount, 0),
      failureCount: devices.reduce((n, item) => n + item.failureCount, 0), metricAverages },
    series: page, page: { limit, nextCursor: afterCursor.length > limit ? seriesCursor(page.at(-1)!) : null, hasMore: afterCursor.length > limit } };
}

function rawCounterSeries(observations: DeviceHealthObservation[], name: string, unit: string,
  expectedIntervalMs: number): DeviceHealthCounterSummary[] {
  const byBoot = new Map<string, Array<{ value: number; at: string; source: string }>>();
  for (const observation of observations) for (const metric of observation.metrics) {
    if (metric.name !== name || metric.value === null || !Number.isFinite(metric.value)) continue;
    const rows = byBoot.get(observation.bootSessionId) || [];
    rows.push({ value: metric.value, at: observation.observedAt, source: metric.source }); byBoot.set(observation.bootSessionId, rows);
  }
  return [...byBoot.entries()].map(([bootSessionId, rows]) => {
    rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (rows.some(row => row.source !== rows[0].source)) throw new Error(`Device health counter ${name} has inconsistent provenance`);
    const resetObserved = rows.some((row, index) => index > 0 && row.value < rows[index - 1].value);
    const orderingComplete = rows.every((row, index) => index === 0 || Date.parse(row.at) - Date.parse(rows[index - 1].at) <= expectedIntervalMs * 1.5);
    return { bootSessionId, firstValue: rows[0].value, firstObservedAt: rows[0].at,
      lastValue: rows.at(-1)!.value, lastObservedAt: rows.at(-1)!.at,
      delta: resetObserved || !orderingComplete ? null : rows.at(-1)!.value - rows[0].value,
      resetObserved, orderingComplete, unit, source: rows[0].source };
  }).sort((a, b) => Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt));
}

function combineMetricStats(raw: DeviceHealthMetricStatistics | null,
  aggregate: DeviceHealthMetricStatistics | null): DeviceHealthMetricStatistics | null {
  if (!raw) return aggregate;
  if (!aggregate) return raw;
  if (raw.unit !== aggregate.unit || raw.source !== aggregate.source) {
    throw new Error('Device health query metric has inconsistent unit or provenance across raw and summarized history');
  }
  const first = Date.parse(raw.first.at) <= Date.parse(aggregate.first.at) ? raw.first : aggregate.first;
  const latest = Date.parse(raw.latest.at) >= Date.parse(aggregate.latest.at) ? raw.latest : aggregate.latest;
  return { minimum: Math.min(raw.minimum, aggregate.minimum), maximum: Math.max(raw.maximum, aggregate.maximum),
    sum: raw.sum + aggregate.sum, count: raw.count + aggregate.count,
    average: round((raw.sum + aggregate.sum) / (raw.count + aggregate.count)),
    missingCount: raw.missingCount + aggregate.missingCount, unit: raw.unit, source: raw.source, first, latest };
}

function mergeCounterSeries(raw: DeviceHealthCounterSummary[], aggregate: DeviceHealthCounterSummary[],
  expectedIntervalMs: number): DeviceHealthCounterSummary[] {
  const byBoot = new Map<string, DeviceHealthCounterSummary[]>();
  for (const item of [...aggregate, ...raw]) {
    const list = byBoot.get(item.bootSessionId) || []; list.push(item); byBoot.set(item.bootSessionId, list);
  }
  return [...byBoot.entries()].map(([bootSessionId, items]) => {
    items.sort((a, b) => Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt));
    const first = items[0], last = items.at(-1)!;
    if (items.some(item => item.unit !== first.unit || item.source !== first.source)) {
      throw new Error('Device health counter has inconsistent unit or provenance across raw and summarized history');
    }
    const resetObserved = items.some(item => item.resetObserved) || items.some((item, index) => index > 0 &&
      item.firstValue < items[index - 1].lastValue);
    const orderingComplete = items.every((item, index) => item.orderingComplete && (index === 0 ||
      Date.parse(item.firstObservedAt) - Date.parse(items[index - 1].lastObservedAt) <= expectedIntervalMs * 1.5));
    return { ...first, bootSessionId, firstValue: first.firstValue, firstObservedAt: first.firstObservedAt,
      lastValue: last.lastValue, lastObservedAt: last.lastObservedAt,
      delta: resetObserved || !orderingComplete ? null : last.lastValue - first.firstValue,
      resetObserved, orderingComplete };
  }).sort((a, b) => Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt));
}

function bucketCounterSeries(buckets: DeviceHealthBucketSummary[], name: string, expectedIntervalMs: number): DeviceHealthCounterSummary[] {
  const byBoot = new Map<string, DeviceHealthCounterSummary[]>();
  for (const bucket of buckets) for (const counter of bucket.counters[name] || []) {
    const rows = byBoot.get(counter.bootSessionId) || []; rows.push(counter); byBoot.set(counter.bootSessionId, rows);
  }
  return [...byBoot.entries()].map(([bootSessionId, items]) => {
    items.sort((a, b) => Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt));
    const first = items[0], last = items.at(-1)!;
    const resetObserved = items.some(item => item.resetObserved) || items.some((item, index) => index > 0 && item.firstValue < items[index - 1].lastValue);
    const orderingComplete = items.every((item, index) => item.orderingComplete && (index === 0 ||
      Date.parse(item.firstObservedAt) - Date.parse(items[index - 1].lastObservedAt) <= expectedIntervalMs * 1.5));
    return { ...first, bootSessionId, firstValue: first.firstValue, firstObservedAt: first.firstObservedAt,
      lastValue: last.lastValue, lastObservedAt: last.lastObservedAt,
      delta: resetObserved || !orderingComplete ? null : last.lastValue - first.firstValue,
      resetObserved, orderingComplete };
  }).sort((a, b) => Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt));
}

function seriesCursor(record: DeviceHealthObservation | DeviceHealthBucketSummary | DeviceHealthEventEvidence | DeviceHealthFailureEvidence): string {
  const at = 'attemptedAt' in record ? record.attemptedAt : 'bucketStartAt' in record ? record.bucketStartAt : record.observedAt;
  const deviceId = record.deviceId;
  const id = 'sampleId' in record ? record.sampleId : 'id' in record ? record.id : `${record.bucketStartAt}:${record.granularity}`;
  return `${at}|${deviceId}|${id}`;
}
