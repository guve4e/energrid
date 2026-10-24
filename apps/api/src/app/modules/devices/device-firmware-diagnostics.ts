import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
}

export interface FirmwareDiagnosticsView {
  deviceId: string;
  tenantId: string;
  siteId: string;
  sampledAt: string;
  current: FirmwareDiagnosticSample;
  events: FirmwareHealthEvent[];
  restartCount10m: number;
  connectivity: 'connected' | 'disconnected';
}

/** Accept only the bounded V1 firmware contract and the expected physical identity. */
export function parseFirmwareDiagnosticSample(value: unknown, expectedDeviceId: string): FirmwareDiagnosticSample | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1 || root.deviceId !== expectedDeviceId ||
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
    deviceId: expectedDeviceId,
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
}

export const FIRMWARE_DIAGNOSTICS_STORE_DIRECTORY = Symbol('FIRMWARE_DIAGNOSTICS_STORE_DIRECTORY');

const eventLimit = 100;
const restartWindowMs = 10 * 60_000;

function diagnosticsKey(scope: FirmwareDiagnosticScope, deviceId: string): string {
  if (!scope.tenantId.trim() || !scope.siteId.trim() || !deviceId.trim()) {
    throw new Error('Tenant, site and stable device identity are required for firmware diagnostics');
  }
  return `firmware-diagnostics:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.siteId)}:${encodeURIComponent(deviceId)}`;
}

function eventId(kind: FirmwareHealthEventKind, bootSessionId: string): string {
  return createHash('sha256').update(`${kind}\0${bootSessionId}`).digest('hex').slice(0, 24);
}

function event(
  kind: FirmwareHealthEventKind,
  sample: FirmwareDiagnosticSample,
  observedAt: string,
  summary: string,
  explanation: string,
  confidence: FirmwareHealthEvent['confidence'] = 'confirmed',
): FirmwareHealthEvent {
  return {
    id: eventId(kind, sample.bootSessionId),
    kind,
    observedAt,
    bootSessionId: sample.bootSessionId,
    confidence,
    summary,
    explanation,
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

  if (previous && previous.current.bootSessionId !== current.bootSessionId) {
    created.push(event('reboot-detected', current, observedAt,
      'A new firmware boot session was detected.',
      'The device-reported boot session changed since the previous verified diagnostics poll.'));
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

@Injectable()
export class DeviceFirmwareDiagnosticsService implements OnModuleDestroy {
  private readonly db: ClassicLevel<string, unknown>;
  private tail: Promise<void> = Promise.resolve();
  private opened?: Promise<void>;

  constructor(
    @Optional() @Inject(FIRMWARE_DIAGNOSTICS_STORE_DIRECTORY) directory?: string,
  ) {
    this.db = new ClassicLevel(directory?.trim() || process.env.HOME_FIRMWARE_DIAGNOSTICS_DIRECTORY?.trim() ||
      join(homedir(), '.energrid', 'device-firmware-diagnostics'), { valueEncoding: 'json' });
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
      const events = [...(previousView?.events || []), ...newEvents]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
        .slice(-eventLimit);
      const restartCount10m = events.filter(item => item.kind === 'reboot-detected' &&
        Date.parse(observedAt) - Date.parse(item.observedAt) >= 0 &&
        Date.parse(observedAt) - Date.parse(item.observedAt) <= restartWindowMs).length;
      const view: StoredView = {
        schemaVersion: 1,
        deviceId,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        sampledAt: observedAt,
        current: sample,
        events,
        restartCount10m,
        connectivity: sample.wifi.connected ? 'connected' : 'disconnected',
      };
      await this.db.put(key, view);
      return stripSchema(view);
    });
  }

  async get(scope: FirmwareDiagnosticScope, deviceId: string): Promise<FirmwareDiagnosticsView | null> {
    return this.serialize(async () => {
      await this.open();
      const record = await this.getValue(diagnosticsKey(scope, deviceId));
      if (!record || record.tenantId !== scope.tenantId || record.siteId !== scope.siteId || record.deviceId !== deviceId) return null;
      return stripSchema(record);
    });
  }

  private async getValue(key: string): Promise<StoredView | null> {
    try {
      const value: unknown = await this.db.get(key);
      return value && typeof value === 'object' && (value as StoredView).schemaVersion === 1
        ? value as StoredView : null;
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


