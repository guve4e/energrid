import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { CORE_MEASUREMENT_DEFINITIONS, type GenericMeasurementInput } from '@energrid/domain-telemetry';
import type { MeasurementHistoryPolicy } from '../telemetry.config';
import type {
  MeasurementHistoryAppendResult,
  PostgresGenericMeasurementRepository,
} from './postgres-generic-measurement.repository';

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
  | { field: string; outcome: 'disabled' | 'not_numeric_or_no_evidence' | 'policy_missing' | 'failed' };

/** Best-effort historical sink called only after trusted ingress accepts a field. */
export class GenericMeasurementHistoryWriter {
  private readonly logger = new Logger(GenericMeasurementHistoryWriter.name);

  constructor(
    private readonly repository: Pick<PostgresGenericMeasurementRepository, 'appendIfDue'> | null,
    private readonly enabled: boolean,
    private readonly policies: Readonly<Record<string, MeasurementHistoryPolicy>>,
  ) {}

  async persistAccepted(input: AcceptedObservationHistoryInput): Promise<HistoryWriteResult[]> {
    if (!this.enabled) return input.fields.map(({ field }) => ({ field, outcome: 'disabled' }));
    if (!this.repository || !input.evidenceId?.trim()) {
      return input.fields.map(({ field }) => ({ field, outcome: 'not_numeric_or_no_evidence' }));
    }

    const results: HistoryWriteResult[] = [];
    for (const observation of input.fields) {
      if (!Number.isFinite(observation.value)) {
        results.push({ field: observation.field, outcome: 'not_numeric_or_no_evidence' });
        continue;
      }
      const policy = this.policies[observation.field];
      const definition = CORE_MEASUREMENT_DEFINITIONS.find(item => item.metric === observation.field);
      if (!policy || !definition) {
        results.push({ field: observation.field, outcome: 'policy_missing' });
        this.logger.warn(`History skipped without metric policy (device=${input.deviceId}, metric=${observation.field}).`);
        continue;
      }
      try {
        const measurement: GenericMeasurementInput = {
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
        };
        const result = await this.repository.appendIfDue(measurement, policy);
        results.push({ field: observation.field, ...result });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
          : 'unknown';
        this.logger.error(`History write failed (device=${input.deviceId}, metric=${observation.field}, code=${code}).`);
        results.push({ field: observation.field, outcome: 'failed' });
      }
    }
    return results;
  }
}

function sampleIdentity(sourceId: string, selector: string, evidenceId: string, field: string): string {
  return createHash('sha256').update([sourceId, selector, evidenceId, field].join('\0')).digest('hex');
}
