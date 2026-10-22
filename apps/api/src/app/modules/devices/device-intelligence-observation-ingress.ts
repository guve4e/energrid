import type { DeviceRegistryService } from './device-registry.service';
import type { DeviceInstallationStore } from './device-installation.store';
import type { DeviceEnrollmentService } from './enrollment/device-enrollment.service';
import type {
  DeviceObservationStateStore,
} from './device-observation-state.store';
import { resolveInstallationObservationAuthority } from './device-observation-installation-authority';

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
  constructor(
    private readonly registry: Pick<
      DeviceRegistryService,
      'ensureInstallationsLoaded' | 'getDevices'
    >,
    private readonly installations: Pick<DeviceInstallationStore, 'get'>,
    private readonly enrollment: Pick<DeviceEnrollmentService, 'find'>,
    private readonly store: Pick<DeviceObservationStateStore, 'process'>,
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

    return {
      outcome: 'processed',
      accepted: result.accepted,
      stage: result.stage,
      reason: result.reason,
      updatedKeys: result.updatedKeys,
      rejectedFields: result.rejectedFields,
    };
  }
}
