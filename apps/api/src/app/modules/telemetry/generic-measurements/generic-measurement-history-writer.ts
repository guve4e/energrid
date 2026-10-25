import { createHash } from 'node:crypto';
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CORE_MEASUREMENT_DEFINITIONS, type GenericMeasurementInput } from '@energrid/domain-telemetry';
import type { MeasurementHistoryPolicy } from '../telemetry.config';
import type {
  MeasurementHistoryAppendResult,
  PostgresGenericMeasurementRepository,
} from './postgres-generic-measurement.repository';
import type { GenericMeasurementHistoryOutbox, HistoryOutboxEntry } from './generic-measurement-history-outbox';

export interface AcceptedNumericObservation {
  field: string;
  value: number;
  observedAt: string;
  receivedAt: string;
}

export interface AcceptedObservationHistoryInput {
  tenantId: string;
  siteId: string;
  deviceId: string;
  sourceId: string;
  selector: string;
  evidenceId: string;
  fields: readonly AcceptedNumericObservation[];
}

export type HistoryWriteResult =
  | ({ field: string } & MeasurementHistoryAppendResult)
  | { field: string; outcome: 'disabled' | 'not_numeric_or_no_evidence' | 'policy_missing' | 'pending' | 'failed' };

export class HistoryOutboxUnavailableError extends Error {
  constructor() {
    super('Accepted measurement history could not be durably buffered');
    this.name = 'HistoryOutboxUnavailableError';
  }
}

/** Durable history sink called only after trusted ingress accepts a field. */
export class GenericMeasurementHistoryWriter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GenericMeasurementHistoryWriter.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<Map<string, MeasurementHistoryAppendResult>>;
  private closing = false;

  constructor(
    private readonly repository: Pick<PostgresGenericMeasurementRepository, 'ensureEnrollmentReference' | 'appendIfDue'> | null,
    private readonly enabled: boolean,
    private readonly policies: Readonly<Record<string, MeasurementHistoryPolicy>>,
    private readonly outbox: Pick<GenericMeasurementHistoryOutbox, 'open' | 'enqueue' | 'peek' | 'complete' | 'close'>,
    private readonly replayIntervalMs = 5000,
  ) {}

  async onModuleInit() {
    if (!this.enabled) return;
    // An enabled history sink must have durable storage before the API accepts samples.
    await this.outbox.open();
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.replayIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
    await this.outbox.close();
  }

  async persistAccepted(input: AcceptedObservationHistoryInput): Promise<HistoryWriteResult[]> {
    if (!this.enabled) return input.fields.map(({ field }) => ({ field, outcome: 'disabled' }));
    if (!this.repository || !input.evidenceId?.trim()) {
      return input.fields.map(({ field }) => ({ field, outcome: 'not_numeric_or_no_evidence' }));
    }

    const results = new Map<string, HistoryWriteResult>();
    const pending: { field: string; measurement: GenericMeasurementInput; policy: MeasurementHistoryPolicy }[] = [];
    for (const observation of input.fields) {
      if (!Number.isFinite(observation.value)) {
        results.set(observation.field, { field: observation.field, outcome: 'not_numeric_or_no_evidence' });
        continue;
      }
      const policy = this.policies[observation.field];
      const definition = CORE_MEASUREMENT_DEFINITIONS.find(item => item.metric === observation.field);
      if (!policy || !definition) {
        results.set(observation.field, { field: observation.field, outcome: 'policy_missing' });
        this.logger.warn(`History skipped without metric policy (device=${input.deviceId}, metric=${observation.field}).`);
        continue;
      }
      pending.push({
        field: observation.field,
        policy,
        measurement: {
          tenantId: input.tenantId,
          siteId: input.siteId,
          deviceId: input.deviceId,
          physicalDeviceId: null,
          componentId: 'device',
          channel: observation.field,
          metric: observation.field,
          unit: definition.unit,
          value: observation.value,
          quality: 'measured',
          source: input.sourceId,
          provenance: `approved:${input.sourceId}`,
          sampleId: sampleIdentity(input.sourceId, input.selector, input.evidenceId, observation.field),
          observedAt: observation.observedAt,
          receivedAt: observation.receivedAt,
        },
      });
    }

    if (pending.length) {
      try {
        await this.outbox.enqueue(pending.map(({ field, measurement, policy }) => ({ field, measurement, policy })));
      } catch {
        this.logger.error(`History outbox write failed (device=${input.deviceId}); accepted sample will be retried.`);
        throw new HistoryOutboxUnavailableError();
      }
      const completed = await this.runCycle();
      for (const item of pending) {
        const outcome = completed.get(item.measurement.sampleId);
        results.set(item.field, outcome
          ? { field: item.field, ...outcome }
          : { field: item.field, outcome: 'pending' });
      }
    }
    return input.fields.map(({ field }) => results.get(field) ?? { field, outcome: 'failed' });
  }

  runCycle(): Promise<Map<string, MeasurementHistoryAppendResult>> {
    if (!this.enabled || this.closing) return Promise.resolve(new Map());
    return (this.running ??= this.replay().finally(() => { this.running = undefined; }));
  }

  private async replay(): Promise<Map<string, MeasurementHistoryAppendResult>> {
    const completed = new Map<string, MeasurementHistoryAppendResult>();
    if (!this.repository) return completed;
    while (!this.closing) {
      let entry: HistoryOutboxEntry | undefined;
      try {
        entry = await this.outbox.peek();
      } catch {
        this.logger.error('History outbox read failed; pending samples remain on disk.');
        break;
      }
      if (!entry) break;
      try {
        const measurement = entry.measurement;
        await this.repository.ensureEnrollmentReference({
          tenantId: measurement.tenantId,
          siteId: measurement.siteId,
          deviceId: measurement.deviceId,
        });
        const outcome = await this.repository.appendIfDue(measurement, entry.policy);
        await this.outbox.complete(entry);
        completed.set(entry.sampleId, outcome);
      } catch (error) {
        const code = safeDatabaseErrorCode(error);
        this.logger.error(`History replay paused (device=${entry.measurement.deviceId}, metric=${entry.field}, code=${code}); pending samples remain on disk.`);
        break;
      }
    }
    return completed;
  }
}

function safeDatabaseErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
    : 'unknown';
}

function sampleIdentity(sourceId: string, selector: string, evidenceId: string, field: string): string {
  return createHash('sha256').update([sourceId, selector, evidenceId, field].join('\0')).digest('hex');
}
