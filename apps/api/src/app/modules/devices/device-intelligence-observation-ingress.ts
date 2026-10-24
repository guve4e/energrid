import { Logger } from '@nestjs/common';
import type { DeviceRegistryService } from './device-registry.service';
import type { DeviceInstallationStore } from './device-installation.store';
import type { DeviceEnrollmentService } from './enrollment/device-enrollment.service';
import type {
  DeviceObservationStateStore,
} from './device-observation-state.store';
import type { DeviceObservationState } from '@energrid/domain-devices';
import { resolveInstallationObservationAuthority } from './device-observation-installation-authority';
import type { GenericMeasurementHistoryWriter, HistoryWriteResult } from '../telemetry/generic-measurements/generic-measurement-history-writer';

export interface TrustedObservationInput {
  scope: {
    tenantId: string;
    siteId: string;
  };
  deviceId: string;
  sourceId: string;
  selector: string;
  payload: unknown;
  evidenceId?: string;
}

export type ObservationIngressOutcome =
  | {
      outcome: 'rejected';
      reasonCode:
        | 'invalid_input'
        | 'device_not_approved'
        | 'device_not_enrolled'
        | 'installation_not_approved'
        | 'observation_authority_missing';
    }
  | {
      outcome: 'processed';
      accepted: boolean;
      stage: string;
      reason: string;
      updatedKeys: string[];
      rejectedFields: string[];
      state: DeviceObservationState | null;
      historyWrites?: HistoryWriteResult[];
    };

/**
 * Protocol-independent, deterministic Core observation ingress.
 *
 * Only trusted protocol adapters may invoke this class.
 * Do not expose it as an endpoint accepting arbitrary source claims.
 *
 * The adapter establishes evidence provenance.
 * The installation supplies field/source authority.
 * The durable observation engine performs acceptance.
 */
export class DeviceIntelligenceObservationIngress {
  private readonly logger = new Logger(DeviceIntelligenceObservationIngress.name);
  constructor(
    private readonly registry: Pick<
      DeviceRegistryService,
      'ensureInstallationsLoaded' | 'getDevices'
    >,
    private readonly installations: Pick<DeviceInstallationStore, 'get'>,
    private readonly enrollment: Pick<DeviceEnrollmentService, 'find'>,
    private readonly store: Pick<DeviceObservationStateStore, 'process'>,
    private readonly history?: Pick<GenericMeasurementHistoryWriter, 'persistAccepted'>,
  ) {}

  async ingest(
    input: TrustedObservationInput,
  ): Promise<ObservationIngressOutcome> {
    const { scope, deviceId, sourceId, selector } = input;

    if (
      !scope?.tenantId?.trim() ||
      !scope?.siteId?.trim() ||
      !deviceId?.trim() ||
      !sourceId?.trim() ||
      !selector?.trim()
    ) {
      return { outcome: 'rejected', reasonCode: 'invalid_input' };
    }

    await this.registry.ensureInstallationsLoaded();

    const device = this.registry.getDevices().find(candidate =>
      candidate.id === deviceId &&
      candidate.tenantId === scope.tenantId &&
      candidate.siteId === scope.siteId &&
      candidate.kind === 'physical' &&
      candidate.trustStatus === 'approved',
    );

    if (!device) {
      return { outcome: 'rejected', reasonCode: 'device_not_approved' };
    }

    const enrolled = await this.enrollment.find({
      ...scope,
      deviceId,
    });

    if (!enrolled || enrolled.status !== 'enrolled') {
      return { outcome: 'rejected', reasonCode: 'device_not_enrolled' };
    }

    const installation = await this.installations.get(
      scope.siteId,
      deviceId,
    );

    if (
      !installation ||
      installation.schemaVersion !== 1 ||
      installation.device.id !== deviceId ||
      installation.device.tenantId !== scope.tenantId ||
      installation.device.siteId !== scope.siteId ||
      installation.device.trustStatus !== 'approved'
    ) {
      return {
        outcome: 'rejected',
        reasonCode: 'installation_not_approved',
      };
    }

    const authority = resolveInstallationObservationAuthority(
      installation,
      sourceId,
      selector,
    );

    if (!authority) {
      return {
        outcome: 'rejected',
        reasonCode: 'observation_authority_missing',
      };
    }

    // The trusted Core receives the payload and assigns reception time.
    // Device-supplied timestamps are never trusted as reception time.
    const result = await this.store.process(scope, deviceId, {
      binding: authority.binding,
      policy: authority.policy,
      context: {
        selector,
        receivedAt: new Date().toISOString(),
        ...(input.evidenceId
          ? { evidenceId: input.evidenceId }
          : {}),
      },
      payload: input.payload,
    });

    let historyWrites: HistoryWriteResult[] | undefined;
    if (
      this.history &&
      result.state &&
      input.evidenceId &&
      (result.accepted || result.reason === 'duplicate_evidence')
    ) {
      const acceptedKeys = result.accepted
        ? result.updatedKeys
        : Object.entries(result.state.fields)
            .filter(([, field]) => field.sourceId === sourceId && field.evidenceId === input.evidenceId)
            .map(([key]) => key);
      const fields = acceptedKeys.flatMap(fieldName => {
        const field = result.state!.fields[fieldName];
        return field && field.sourceId === sourceId && field.evidenceId === input.evidenceId &&
          typeof field.value === 'number' && Number.isFinite(field.value)
          ? [{
              field: fieldName,
              value: field.value,
              observedAt: field.measuredAt ?? field.receivedAt,
              receivedAt: field.receivedAt,
            }]
          : [];
      });
      if (fields.length) {
        try {
          historyWrites = await this.history.persistAccepted({
            ...scope,
            deviceId,
            sourceId,
            selector,
            evidenceId: input.evidenceId,
            fields,
          });
        } catch (error) {
          this.logger.error(`History sink failed after accepted observation (device=${deviceId}).`);
          historyWrites = fields.map(({ field }) => ({ field, outcome: 'failed' }));
        }
      }
    }

    return {
      outcome: 'processed',
      accepted: result.accepted,
      stage: result.stage,
      reason: result.reason,
      updatedKeys: result.updatedKeys,
      rejectedFields: result.rejectedFields,
      state: result.state,
      ...(historyWrites ? { historyWrites } : {}),
    };
  }
}
