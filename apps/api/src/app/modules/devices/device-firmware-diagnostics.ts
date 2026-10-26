import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  applyDeviceHealthObservation,
  summarizeDailyFromHourly,
  type DeviceHealthBucketSummary,
  type DeviceHealthHistoryPage,
  type DeviceHealthHistoryQuery,
  type DeviceHealthMetricObservation,
  type DeviceHealthObservation,
  utcBucketStart,
} from './device-health-history';
import { DeviceHealthQueryService, type DeviceHealthEventEvidence, type DeviceHealthQueryDataset } from '@energrid/domain-devices';

export interface FirmwareDiagnosticScope {
  tenantId: string;
  siteId: string;
}

export interface FirmwareDiagnosticSample {
  schemaVersion: 1;
  deviceId: string;
  firmwareVersion: string;
  bootSessionId: string;
  uptimeMs: number;
  reset: {
    reason: string;
    reasonCode: number;
    exception: null | {
      cause: number;
      epc1: number;
      epc2: number;
      epc3: number;
      address: number;
      depc: number;
    };
  };
  memory: {
    freeHeapBytes: number | null;
    heapFragmentationPct: number | null;
    largestFreeBlockBytes: number | null;
  };
  wifi: {
    connected: boolean;
    rssiDbm: number | null;
    disconnectCount: number;
    reconnectCount: number;
  };
  sensor: {
    sampleCount: number;
    readFailureCount: number;
  };
}

export type FirmwareHealthEventKind =
  | 'reboot-detected'
  | 'repeated-reboots'
  | 'watchdog-reset'
  | 'exception-reset'
  | 'reset-cause-unknown'
  | 'memory-warning'
  | 'wifi-instability';

export interface FirmwareHealthEvent {
  id: string;
  kind: FirmwareHealthEventKind;
  observedAt: string;
  bootSessionId: string;
  confidence: 'confirmed' | 'possible';
  summary: string;
  explanation: string;
  /** Server-side evidence source. Legacy events may omit it. */
  source?: { protocol: 'http'; method: 'GET'; path: '/api/v1/diagnostics' };
  /** observedAt is when the collector detected this event, not device wall-clock time. */
  observedAtBasis?: 'server-detection-time';
  /** Explicit copy of the server detection instant. Absent on legacy events. */
  detectedAt?: string;
  /** Estimate only: collection time minus firmware-reported uptime. Never a physical timestamp. */
  inferredBootAt?: { at: string; basis: 'collected-at-minus-reported-uptime' };
  /** Identifies the diagnostic sample that supported this event. */
  evidenceReferences?: Array<{ type: 'firmware-diagnostic-snapshot'; observedAt: string; bootSessionId: string }>;
  deduplicationKey?: string;
}

export interface FirmwareDiagnosticsView {
  deviceId: string;
  tenantId: string;
  siteId: string;
  sampledAt: string;
  current: FirmwareDiagnosticSample | null;
  snapshots: FirmwareDiagnosticSnapshot[];
  lastAttemptAt: string;
  lastSuccessfulContactAt: string | null;
  collectionStatus: 'success' | 'failed';
  collectionFailures: FirmwareDiagnosticCollectionFailure[];
  events: FirmwareHealthEvent[];
  restartCount10m: number;
  connectivity: 'connected' | 'disconnected' | 'unknown';
}

export interface FirmwareDiagnosticSnapshot {
  collectedAt: string;
  /** Current firmware has no wall-clock sample timestamp; do not infer one from uptime. */
  deviceObservedAt: null;
  protocol: 'http';
  method: 'GET';
  path: '/api/v1/diagnostics';
  identityVerifiedAt: string;
  sample: FirmwareDiagnosticSample;
}

export type FirmwareDiagnosticFailureReason =
  | 'request_timeout'
  | 'identity_mismatch'
  | 'identity_request_failed'
  | 'endpoint_unverified'
  | 'scope_rejected'
  | 'diagnostics_http_error'
  | 'response_invalid'
  | 'collector_error';

export interface FirmwareDiagnosticCollectionFailure {
  id: string;
  attemptedAt: string;
  reason: FirmwareDiagnosticFailureReason;
  /** Local observer and selected endpoint context at failure time; legacy failures omit it. */
  context?: FirmwareDiagnosticCollectionContext;
}

export interface FirmwareDiagnosticCollectionContext {
  observer: {
    id: string;
    host: string;
    platform: string;
    localScopes: Array<{ interfaceName: string; cidr: string; address: string }>;
  };
  target: {
    endpoint: string;
    ipAddress: string;
    networkScopeId: string;
    networkScopeName: string;
  };
}

