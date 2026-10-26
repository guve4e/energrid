/** Protocol-independent durable history contracts and deterministic bucket math. */
export type DeviceHealthMetricSemantics = 'gauge' | 'counter';

export interface DeviceHealthMetricObservation {
  name: string;
  value: number | null;
  unit: string;
  semantics: DeviceHealthMetricSemantics;
  source: string;
}

export interface DeviceHealthObservation {
  tenantId: string;
  siteId: string;
  deviceId: string;
  physicalDeviceId: string;
  sampleId: string;
  observedAt: string;
  bootSessionId: string;
  resetEvidence?: { reason: string; code: number; details: Record<string, number> | null; source: string };
  metrics: DeviceHealthMetricObservation[];
}

export interface DeviceHealthMetricSummary {
  minimum: number;
  maximum: number;
  sum: number;
  sampleCount: number;
  missingSampleCount: number;
  firstValue: number;
  firstObservedAt: string;
  lastValue: number;
  lastObservedAt: string;
  unit: string;
  source: string;
}

export interface DeviceHealthCounterSummary {
  bootSessionId: string;
  firstValue: number;
  firstObservedAt: string;
  lastValue: number;
  lastObservedAt: string;
  delta: number | null;
  resetObserved: boolean;
  orderingComplete: boolean;
  unit: string;
  source: string;
}

export interface DeviceHealthBucketSummary {
  schemaVersion: 1;
  tenantId: string;
  siteId: string;
  deviceId: string;
  physicalDeviceId: string;
  granularity: 'hourly' | 'daily';
  bucketStartAt: string;
  bucketEndAt: string;
  firstObservedAt: string;
  lastObservedAt: string;
  sampleCount: number;
  expectedIntervalMs: number;
  expectedSampleCount: number;
  missingSampleCount: number;
  coverageRatio: number;
  partialBucket: boolean;
  metrics: Record<string, DeviceHealthMetricSummary>;
  counters: Record<string, DeviceHealthCounterSummary[]>;
}

export interface DeviceHealthHistoryQuery {
  deviceId?: string;
  from?: string;
  to?: string;
  timezone?: string;
  cursor?: string;
  metrics?: string[];
  granularity: 'raw' | 'hourly' | 'daily' | 'events' | 'failures';
  limit?: number;
}

export interface DeviceHealthHistoryPage {
  schemaVersion: 1;
  tenantId: string;
  siteId: string;
  granularity: DeviceHealthHistoryQuery['granularity'];
  from: string | null;
  to: string | null;
  records: unknown[];
  analysis?: import('./device-health-query').DeviceHealthQueryResult;
}

