import type { DeviceHealthBucketSummary, DeviceHealthObservation } from './device-health-history';

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
}
export interface DeviceHealthFailureEvidence {
  tenantId: string; siteId: string;
  id: string; deviceId: string; physicalDeviceId: string; attemptedAt: string;
  reason: string; requestDurationMs?: number | null;
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
  statistics?: DeviceHealthMetricStatistics;
}
export interface DeviceHealthDeviceAnalysis {
  deviceId: string; physicalDeviceId: string;
  firstObservedAt: string | null; latestObservedAt: string | null;
  observedSampleCount: number; expectedSampleCount: number; missingSampleCount: number;
  coverageRatio: number | null;
  coverageBasis: 'requested-window-estimate';
  metrics: DeviceHealthMetricAvailability[];
  failureCount: number; failures: Array<DeviceHealthFailureEvidence & {
    recoveryObservedAt: string | null; recoveryObservedAfterMs: number | null;
  }>;
  bootSessionTransitions: Array<{ from: string; to: string; observedAt: string; eventId: string | null }>;
  resetEvidence: DeviceHealthReportedResetEvidence[];
  resetEvents: DeviceHealthEventEvidence[];
}
export interface DeviceHealthQueryResult {
  schemaVersion: 1; tenantId: string; siteId: string;
  from: string; to: string; timezone: string;
  granularity: DeviceHealthQueryGranularity;
  devices: DeviceHealthDeviceAnalysis[];
  site: { deviceCount: number; observedSampleCount: number; failureCount: number;
    metricAverages: Array<{ name: string; average: number; count: number; unit: string }> };
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
  supportedMetrics: Array<{ name: string; unit: string }>;
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
  if (!scope.tenantId.trim() || !scope.siteId.trim() || !Number.isFinite(fromMs) || !Number.isFinite(toMs) ||
      fromMs > toMs || toMs - fromMs > maxRangeMs || !validTimezone(timezone) ||
      !['raw', 'hourly', 'daily', 'events', 'failures'].includes(request.granularity) ||
      !Number.isSafeInteger(dataset.expectedIntervalMs) || dataset.expectedIntervalMs <= 0) {
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
    ...events.map(item => item.deviceId), ...failures.map(item => item.deviceId)]);
  if (deviceIds.size > maxSiteDevices || observations.length + buckets.length + events.length + failures.length > maxEvidenceRows) {
    throw new Error('Device health query exceeds bounded result size');
  }
  const devices = [...deviceIds].sort().map(deviceId => {
    const deviceObservations = observations.filter(item => item.deviceId === deviceId).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    const deviceBuckets = buckets.filter(item => item.deviceId === deviceId).sort((a, b) => Date.parse(a.bucketStartAt) - Date.parse(b.bucketStartAt));
    const deviceEvents = events.filter(item => item.deviceId === deviceId);
    const deviceFailures = failures.filter(item => item.deviceId === deviceId).sort((a, b) => Date.parse(a.attemptedAt) - Date.parse(b.attemptedAt));
    const physicalDeviceId = deviceObservations[0]?.physicalDeviceId || deviceBuckets[0]?.physicalDeviceId ||
      deviceEvents[0]?.physicalDeviceId || deviceFailures[0]?.physicalDeviceId || '';
    const firstObservedAt = deviceObservations[0]?.observedAt || deviceBuckets[0]?.firstObservedAt || null;
    const latestObservedAt = deviceObservations.at(-1)?.observedAt || deviceBuckets.at(-1)?.lastObservedAt || null;
    const observedSampleCount = deviceObservations.length || deviceBuckets.reduce((n, item) => n + item.sampleCount, 0);
    const expectedSampleCount = Math.max(1, Math.floor((toMs - fromMs) / dataset.expectedIntervalMs) + 1);
    const missingSampleCount = Math.max(0, expectedSampleCount - observedSampleCount);
    const requestedMetrics = request.metrics?.length ? request.metrics : dataset.supportedMetrics.map(metric => metric.name);
    const metricAvailability = requestedMetrics.map(name => {
      const metric = dataset.supportedMetrics.find(item => item.name === name);
      if (!metric) return { name, status: 'unsupported' as const, reason: 'metric_not_supported' as const };
      const statistics = deviceObservations.length
        ? metricStats(deviceObservations, metric.name, metric.unit, deviceObservations.flatMap(o => o.metrics).find(m => m.name === metric.name)?.source || '')
        : bucketMetricStats(deviceBuckets, metric.name);
      return statistics ? { name: metric.name, status: 'available' as const, statistics }
        : { name: metric.name, status: 'unavailable' as const, reason: 'no_samples_in_range' as const };
    });
    const orderedBoots = [...new Map(deviceObservations.map(item => [item.bootSessionId, item.observedAt])).entries()]
      .sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
    const bootSessionTransitions = orderedBoots.slice(1).map((boot, index) => {
      const priorBoot = orderedBoots[index][0];
      const matchedEvent = deviceEvents.find(item => item.kind === 'reboot-detected' && item.bootSessionId === boot[0]);
      return { from: priorBoot, to: boot[0], observedAt: boot[1], eventId: matchedEvent?.id || null };
    });
    const recoveredFailures = deviceFailures.map(failure => {
      const recovery = deviceObservations.find(item => Date.parse(item.observedAt) >= Date.parse(failure.attemptedAt));
      return { ...failure, recoveryObservedAt: recovery?.observedAt || null,
        recoveryObservedAfterMs: recovery ? Date.parse(recovery.observedAt) - Date.parse(failure.attemptedAt) : null };
    });
    return { deviceId, physicalDeviceId, firstObservedAt, latestObservedAt, observedSampleCount,
      expectedSampleCount, missingSampleCount,
      coverageRatio: expectedSampleCount ? Math.min(1, observedSampleCount / expectedSampleCount) : null,
      coverageBasis: 'requested-window-estimate' as const,
      metrics: metricAvailability, failureCount: deviceFailures.length, failures: recoveredFailures,
      bootSessionTransitions,
      resetEvidence: deviceObservations.flatMap(item => item.resetEvidence
        ? [{ observedAt: item.observedAt, ...item.resetEvidence }] : []),
      resetEvents: deviceEvents.filter(item => item.kind === 'watchdog-reset' || item.kind === 'exception-reset' || item.kind === 'reset-cause-unknown') };
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
    const stats = devices.flatMap(device => device.metrics).find(item => item.name === metric.name && item.status === 'available')?.statistics;
    if (!stats) return [];
    const all = devices.flatMap(device => device.metrics).filter(item => item.name === metric.name && item.status === 'available')
      .map(item => item.statistics!);
    const count = all.reduce((n, item) => n + item.count, 0);
    return [{ name: metric.name, average: round(all.reduce((n, item) => n + item.sum, 0) / count), count, unit: stats.unit }];
  });
  return { schemaVersion: 1, tenantId: scope.tenantId, siteId: scope.siteId,
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), timezone,
    granularity: request.granularity, devices,
    site: { deviceCount: devices.length, observedSampleCount: devices.reduce((n, item) => n + item.observedSampleCount, 0),
      failureCount: devices.reduce((n, item) => n + item.failureCount, 0), metricAverages },
    series: page, page: { limit, nextCursor: afterCursor.length > limit ? seriesCursor(page.at(-1)!) : null, hasMore: afterCursor.length > limit } };
}

function seriesCursor(record: DeviceHealthObservation | DeviceHealthBucketSummary | DeviceHealthEventEvidence | DeviceHealthFailureEvidence): string {
  const at = 'attemptedAt' in record ? record.attemptedAt : 'bucketStartAt' in record ? record.bucketStartAt : record.observedAt;
  const deviceId = record.deviceId;
  const id = 'sampleId' in record ? record.sampleId : 'id' in record ? record.id : `${record.bucketStartAt}:${record.granularity}`;
  return `${at}|${deviceId}|${id}`;
}