/** Accept only the bounded V1 firmware contract and the expected physical identity. */
export function parseFirmwareDiagnosticSample(value: unknown, expectedDeviceId: string): FirmwareDiagnosticSample | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1 || typeof root.deviceId !== 'string' || root.deviceId.toLowerCase() !== expectedDeviceId.toLowerCase() ||
      typeof root.firmwareVersion !== 'string' || root.firmwareVersion.length < 1 || root.firmwareVersion.length > 40 ||
      typeof root.bootSessionId !== 'string' || !/^esp8266-[0-9a-f]{6}-[0-9a-f]{8}$/i.test(root.bootSessionId) ||
      !isSafeCounter(root.uptimeMs)) return null;
  const reset = objectValue(root.reset);
  const memory = objectValue(root.memory);
  const wifi = objectValue(root.wifi);
  const sensor = objectValue(root.sensor);
  if (!reset || !memory || !wifi || !sensor || typeof reset.reason !== 'string' || reset.reason.length > 120 ||
      !Number.isInteger(reset.reasonCode) || Number(reset.reasonCode) < -1 || Number(reset.reasonCode) > 255 ||
      typeof wifi.connected !== 'boolean' || !isSafeCounter(wifi.disconnectCount) || !isSafeCounter(wifi.reconnectCount) ||
      !isSafeCounter(sensor.sampleCount) || !isSafeCounter(sensor.readFailureCount)) return null;
  const exception = reset.exception === null ? null : objectValue(reset.exception);
  if (reset.exception !== null && (!exception || !['cause', 'epc1', 'epc2', 'epc3', 'address', 'depc']
    .every(key => isSafeCounter(exception[key])))) return null;
  const freeHeapBytes = nullableMetric(memory.freeHeapBytes, 0, 1_000_000);
  const heapFragmentationPct = nullableMetric(memory.heapFragmentationPct, 0, 100);
  const largestFreeBlockBytes = nullableMetric(memory.largestFreeBlockBytes, 0, 1_000_000);
  const rssiDbm = nullableMetric(wifi.rssiDbm, -127, 0);
  if (freeHeapBytes === undefined || heapFragmentationPct === undefined || largestFreeBlockBytes === undefined ||
      rssiDbm === undefined || (wifi.connected && rssiDbm === null) || (!wifi.connected && rssiDbm !== null)) return null;
  return {
    schemaVersion: 1,
    deviceId: expectedDeviceId.toLowerCase(),
    firmwareVersion: root.firmwareVersion,
    bootSessionId: root.bootSessionId,
    uptimeMs: Number(root.uptimeMs),
    reset: {
      reason: reset.reason,
      reasonCode: Number(reset.reasonCode),
      exception: exception ? {
        cause: Number(exception.cause), epc1: Number(exception.epc1), epc2: Number(exception.epc2),
        epc3: Number(exception.epc3), address: Number(exception.address), depc: Number(exception.depc),
      } : null,
    },
    memory: { freeHeapBytes, heapFragmentationPct, largestFreeBlockBytes },
    wifi: {
      connected: wifi.connected,
      rssiDbm,
      disconnectCount: Number(wifi.disconnectCount),
      reconnectCount: Number(wifi.reconnectCount),
    },
    sensor: { sampleCount: Number(sensor.sampleCount), readFailureCount: Number(sensor.readFailureCount) },
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isSafeCounter(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nullableMetric(value: unknown, minimum: number, maximum: number): number | null | undefined {
  if (value === null) return null;
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : undefined;
}

interface StoredView extends FirmwareDiagnosticsView {
  schemaVersion: 1;
  historyBackfilledThroughAt?: string;
  lastRetentionSweepAt?: string;
}

export const FIRMWARE_DIAGNOSTICS_STORE_DIRECTORY = Symbol('FIRMWARE_DIAGNOSTICS_STORE_DIRECTORY');

const eventLimit = 100;
const failureLimit = 1_440;
const restartWindowMs = 10 * 60_000;
const maxQueryRecordsPerPrefix = 20_000;
const maxQuerySiteDevices = 100;
const deviceHealthQueryService = new DeviceHealthQueryService();

export interface DeviceHealthRetentionOptions {
  rawSampleDays: number;
  hourlySummaryDays: number;
  dailySummaryDays: number;
  significantEventDays: number;
  communicationFailureDays: number;
  expectedIntervalMs: number;
  retentionSweepIntervalMs: number;
}

const defaultRetention: DeviceHealthRetentionOptions = {
  rawSampleDays: 7,
  hourlySummaryDays: 90,
  dailySummaryDays: 730,
  significantEventDays: 3650,
  communicationFailureDays: 90,
  expectedIntervalMs: 60_000,
  retentionSweepIntervalMs: 24 * 60 * 60_000,
};

function configuredRetention(overrides: Partial<DeviceHealthRetentionOptions> = {}): DeviceHealthRetentionOptions {
  const fromEnv = (key: string, fallback: number, minimum: number, maximum: number) => {
    const value = Number(process.env[key]);
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
  };
  return {
    rawSampleDays: overrides.rawSampleDays ?? fromEnv('HOME_DEVICE_HEALTH_RAW_DAYS', 7, 1, 30),
    hourlySummaryDays: overrides.hourlySummaryDays ?? fromEnv('HOME_DEVICE_HEALTH_HOURLY_DAYS', 90, 1, 3650),
    dailySummaryDays: overrides.dailySummaryDays ?? fromEnv('HOME_DEVICE_HEALTH_DAILY_DAYS', 730, 1, 7300),
    significantEventDays: overrides.significantEventDays ?? fromEnv('HOME_DEVICE_HEALTH_EVENT_DAYS', 3650, 365, 7300),
    communicationFailureDays: overrides.communicationFailureDays ?? fromEnv('HOME_DEVICE_HEALTH_FAILURE_DAYS', 90, 1, 3650),
    expectedIntervalMs: overrides.expectedIntervalMs ?? fromEnv('HOME_FIRMWARE_DIAGNOSTICS_INTERVAL_MS', 60_000, 15_000, 900_000),
    retentionSweepIntervalMs: overrides.retentionSweepIntervalMs ?? defaultRetention.retentionSweepIntervalMs,
  };
}

function diagnosticsKey(scope: FirmwareDiagnosticScope, deviceId: string): string {
  if (!scope.tenantId.trim() || !scope.siteId.trim() || !deviceId.trim()) {
    throw new Error('Tenant, site and stable device identity are required for firmware diagnostics');
  }
  return `firmware-diagnostics:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.siteId)}:${encodeURIComponent(deviceId)}`;
}

function eventId(kind: FirmwareHealthEventKind, bootSessionId: string): string {
  return createHash('sha256').update(`${kind}\0${bootSessionId}`).digest('hex').slice(0, 24);
}

function failureId(deviceId: string, attemptedAt: string, reason: FirmwareDiagnosticFailureReason): string {
  return createHash('sha256').update(`${deviceId}\0${attemptedAt}\0${reason}`).digest('hex').slice(0, 24);
}

function event(
  kind: FirmwareHealthEventKind,
  sample: FirmwareDiagnosticSample,
  observedAt: string,
  summary: string,
  explanation: string,
  confidence: FirmwareHealthEvent['confidence'] = 'confirmed',
): FirmwareHealthEvent {
  const isBootEvent = kind === 'reboot-detected';
  return {
    id: eventId(kind, sample.bootSessionId),
    kind,
    observedAt,
    bootSessionId: sample.bootSessionId,
    confidence,
    summary,
    explanation,
    source: { protocol: 'http', method: 'GET', path: '/api/v1/diagnostics' },
    observedAtBasis: 'server-detection-time',
    detectedAt: observedAt,
    ...(isBootEvent ? { inferredBootAt: {
      at: new Date(Date.parse(observedAt) - sample.uptimeMs).toISOString(),
      basis: 'collected-at-minus-reported-uptime' as const,
    } } : {}),
    evidenceReferences: [{ type: 'firmware-diagnostic-snapshot', observedAt, bootSessionId: sample.bootSessionId }],
    deduplicationKey: `${kind}:${sample.bootSessionId}`,
  };
}

export function deriveFirmwareHealthEvents(
  previous: FirmwareDiagnosticsView | null,
  current: FirmwareDiagnosticSample,
  observedAt: string,
  priorEvents: FirmwareHealthEvent[] = [],
): FirmwareHealthEvent[] {
  const created: FirmwareHealthEvent[] = [];
  const reset = current.reset.reasonCode;

  const priorSample = previous?.current || null;
  const sessionChanged = priorSample && priorSample.bootSessionId !== current.bootSessionId;
  const uptimeReset = priorSample && current.uptimeMs < priorSample.uptimeMs;
  if (sessionChanged || uptimeReset) {
    created.push(event('reboot-detected', current, observedAt,
      'A new firmware boot session was detected.',
      sessionChanged
        ? 'The device-reported boot session changed since the previous verified diagnostics poll.'
        : 'Device uptime decreased since the previous verified diagnostics poll; the boot session identifier remained unchanged.'));
  }

  if (reset === 1 || reset === 3) {
    created.push(event('watchdog-reset', current, observedAt,
      'The firmware reports a watchdog reset.',
      `ESP8266 reset code ${reset} identifies a ${reset === 1 ? 'hardware' : 'software'} watchdog reset.`));
  } else if (reset === 2) {
    created.push(event('exception-reset', current, observedAt,
      'The firmware reports an exception reset.',
      current.reset.exception
        ? `Exception cause ${current.reset.exception.cause}; exception address details are available in the current diagnostics.`
        : 'The reset is classified as an exception, but the SDK supplied no exception detail fields.'));
  } else if (reset < 0 || reset === 0 || reset > 6) {
    created.push(event('reset-cause-unknown', current, observedAt,
      'Reset cause is unknown.',
      'The reset evidence does not identify a cause. Power interruption is one possibility, but these diagnostics do not establish a power-supply fault.',
      'possible'));
  }

  const memory = current.memory;
  if ((memory.freeHeapBytes !== null && memory.freeHeapBytes < 8_000) ||
      (memory.heapFragmentationPct !== null && memory.heapFragmentationPct >= 50) ||
      (memory.largestFreeBlockBytes !== null && memory.largestFreeBlockBytes < 4_096)) {
    created.push(event('memory-warning', current, observedAt,
      'Firmware memory is below the diagnostic thresholds.',
      'At least one reported heap metric crossed the V1 warning threshold (free heap < 8000 bytes, largest block < 4096 bytes, or fragmentation >= 50%).'));
  }

  if (current.wifi.disconnectCount >= 3) {
    created.push(event('wifi-instability', current, observedAt,
      'Multiple Wi-Fi disconnections were reported during this boot session.',
      `The firmware reports ${current.wifi.disconnectCount} disconnection events; this indicates Wi-Fi instability, not sensor staleness.`));
  }

  const timeline = [...priorEvents, ...created];
  const restartTimes = timeline
    .filter(item => item.kind === 'reboot-detected')
    .map(item => Date.parse(item.observedAt))
    .filter(Number.isFinite)
    .filter(time => Date.parse(observedAt) - time >= 0 && Date.parse(observedAt) - time <= restartWindowMs);
  if (restartTimes.length >= 3) {
    created.push(event('repeated-reboots', current, observedAt,
      `${restartTimes.length} device restarts were observed within 10 minutes.`,
      'Repeated boot-session changes are confirmed. Their underlying cause is not established by restart frequency alone.'));
  }

  return created;
}

function encodedPart(value: string): string { return encodeURIComponent(value); }

function healthKey(kind: string, scope: FirmwareDiagnosticScope, deviceId: string, suffix = ''): string {
  return `device-health:${kind}:${encodedPart(scope.tenantId)}:${encodedPart(scope.siteId)}:${encodedPart(deviceId)}:${suffix}`;
}

function siteDeviceIndexPrefix(scope: FirmwareDiagnosticScope): string {
  return `device-health:index:${encodedPart(scope.tenantId)}:${encodedPart(scope.siteId)}:`;
}

function observationFor(
  scope: FirmwareDiagnosticScope,
  deviceId: string,
  physicalId: string,
  snapshot: FirmwareDiagnosticSnapshot,
): DeviceHealthObservation {
  const sample = snapshot.sample;
  const source = 'http:GET:/api/v1/diagnostics';
  const metric = (name: string, value: number | null, unit: string,
    semantics: DeviceHealthMetricObservation['semantics'] = 'gauge'): DeviceHealthMetricObservation =>
    ({ name, value, unit, semantics, source });
  return {
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    deviceId,
    physicalDeviceId: physicalId,
    sampleId: createHash('sha256').update(`${snapshot.collectedAt}\0${JSON.stringify(sample)}`).digest('hex').slice(0, 32),
    observedAt: snapshot.collectedAt,
    bootSessionId: sample.bootSessionId,
    resetEvidence: { reason: sample.reset.reason, code: sample.reset.reasonCode,
      details: sample.reset.exception ? { ...sample.reset.exception } : null, source },
    metrics: [
      metric('wifi.rssi', sample.wifi.rssiDbm, 'dBm'),
      metric('memory.free_heap', sample.memory.freeHeapBytes, 'bytes'),
      metric('memory.fragmentation', sample.memory.heapFragmentationPct, '%'),
      metric('memory.largest_free_block', sample.memory.largestFreeBlockBytes, 'bytes'),
      metric('uptime', sample.uptimeMs, 'ms', 'counter'),
      metric('wifi.disconnect_count', sample.wifi.disconnectCount, 'count', 'counter'),
      metric('wifi.reconnect_count', sample.wifi.reconnectCount, 'count', 'counter'),
      metric('sensor.sample_count', sample.sensor.sampleCount, 'count', 'counter'),
      metric('sensor.read_failure_count', sample.sensor.readFailureCount, 'count', 'counter'),
    ],
  };
}

function withEventProvenance(item: FirmwareHealthEvent): FirmwareHealthEvent {
  return {
    ...item,
    deduplicationKey: item.deduplicationKey || `${item.kind}:${item.bootSessionId}`,
  };
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'LEVEL_NOT_FOUND';
}

function utcBucketKeyPart(observedAt: string, granularity: 'hourly' | 'daily'): string {
  return utcBucketStart(observedAt, granularity);
}

function inRange(at: string, from: number, to: number): boolean {
  const time = Date.parse(at);
  return Number.isFinite(time) && time >= from && time <= to;
}

function historyRecordCursor(granularity: DeviceHealthHistoryQuery['granularity'], value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const deviceId = String(row.deviceId || '');
  const id = String(row.id || '');
  if (granularity === 'raw') {
    const collectedAt = String(row.collectedAt || '');
    const sample = row.sample as FirmwareDiagnosticSample | undefined;
    if (!deviceId || !sample || !collectedAt) return null;
    const snapshot = row as unknown as FirmwareDiagnosticSnapshot;
    const observation = observationFor({ tenantId: String(row.tenantId), siteId: String(row.siteId) },
      deviceId, String(row.physicalDeviceId), snapshot);
    return `${observation.observedAt}|${deviceId}|${observation.sampleId}`;
  }
  if (granularity === 'hourly' || granularity === 'daily') {
    const bucket = row as unknown as DeviceHealthBucketSummary;
    return `${bucket.bucketStartAt}|${bucket.deviceId}|${bucket.bucketStartAt}:${bucket.granularity}`;
  }
  const at = String(granularity === 'events' ? row.observedAt : row.attemptedAt || '');
  return deviceId && id && at ? `${at}|${deviceId}|${id}` : null;
}

@Injectable()
export class DeviceFirmwareDiagnosticsService implements OnModuleDestroy {
  private readonly db: ClassicLevel<string, unknown>;
  private readonly retention: DeviceHealthRetentionOptions;
  private tail: Promise<void> = Promise.resolve();
  private opened?: Promise<void>;

  constructor(
    @Optional() @Inject(FIRMWARE_DIAGNOSTICS_STORE_DIRECTORY) directory?: string,
    @Optional() retention: Partial<DeviceHealthRetentionOptions> = {},
  ) {
    this.db = new ClassicLevel(directory?.trim() || process.env.HOME_FIRMWARE_DIAGNOSTICS_DIRECTORY?.trim() ||
      join(homedir(), '.energrid', 'device-firmware-diagnostics'), { valueEncoding: 'json' });
    this.retention = configuredRetention(retention);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.close();
  }

  async record(
    scope: FirmwareDiagnosticScope,
    deviceId: string,
    physicalId: string,
    sample: FirmwareDiagnosticSample,
    observedAt = new Date().toISOString(),
  ): Promise<FirmwareDiagnosticsView> {
    if (sample.deviceId !== physicalId || !/^esp8266:[0-9a-f]{6}$/i.test(physicalId) ||
        !scope.tenantId.trim() || !scope.siteId.trim() ||
        !Number.isFinite(Date.parse(observedAt))) {
      throw new Error('Invalid firmware diagnostics evidence');
    }
    return this.serialize(async () => {
      await this.open();
      const key = diagnosticsKey(scope, deviceId);
      const previous = await this.getValue(key);
      const previousView = previous && previous.tenantId === scope.tenantId && previous.siteId === scope.siteId
        ? previous
        : null;
      const newEvents = deriveFirmwareHealthEvents(previousView, sample, observedAt, previousView?.events || []);
      const allEvents = [...(previousView?.events || []).map(withEventProvenance), ...newEvents.map(withEventProvenance)]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
      const events = allEvents.slice(-eventLimit);
      const restartCount10m = allEvents.filter(item => item.kind === 'reboot-detected' &&
        Date.parse(observedAt) - Date.parse(item.observedAt) >= 0 &&
        Date.parse(observedAt) - Date.parse(item.observedAt) <= restartWindowMs).length;
      const snapshot: FirmwareDiagnosticSnapshot = {
        collectedAt: observedAt,
        deviceObservedAt: null,
        protocol: 'http',
        method: 'GET',
        path: '/api/v1/diagnostics',
        identityVerifiedAt: observedAt,
        sample,
      };
      const snapshots = [...(previousView?.snapshots || []), snapshot]
        .filter((item, index, all) => all.findIndex(other => other.collectedAt === item.collectedAt &&
          JSON.stringify(other.sample) === JSON.stringify(item.sample)) === index)
        .sort((left, right) => Date.parse(left.collectedAt) - Date.parse(right.collectedAt));
      const cutoff = Date.parse(observedAt) - this.retention.rawSampleDays * 86_400_000;
      const maxRawSamples = Math.min(100_000, Math.ceil(this.retention.rawSampleDays * 86_400_000 /
        this.retention.expectedIntervalMs * 1.25));
      const retainedSnapshots = snapshots.filter(item => Date.parse(item.collectedAt) >= cutoff).slice(-maxRawSamples);
      const view: StoredView = {
        schemaVersion: 1,
        deviceId,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        sampledAt: observedAt,
        current: sample,
        snapshots: retainedSnapshots,
        lastAttemptAt: observedAt,
        lastSuccessfulContactAt: observedAt,
        collectionStatus: 'success',
        collectionFailures: previousView?.collectionFailures || [],
        events,
        restartCount10m,
        connectivity: sample.wifi.connected ? 'connected' : 'disconnected',
        historyBackfilledThroughAt: snapshots.at(-1)?.collectedAt || previousView?.historyBackfilledThroughAt || '',
        lastRetentionSweepAt: previousView?.lastRetentionSweepAt,
      };

      const pendingBuckets = new Map<string, DeviceHealthBucketSummary>();
      const operations: Array<{ type: 'put' | 'del'; key: string; value?: unknown }> = [];
      const affectedDays = new Set<string>();
      const legacySnapshots = previousView?.historyBackfilledThroughAt
        ? [] : (previousView?.snapshots || []);
      const hourlyCutoff = Date.parse(observedAt) - this.retention.hourlySummaryDays * 86_400_000;
      for (const item of [...legacySnapshots, snapshot]) {
        if (Date.parse(item.collectedAt) < hourlyCutoff) {
          affectedDays.add(utcBucketKeyPart(item.collectedAt, 'daily'));
          await this.stageLateDaily(scope, deviceId, physicalId, item, pendingBuckets, operations);
        } else {
          await this.stageObservation(scope, deviceId, physicalId, item, pendingBuckets, operations, affectedDays);
        }
      }
      for (const dayStartAt of affectedDays) {
        // Daily rows are rebuilt from their hourly children while those children
        // are retained. Older late evidence amends the daily row idempotently above.
        const hourly = await this.readUtcDayHours(scope, deviceId, dayStartAt, pendingBuckets);
        if (Date.parse(dayStartAt) < hourlyCutoff) continue;
        const daily = summarizeDailyFromHourly(hourly, dayStartAt, this.retention.expectedIntervalMs);
        if (daily) pendingBuckets.set(healthKey('daily', scope, deviceId, dayStartAt), daily);
      }
      for (const [bucketKey, bucket] of pendingBuckets) operations.push({ type: 'put', key: bucketKey, value: bucket });
      operations.push({ type: 'put', key: siteDeviceIndexPrefix(scope) + encodedPart(deviceId), value: {
        tenantId: scope.tenantId, siteId: scope.siteId, deviceId, physicalDeviceId: physicalId,
      } });
      const eventMigrationKey = healthKey('meta', scope, deviceId, 'events-v1-migrated');
      const failureMigrationKey = healthKey('meta', scope, deviceId, 'failures-v1-migrated');
      const migrateEvents = !(await this.readValue(eventMigrationKey));
      const migrateFailures = !(await this.readValue(failureMigrationKey));
      const eventsToPersist = migrateEvents ? allEvents : newEvents.map(withEventProvenance);
      const failuresToPersist = migrateFailures ? (previousView?.collectionFailures || []) : [];
      for (const item of eventsToPersist) operations.push({ type: 'put',
        key: healthKey('event', scope, deviceId, item.id), value: {
          tenantId: scope.tenantId, siteId: scope.siteId, deviceId, physicalDeviceId: physicalId,
          ...withEventProvenance(item),
        } });
      for (const item of failuresToPersist) operations.push({ type: 'put',
        key: healthKey('failure', scope, deviceId, item.id), value: {
          tenantId: scope.tenantId, siteId: scope.siteId, deviceId, physicalDeviceId: physicalId, ...item,
        } });
      if (migrateEvents) operations.push({ type: 'put', key: eventMigrationKey, value: { completedAt: observedAt } });
      if (migrateFailures) operations.push({ type: 'put', key: failureMigrationKey, value: { completedAt: observedAt } });
      const sweepAt = this.shouldSweep(view.lastRetentionSweepAt, observedAt);
      if (sweepAt) {
        operations.push(...await this.retentionDeletes(scope, deviceId, observedAt));
        view.lastRetentionSweepAt = observedAt;
      }
      operations.push({ type: 'put', key, value: view });
      // LevelDB batch is atomic: new rollups and their idempotency markers are committed
      // with the raw-window update, so raw evidence is never removed before its rollup.
      await this.db.batch(operations as never);
      return stripSchema(view);
    });
  }

  async recordFailure(
    scope: FirmwareDiagnosticScope,
    deviceId: string,
    physicalId: string,
    reason: FirmwareDiagnosticFailureReason,
    attemptedAt = new Date().toISOString(),
    context?: FirmwareDiagnosticCollectionContext,
  ): Promise<FirmwareDiagnosticsView> {
    if (!/^esp8266:[0-9a-f]{6}$/i.test(physicalId) || !scope.tenantId.trim() || !scope.siteId.trim() ||
        !Number.isFinite(Date.parse(attemptedAt))) {
      throw new Error('Invalid firmware diagnostics collection failure');
    }
    return this.serialize(async () => {
      await this.open();
      const key = diagnosticsKey(scope, deviceId);
      const previous = await this.getValue(key);
      const previousView = previous && previous.tenantId === scope.tenantId && previous.siteId === scope.siteId && previous.deviceId === deviceId
        ? previous
        : null;
      const failure: FirmwareDiagnosticCollectionFailure = {
        id: failureId(deviceId, attemptedAt, reason), attemptedAt, reason,
        ...(context ? { context } : {}),
      };
      const failures = [...(previousView?.collectionFailures || []), failure].slice(-failureLimit);
      const view: StoredView = {
        schemaVersion: 1,
        deviceId,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        sampledAt: previousView?.sampledAt || '',
        current: previousView?.current || null,
        snapshots: previousView?.snapshots || [],
        lastAttemptAt: attemptedAt,
        lastSuccessfulContactAt: previousView?.lastSuccessfulContactAt || null,
        collectionStatus: 'failed',
        collectionFailures: failures,
        events: (previousView?.events || []).map(withEventProvenance),
        restartCount10m: previousView?.restartCount10m || 0,
        connectivity: previousView?.connectivity || 'unknown',
        historyBackfilledThroughAt: previousView?.historyBackfilledThroughAt,
        lastRetentionSweepAt: previousView?.lastRetentionSweepAt,
      };
      const operations: Array<{ type: 'put' | 'del'; key: string; value?: unknown }> = [
        { type: 'put', key: siteDeviceIndexPrefix(scope) + encodedPart(deviceId), value: {
          tenantId: scope.tenantId, siteId: scope.siteId, deviceId, physicalDeviceId: physicalId,
        } },
      ];
      const eventMigrationKey = healthKey('meta', scope, deviceId, 'events-v1-migrated');
      const failureMigrationKey = healthKey('meta', scope, deviceId, 'failures-v1-migrated');
      const migrateEvents = !(await this.readValue(eventMigrationKey));
      const migrateFailures = !(await this.readValue(failureMigrationKey));
      const eventsToPersist = migrateEvents ? view.events : [];
      const failuresToPersist = [...(migrateFailures ? (previousView?.collectionFailures || []) : []), failure];
      operations.push(...eventsToPersist.map(item => ({ type: 'put' as const,
        key: healthKey('event', scope, deviceId, item.id), value: {
          tenantId: scope.tenantId, siteId: scope.siteId, deviceId, physicalDeviceId: physicalId, ...item,
        } })));
      operations.push(...failuresToPersist.map(item => ({ type: 'put' as const,
        key: healthKey('failure', scope, deviceId, item.id), value: {
          tenantId: scope.tenantId, siteId: scope.siteId, deviceId, physicalDeviceId: physicalId, ...item,
        } })));
      if (migrateEvents) operations.push({ type: 'put', key: eventMigrationKey, value: { completedAt: attemptedAt } });
      if (migrateFailures) operations.push({ type: 'put', key: failureMigrationKey, value: { completedAt: attemptedAt } });
      if (this.shouldSweep(view.lastRetentionSweepAt, attemptedAt)) {
        operations.push(...await this.retentionDeletes(scope, deviceId, attemptedAt));
        view.lastRetentionSweepAt = attemptedAt;
      }
      operations.push({ type: 'put', key, value: view });
      await this.db.batch(operations as never);
      return stripSchema(view);
    });
  }

  async get(scope: FirmwareDiagnosticScope, deviceId: string): Promise<FirmwareDiagnosticsView | null> {
    return this.serialize(async () => {
      await this.open();
      const record = await this.getValue(diagnosticsKey(scope, deviceId));
      if (!record || record.tenantId !== scope.tenantId || record.siteId !== scope.siteId || record.deviceId !== deviceId) return null;
      return stripSchema({ ...record, events: (record.events || []).map(withEventProvenance) });
    });
  }

  async queryHistory(scope: FirmwareDiagnosticScope, query: DeviceHealthHistoryQuery,
    authorizedDevices?: Array<{ deviceId: string; physicalDeviceId: string }>): Promise<DeviceHealthHistoryPage> {
    if (!scope.tenantId.trim() || !scope.siteId.trim() ||
        !['raw', 'hourly', 'daily', 'events', 'failures'].includes(query.granularity)) {
      throw new Error('Invalid device health history query');
    }
    const now = Date.now();
    const aggregateWidth = query.granularity === 'daily' ? 86_400_000 : 3_600_000;
    const defaultTo = query.granularity === 'daily' || query.granularity === 'hourly'
      ? Math.floor(now / aggregateWidth) * aggregateWidth : now;
    const toAt = query.to || new Date(defaultTo).toISOString();
    const defaultRange = query.granularity === 'daily' ? 30 * 86_400_000 : 24 * 60 * 60_000;
    const fromAt = query.from || new Date(Date.parse(toAt) - defaultRange).toISOString();
    const from = Date.parse(fromAt);
    const to = Date.parse(toAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 730 * 86_400_000) {
      throw new Error('Invalid device health history time range');
    }
    if (query.granularity === 'raw' && from < Date.now() - this.retention.rawSampleDays * 86_400_000) {
      throw new Error('Invalid device health history time range: raw samples are outside the configured retention window; use hourly or daily summaries');
    }
    const limit = query.limit === undefined ? 500 : Math.max(1, Math.min(1000, Math.floor(query.limit)));
    return this.serialize(async () => {
      await this.open();
      const authorizedIds = authorizedDevices?.map(item => item.deviceId) || [];
      if (authorizedDevices !== undefined && query.deviceId && !authorizedIds.includes(query.deviceId)) {
        throw new Error('Invalid device health history query: device is not authorized in this site');
      }
      const deviceIds = query.deviceId ? [query.deviceId] : authorizedDevices !== undefined
        ? [...new Set(authorizedIds)] : await this.siteDeviceIds(scope);
      if (deviceIds.length > maxQuerySiteDevices) throw new Error('Invalid device health history query: site has more than 100 diagnostic devices; select one device');
      const records: Array<{ at: string; value: unknown }> = [];
      const dataset: DeviceHealthQueryDataset = {
        observations: [], buckets: [], events: [], failures: [], expectedIntervalMs: this.retention.expectedIntervalMs,
        authorizedDevices: (authorizedDevices || []).map(item => ({ ...scope, ...item })),
        supportedMetrics: [
          { name: 'wifi.rssi', unit: 'dBm', semantics: 'gauge' }, { name: 'memory.free_heap', unit: 'bytes', semantics: 'gauge' },
          { name: 'memory.fragmentation', unit: '%', semantics: 'gauge' }, { name: 'memory.largest_free_block', unit: 'bytes', semantics: 'gauge' },
          { name: 'uptime', unit: 'ms', semantics: 'counter' }, { name: 'wifi.disconnect_count', unit: 'count', semantics: 'counter' },
          { name: 'wifi.reconnect_count', unit: 'count', semantics: 'counter' }, { name: 'sensor.sample_count', unit: 'count', semantics: 'counter' },
          { name: 'sensor.read_failure_count', unit: 'count', semantics: 'counter' },
        ],
      };
      for (const deviceId of deviceIds) {
        const view = await this.getValue(diagnosticsKey(scope, deviceId));
        if (!view || view.tenantId !== scope.tenantId || view.siteId !== scope.siteId || view.deviceId !== deviceId) continue;
        const inRequestedRange = (at: string) => inRange(at, from, to);
        for (const snapshot of view.snapshots || []) {
          if (inRequestedRange(snapshot.collectedAt)) {
            const observation = observationFor(scope, deviceId, snapshot.sample.deviceId, snapshot);
            dataset.observations.push(observation);
          }
        }
        const summaryKind = query.granularity === 'daily' ? 'daily' : 'hourly';
        const summaryPrefix = healthKey(summaryKind, scope, deviceId);
        for (const { value } of await this.readPrefix(summaryPrefix)) {
          const bucket = value as DeviceHealthBucketSummary;
          if (bucket.tenantId === scope.tenantId && bucket.siteId === scope.siteId && bucket.deviceId === deviceId &&
              inRequestedRange(bucket.bucketStartAt)) {
            dataset.buckets.push(bucket);
            if (query.granularity === summaryKind) records.push({ at: bucket.bucketStartAt, value: bucket });
          }
        }
        for (const kind of ['event', 'failure'] as const) {
          const storedRows = await this.readPrefix(healthKey(kind, scope, deviceId));
          const projected = kind === 'event' ? (view.events || []).map(withEventProvenance) : view.collectionFailures || [];
          const byId = new Map<string, Record<string, unknown>>();
          for (const item of projected) byId.set(item.id, item as unknown as Record<string, unknown>);
          for (const row of storedRows) {
            if (row.value && typeof row.value === 'object' && 'id' in row.value) byId.set(String((row.value as { id: unknown }).id), row.value as Record<string, unknown>);
          }
          for (const item of byId.values()) {
            const physicalDeviceId = String(item.physicalDeviceId || view.current?.deviceId || '');
            if (item.tenantId && item.tenantId !== scope.tenantId || item.siteId && item.siteId !== scope.siteId ||
                item.deviceId && item.deviceId !== deviceId || (physicalDeviceId && !/^esp8266:[0-9a-f]{6}$/i.test(physicalDeviceId))) continue;
            if (kind === 'event') {
              const at = String(item.observedAt || '');
              if (!inRequestedRange(at)) continue;
              const eventRecord = { tenantId: scope.tenantId, siteId: scope.siteId, id: String(item.id), deviceId, physicalDeviceId, observedAt: at,
                kind: String(item.kind || 'unknown'), bootSessionId: String(item.bootSessionId || ''),
                confidence: item.confidence === 'possible' ? 'possible' as const : 'confirmed' as const,
                source: typeof item.source === 'string' ? item.source :
                  item.source && typeof item.source === 'object' ? 'http:GET:/api/v1/diagnostics' : null,
                observedAtBasis: item.observedAtBasis === 'server-detection-time' ? 'server-detection-time' as const : null,
                detectedAt: typeof item.detectedAt === 'string' ? item.detectedAt :
                  item.observedAtBasis === 'server-detection-time' ? at : null,
                inferredBootAt: (() => {
                  const inferred = item.inferredBootAt as { at?: unknown; basis?: unknown } | null | undefined;
                  return inferred && typeof inferred.at === 'string' && inferred.basis === 'collected-at-minus-reported-uptime'
                    ? inferred as NonNullable<DeviceHealthEventEvidence['inferredBootAt']> : null;
                })(),
                evidenceReferences: Array.isArray(item.evidenceReferences) ? item.evidenceReferences.filter(reference =>
                  reference && typeof reference === 'object' && reference.type === 'firmware-diagnostic-snapshot' &&
                  typeof reference.observedAt === 'string' && typeof reference.bootSessionId === 'string') as DeviceHealthEventEvidence['evidenceReferences'] : [],
                summary: String(item.summary || ''), explanation: String(item.explanation || '') };
              dataset.events.push(eventRecord);
              if (query.granularity === 'events') records.push({ at, value: {
                tenantId: scope.tenantId, siteId: scope.siteId, deviceId, physicalDeviceId, ...item,
              } });
            } else {
              const at = String(item.attemptedAt || '');
              if (!inRequestedRange(at)) continue;
              const failureRecord = { tenantId: scope.tenantId, siteId: scope.siteId, id: String(item.id), deviceId, physicalDeviceId, attemptedAt: at,
                reason: String(item.reason || 'unknown'), source: 'http:GET:/api/v1/diagnostics', requestDurationMs: null };
              dataset.failures.push(failureRecord);
              if (query.granularity === 'failures') records.push({ at, value: failureRecord });
            }
          }
        }
        if (query.granularity === 'raw') {
          for (const snapshot of view.snapshots || []) {
            if (inRequestedRange(snapshot.collectedAt)) records.push({ at: snapshot.collectedAt,
              value: { tenantId: scope.tenantId, siteId: scope.siteId, deviceId,
                physicalDeviceId: snapshot.sample.deviceId, ...snapshot } });
          }
        }
        if (dataset.observations.length + dataset.buckets.length + dataset.events.length + dataset.failures.length > 20_000) {
          throw new Error('Invalid device health history query: evidence exceeds the bounded analysis limit');
        }
      }
      records.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
      const analysis = deviceHealthQueryService.query(scope, {
        from: fromAt, to: toAt, timezone: query.timezone, granularity: query.granularity,
        deviceId: query.deviceId, metrics: query.metrics, limit, cursor: query.cursor,
      }, dataset);
      const analysisPageKeys = new Set(analysis.series.map(item => {
        if ('sampleId' in item) return `${item.observedAt}|${item.deviceId}|${item.sampleId}`;
        if ('bucketStartAt' in item) return `${item.bucketStartAt}|${item.deviceId}|${item.bucketStartAt}:${item.granularity}`;
        if ('attemptedAt' in item) return `${item.attemptedAt}|${item.deviceId}|${item.id}`;
        return `${item.observedAt}|${item.deviceId}|${item.id}`;
      }));
      const pagedRecords = records.filter(item => {
        const cursor = historyRecordCursor(query.granularity, item.value);
        return cursor !== null && analysisPageKeys.has(cursor);
      }).map(item => item.value);
      return {
        schemaVersion: 1,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        granularity: query.granularity,
        from: fromAt,
        to: toAt,
        records: pagedRecords,
        analysis,
      };
    });
  }

  private async stageObservation(
    scope: FirmwareDiagnosticScope,
    deviceId: string,
    physicalId: string,
    snapshot: FirmwareDiagnosticSnapshot,
    pending: Map<string, DeviceHealthBucketSummary>,
    operations: Array<{ type: 'put' | 'del'; key: string; value?: unknown }>,
    affectedDays: Set<string>,
  ): Promise<void> {
    const observation = observationFor(scope, deviceId, physicalId, snapshot);
    const marker = healthKey('marker', scope, deviceId, `hourly:${observation.observedAt}:${observation.sampleId}`);
    const bucketKey = healthKey('hourly', scope, deviceId, utcBucketKeyPart(observation.observedAt, 'hourly'));
    const markedInBatch = operations.some(operation => operation.key === marker);
    if (!markedInBatch && !(await this.readValue(marker))) {
      const previous = pending.get(bucketKey) || await this.readValue<DeviceHealthBucketSummary>(bucketKey);
      pending.set(bucketKey, applyDeviceHealthObservation(previous, observation, 'hourly', this.retention.expectedIntervalMs));
      operations.push({ type: 'put', key: marker, value: { sampleId: observation.sampleId,
        bucketKey, observedAt: observation.observedAt } });
    }
    affectedDays.add(utcBucketKeyPart(observation.observedAt, 'daily'));
  }

  private async stageLateDaily(
    scope: FirmwareDiagnosticScope,
    deviceId: string,
    physicalId: string,
    snapshot: FirmwareDiagnosticSnapshot,
    pending: Map<string, DeviceHealthBucketSummary>,
    operations: Array<{ type: 'put' | 'del'; key: string; value?: unknown }>,
  ): Promise<void> {
    const observation = observationFor(scope, deviceId, physicalId, snapshot);
    const marker = healthKey('marker', scope, deviceId,
      `late-daily:${observation.observedAt}:${observation.sampleId}`);
    if (operations.some(operation => operation.key === marker) || await this.readValue(marker)) return;
    const bucketKey = healthKey('daily', scope, deviceId, utcBucketKeyPart(observation.observedAt, 'daily'));
    const previous = pending.get(bucketKey) || await this.readValue<DeviceHealthBucketSummary>(bucketKey);
    pending.set(bucketKey, applyDeviceHealthObservation(previous, observation, 'daily', this.retention.expectedIntervalMs));
    operations.push({ type: 'put', key: marker, value: { sampleId: observation.sampleId,
      bucketKey, observedAt: observation.observedAt } });
  }

  private async readUtcDayHours(
    scope: FirmwareDiagnosticScope,
    deviceId: string,
    dayStartAt: string,
    pending: Map<string, DeviceHealthBucketSummary>,
  ): Promise<DeviceHealthBucketSummary[]> {
    const start = Date.parse(dayStartAt);
    const hours: DeviceHealthBucketSummary[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(start + hour * 3_600_000).toISOString();
      const key = healthKey('hourly', scope, deviceId, at);
      const item = pending.get(key) || await this.readValue<DeviceHealthBucketSummary>(key);
      if (item) hours.push(item);
    }
    return hours;
  }

  private async readValue<T>(key: string): Promise<T | null> {
    try { return await this.db.get(key) as T; } catch (error) { if (isNotFound(error)) return null; throw error; }
  }

  private async readPrefix(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const rows: Array<{ key: string; value: unknown }> = [];
    for await (const [key, value] of this.db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
      if (rows.length >= maxQueryRecordsPerPrefix) throw new Error('Invalid device health history query: stored series exceeds the bounded read limit');
      rows.push({ key, value });
    }
    return rows;
  }

  private async siteDeviceIds(scope: FirmwareDiagnosticScope): Promise<string[]> {
    const ids = new Set<string>();
    const indexPrefix = siteDeviceIndexPrefix(scope);
    for await (const [key] of this.db.iterator({ gte: indexPrefix, lte: `${indexPrefix}\xff` })) {
      ids.add(decodeURIComponent(String(key).slice(indexPrefix.length)));
      if (ids.size > maxQuerySiteDevices) throw new Error('Invalid device health history query: site has more than 100 diagnostic devices; select one device');
    }
    // Legacy V1 records are discoverable before the next scheduled collection
    // writes their site index; this read does not mutate or reassign them.
    const legacyPrefix = `firmware-diagnostics:${encodedPart(scope.tenantId)}:${encodedPart(scope.siteId)}:`;
    for await (const [key] of this.db.iterator({ gte: legacyPrefix, lte: `${legacyPrefix}\xff` })) {
      ids.add(decodeURIComponent(String(key).slice(legacyPrefix.length)));
      if (ids.size > maxQuerySiteDevices) throw new Error('Invalid device health history query: site has more than 100 diagnostic devices; select one device');
    }
    return [...ids];
  }

  private shouldSweep(lastSweep: string | undefined, now: string): boolean {
    return !lastSweep || Date.parse(now) - Date.parse(lastSweep) >= this.retention.retentionSweepIntervalMs;
  }

  private async retentionDeletes(scope: FirmwareDiagnosticScope, deviceId: string, now: string) {
    const instant = Date.parse(now);
    const policies: Array<[string, number, string]> = [
      ['hourly', this.retention.hourlySummaryDays, 'bucketStartAt'],
      ['daily', this.retention.dailySummaryDays, 'bucketStartAt'],
      ['event', this.retention.significantEventDays, 'observedAt'],
      ['failure', this.retention.communicationFailureDays, 'attemptedAt'],
    ];
    const deletes: Array<{ type: 'del'; key: string }> = [];
    for (const [kind, days, timestampField] of policies) {
      const prefix = healthKey(kind, scope, deviceId);
      for await (const [key, value] of this.db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
        const timestamp = value && typeof value === 'object' ? Date.parse(String((value as Record<string, unknown>)[timestampField] || '')) : NaN;
        if (Number.isFinite(timestamp) && timestamp < instant - days * 86_400_000) deletes.push({ type: 'del', key: String(key) });
      }
    }
    for (const [markerKind, days] of [['hourly', this.retention.hourlySummaryDays],
      ['late-daily', this.retention.dailySummaryDays]] as const) {
      const markerPrefix = healthKey('marker', scope, deviceId, `${markerKind}:`);
      const markerCutoff = new Date(instant - days * 86_400_000).toISOString();
      const throughCutoff = `${markerPrefix}${markerCutoff}\xff`;
      for await (const [key] of this.db.iterator({ gte: markerPrefix, lte: throughCutoff })) {
        deletes.push({ type: 'del', key: String(key) });
      }
    }
    return deletes;
  }

  private async getValue(key: string): Promise<StoredView | null> {
    try {
      const value: unknown = await this.db.get(key);
      if (!value || typeof value !== 'object' || (value as StoredView).schemaVersion !== 1) return null;
      const stored = value as StoredView;
      // Preserve pre-history records when an older V1 store is opened.
      return {
        ...stored,
        snapshots: stored.snapshots || (stored.current ? [{
          collectedAt: stored.sampledAt,
          deviceObservedAt: null,
          protocol: 'http' as const,
          method: 'GET' as const,
          path: '/api/v1/diagnostics' as const,
          identityVerifiedAt: stored.sampledAt,
          sample: stored.current,
        }] : []),
        lastAttemptAt: stored.lastAttemptAt || stored.sampledAt || '',
        lastSuccessfulContactAt: stored.lastSuccessfulContactAt || stored.sampledAt || null,
        collectionStatus: stored.collectionStatus || 'success',
        collectionFailures: stored.collectionFailures || [],
        events: stored.events || [],
        restartCount10m: stored.restartCount10m || 0,
        connectivity: stored.connectivity || 'unknown',
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'LEVEL_NOT_FOUND') return null;
      throw error;
    }
  }

  private async open(): Promise<void> {
    this.opened ??= this.db.open();
    await this.opened;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function stripSchema({ schemaVersion: _schemaVersion, ...view }: StoredView): FirmwareDiagnosticsView {
  return view;
}