export function utcBucketStart(observedAt: string, granularity: 'hourly' | 'daily'): string {
  const time = Date.parse(observedAt);
  if (!Number.isFinite(time)) throw new Error('Invalid device health observation timestamp');
  const date = new Date(time);
  date.setUTCMinutes(0, 0, 0);
  if (granularity === 'daily') date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function applyDeviceHealthObservation(
  previous: DeviceHealthBucketSummary | null,
  observation: DeviceHealthObservation,
  granularity: 'hourly' | 'daily',
  expectedIntervalMs: number,
): DeviceHealthBucketSummary {
  const bucketStartAt = utcBucketStart(observation.observedAt, granularity);
  const bucketWidthMs = granularity === 'hourly' ? 3_600_000 : 86_400_000;
  const bucketStartMs = Date.parse(bucketStartAt);
  const prior = previous && previous.bucketStartAt === bucketStartAt ? previous : null;
  const firstObservedAt = !prior || Date.parse(observation.observedAt) < Date.parse(prior.firstObservedAt)
    ? observation.observedAt : prior.firstObservedAt;
  const lastObservedAt = !prior || Date.parse(observation.observedAt) >= Date.parse(prior.lastObservedAt)
    ? observation.observedAt : prior.lastObservedAt;
  const sampleCount = (prior?.sampleCount || 0) + 1;
  const expectedSampleCount = Math.max(1,
    Math.floor((Date.parse(lastObservedAt) - Date.parse(firstObservedAt)) / expectedIntervalMs) + 1);
  const partialBucket = Date.parse(firstObservedAt) > bucketStartMs ||
    Date.parse(lastObservedAt) < bucketStartMs + bucketWidthMs - expectedIntervalMs;
  const metrics = { ...(prior?.metrics || {}) };
  const counters = { ...(prior?.counters || {}) };

  for (const metric of observation.metrics) {
    if (metric.value === null || !Number.isFinite(metric.value)) continue;
    if (metric.semantics === 'gauge') {
      const existing = metrics[metric.name];
      if (existing && (existing.unit !== metric.unit || existing.source !== metric.source)) {
        throw new Error(`Device health metric ${metric.name} changed unit or source within a bucket`);
      }
      const metricFirst = !existing || Date.parse(observation.observedAt) < Date.parse(existing.firstObservedAt);
      const metricLast = !existing || Date.parse(observation.observedAt) >= Date.parse(existing.lastObservedAt);
      const count = (existing?.sampleCount || 0) + 1;
      metrics[metric.name] = {
        minimum: existing ? Math.min(existing.minimum, metric.value) : metric.value,
        maximum: existing ? Math.max(existing.maximum, metric.value) : metric.value,
        sum: (existing?.sum || 0) + metric.value,
        sampleCount: count,
        missingSampleCount: Math.max(0, expectedSampleCount - count),
        firstValue: metricFirst ? metric.value : existing.firstValue,
        firstObservedAt: metricFirst ? observation.observedAt : existing.firstObservedAt,
        lastValue: metricLast ? metric.value : existing.lastValue,
        lastObservedAt: metricLast ? observation.observedAt : existing.lastObservedAt,
        unit: metric.unit,
        source: metric.source,
      };
      continue;
    }
    const series = [...(counters[metric.name] || [])];
    const existing = series.find(counter => counter.bootSessionId === observation.bootSessionId);
    if (existing && (existing.unit !== metric.unit || existing.source !== metric.source)) {
      throw new Error(`Device health counter ${metric.name} changed unit or source within a bucket`);
    }
    if (!existing) {
      series.push({ bootSessionId: observation.bootSessionId, firstValue: metric.value,
        firstObservedAt: observation.observedAt, lastValue: metric.value,
        lastObservedAt: observation.observedAt, delta: 0, resetObserved: false,
        orderingComplete: true,
        unit: metric.unit, source: metric.source });
    } else if (Date.parse(observation.observedAt) < Date.parse(existing.firstObservedAt)) {
      existing.firstValue = metric.value;
      existing.firstObservedAt = observation.observedAt;
      existing.orderingComplete = false;
      existing.resetObserved ||= metric.value > existing.lastValue;
      existing.delta = existing.orderingComplete && !existing.resetObserved
        ? existing.lastValue - existing.firstValue : null;
    } else if (Date.parse(observation.observedAt) >= Date.parse(existing.lastObservedAt)) {
      existing.resetObserved ||= metric.value < existing.lastValue;
      existing.lastValue = metric.value;
      existing.lastObservedAt = observation.observedAt;
      existing.delta = existing.resetObserved || !existing.orderingComplete ? null : existing.lastValue - existing.firstValue;
    } else {
      existing.orderingComplete = false;
      existing.delta = null;
    }
    counters[metric.name] = series.sort((left, right) => Date.parse(left.firstObservedAt) - Date.parse(right.firstObservedAt));
  }

  return {
    schemaVersion: 1,
    tenantId: observation.tenantId,
    siteId: observation.siteId,
    deviceId: observation.deviceId,
    physicalDeviceId: observation.physicalDeviceId,
    granularity,
    bucketStartAt,
    bucketEndAt: new Date(bucketStartMs + bucketWidthMs).toISOString(),
    firstObservedAt,
    lastObservedAt,
    sampleCount,
    expectedIntervalMs,
    expectedSampleCount,
    missingSampleCount: Math.max(0, expectedSampleCount - sampleCount),
    coverageRatio: Math.min(1, sampleCount / expectedSampleCount),
    partialBucket,
    metrics,
    counters,
  };
}

/** Daily buckets are rebuilt from their UTC hourly buckets, retaining extrema and weighted sums. */
export function summarizeDailyFromHourly(
  hourlyBuckets: DeviceHealthBucketSummary[],
  dayStartAt: string,
  expectedIntervalMs: number,
): DeviceHealthBucketSummary | null {
  if (!hourlyBuckets.length) return null;
  const dayStartMs = Date.parse(dayStartAt);
  const dayEndMs = dayStartMs + 86_400_000;
  const buckets = hourlyBuckets.filter(bucket => Date.parse(bucket.bucketStartAt) >= dayStartMs &&
    Date.parse(bucket.bucketStartAt) < dayEndMs).sort((left, right) =>
    Date.parse(left.bucketStartAt) - Date.parse(right.bucketStartAt));
  if (!buckets.length) return null;
  const firstObservedAt = buckets.reduce((at, item) => Date.parse(item.firstObservedAt) < Date.parse(at) ? item.firstObservedAt : at,
    buckets[0].firstObservedAt);
  const lastObservedAt = buckets.reduce((at, item) => Date.parse(item.lastObservedAt) > Date.parse(at) ? item.lastObservedAt : at,
    buckets[0].lastObservedAt);
  const sampleCount = buckets.reduce((count, item) => count + item.sampleCount, 0);
  const expectedSampleCount = Math.max(1, Math.floor((Date.parse(lastObservedAt) - Date.parse(firstObservedAt)) /
    expectedIntervalMs) + 1);
  const metrics: Record<string, DeviceHealthMetricSummary> = {};
  const counters: Record<string, DeviceHealthCounterSummary[]> = {};
  for (const bucket of buckets) {
    for (const [name, metric] of Object.entries(bucket.metrics)) {
      const existing = metrics[name];
      if (existing && (existing.unit !== metric.unit || existing.source !== metric.source)) {
        throw new Error(`Device health metric ${name} changed unit or source within a day`);
      }
      const first = !existing || Date.parse(metric.firstObservedAt) < Date.parse(existing.firstObservedAt);
      const last = !existing || Date.parse(metric.lastObservedAt) >= Date.parse(existing.lastObservedAt);
      metrics[name] = {
        minimum: existing ? Math.min(existing.minimum, metric.minimum) : metric.minimum,
        maximum: existing ? Math.max(existing.maximum, metric.maximum) : metric.maximum,
        sum: (existing?.sum || 0) + metric.sum,
        sampleCount: (existing?.sampleCount || 0) + metric.sampleCount,
        missingSampleCount: 0,
        firstValue: first ? metric.firstValue : existing.firstValue,
        firstObservedAt: first ? metric.firstObservedAt : existing.firstObservedAt,
        lastValue: last ? metric.lastValue : existing.lastValue,
        lastObservedAt: last ? metric.lastObservedAt : existing.lastObservedAt,
        unit: metric.unit,
        source: metric.source,
      };
    }
    for (const [name, series] of Object.entries(bucket.counters)) {
      const target = counters[name] || (counters[name] = []);
      for (const counter of series) {
        const existing = target.find(item => item.bootSessionId === counter.bootSessionId);
        if (existing && (existing.unit !== counter.unit || existing.source !== counter.source)) {
          throw new Error(`Device health counter ${name} changed unit or source within a day`);
        }
        if (!existing) target.push({ ...counter });
        else {
          const earlier = Date.parse(counter.firstObservedAt) < Date.parse(existing.firstObservedAt);
          const later = Date.parse(counter.lastObservedAt) > Date.parse(existing.lastObservedAt);
          const firstValue = earlier ? counter.firstValue : existing.firstValue;
          const lastValue = later ? counter.lastValue : existing.lastValue;
          const resetObserved = existing.resetObserved || counter.resetObserved ||
            (earlier && counter.lastValue < existing.firstValue) || (later && counter.firstValue < existing.lastValue);
          existing.firstValue = firstValue;
          if (earlier) existing.firstObservedAt = counter.firstObservedAt;
          existing.lastValue = lastValue;
          if (later) existing.lastObservedAt = counter.lastObservedAt;
          existing.resetObserved = resetObserved;
          existing.orderingComplete &&= counter.orderingComplete && (earlier || later);
          existing.delta = resetObserved || !existing.orderingComplete ? null : lastValue - firstValue;
        }
      }
    }
  }
  const partialBucket = Date.parse(firstObservedAt) > dayStartMs || Date.parse(lastObservedAt) < dayEndMs - expectedIntervalMs;
  for (const metric of Object.values(metrics)) metric.missingSampleCount = Math.max(0, expectedSampleCount - metric.sampleCount);
  for (const series of Object.values(counters)) series.sort((left, right) => Date.parse(left.firstObservedAt) - Date.parse(right.firstObservedAt));
  return {
    schemaVersion: 1,
    tenantId: buckets[0].tenantId,
    siteId: buckets[0].siteId,
    deviceId: buckets[0].deviceId,
    physicalDeviceId: buckets[0].physicalDeviceId,
    granularity: 'daily',
    bucketStartAt: new Date(dayStartMs).toISOString(),
    bucketEndAt: new Date(dayEndMs).toISOString(),
    firstObservedAt,
    lastObservedAt,
    sampleCount,
    expectedIntervalMs,
    expectedSampleCount,
    missingSampleCount: Math.max(0, expectedSampleCount - sampleCount),
    coverageRatio: Math.min(1, sampleCount / expectedSampleCount),
    partialBucket,
    metrics,
    counters,
  };
}
