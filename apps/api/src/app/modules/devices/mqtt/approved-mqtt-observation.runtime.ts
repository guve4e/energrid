import {
  Injectable,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';

import { DeviceRegistryService } from '../device-registry.service';
import { DeviceInstallationStore } from '../device-installation.store';
import { DeviceObservationStateStore } from '../device-observation-state.store';

import {
  ApprovedMqttObservationRoute,
  type ApprovedMqttObservationConfig,
} from './approved-mqtt-observation.route';
import { Inject } from '@nestjs/common';
import { DEVICE_ENROLLMENT_SERVICE } from '../enrollment/device-enrollment.module';
import type { DeviceEnrollmentService } from '../enrollment/device-enrollment.service';
import type { DeviceObservationState } from '@energrid/domain-devices';
import { DeviceIntelligenceObservationIngress, type TrustedObservationInput } from '../device-intelligence-observation-ingress';
import { GenericMeasurementHistoryWriter } from '../../telemetry/generic-measurements/generic-measurement-history-writer';
import { ENERGRID_HTTP_OBSERVATION_SOURCE, ENERGRID_HTTP_STATUS_SELECTOR } from '../adapters/inbound/energrid/energrid-http-observation.adapter';
import { resolveInstallationObservationAuthority } from '../device-observation-installation-authority';

/**
 * Runtime owner of explicitly configured MQTT observation profiles.
 *
 * Disabled by default.
 *
 * No device is created, discovered, or approved by this service.
 */
@Injectable()
export class ApprovedMqttObservationRuntime
  implements OnModuleDestroy
{
  readonly route?: ApprovedMqttObservationRoute;

  private readonly store?: DeviceObservationStateStore;
  private readonly ingress?: DeviceIntelligenceObservationIngress;
  private readonly configs: ApprovedMqttObservationConfig[] = [];

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly installations: DeviceInstallationStore,
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment: DeviceEnrollmentService,
    @Optional()
    private readonly historyWriter?: GenericMeasurementHistoryWriter,
  ) {
    const raw = process.env.HOME_OBSERVATION_BINDINGS_JSON?.trim();

    const httpEnabled = ['1', 'true', 'yes'].includes(
      String(process.env.HOME_HTTP_POLL_ENABLED).toLowerCase(),
    );

    if (!raw && !httpEnabled) {
      return;
    }

    const directory =
      process.env.HOME_OBSERVATION_STORE_DIRECTORY?.trim();

    if (!directory) {
      throw new Error(
        'HOME_OBSERVATION_STORE_DIRECTORY is required when ' +
        'HTTP or MQTT observation ingestion is enabled',
      );
    }

    const parsed: unknown = raw ? JSON.parse(raw) : [];

    if (!Array.isArray(parsed) || (raw && parsed.length === 0)) {
      throw new Error(
        'HOME_OBSERVATION_BINDINGS_JSON must be a nonempty array when configured',
      );
    }

    const configs = parsed as ApprovedMqttObservationConfig[];
    this.configs.push(...configs);

    this.store = new DeviceObservationStateStore(directory);

    this.ingress = new DeviceIntelligenceObservationIngress(
      registry,
      installations,
      enrollment,
      this.store,
      this.historyWriter,
    );
    if (configs.length) {
      this.route = new ApprovedMqttObservationRoute(
        registry,
        this.store,
        configs,
        installations,
        enrollment,
      );
    }
  }

  async sourceSampleEvidenceId(
    scope: { tenantId: string; siteId: string },
    deviceId: string,
    sourceId: string,
    sample: { uptimeMs: number; sampleCount: number; lastSampleUptimeMs: number },
  ): Promise<string | null> {
    if (!this.store) return null;
    return this.store.sourceSampleEvidenceId(scope, deviceId, sourceId, sample);
  }

  async ingestHttpObservation(input: TrustedObservationInput) {
    if (!this.ingress) {
      return { outcome: 'rejected' as const, reasonCode: 'observation_authority_missing' as const };
    }
    const result = await this.ingress.ingest(input);
    if (result.outcome === 'processed' && result.state) {
      const selected = Object.entries(result.state.fields).filter(([, field]) => field.sourceId === input.sourceId);
      if (selected.length) {
        const fields = Object.fromEntries(selected.map(([key, item]) => [key, item.value]));
        const observedAt = selected.map(([, field]) => field.receivedAt)
          .reduce((latest, current) => Date.parse(current) > Date.parse(latest) ? current : latest);
        this.registry.projectApprovedObservation({ deviceId: input.deviceId, values: fields, observedAt });
      }
    }
    return result;
  }

  async recover(): Promise<void> {
    if (!this.route) return;

    await this.registry.ensureInstallationsLoaded();
    await this.route.recover();
  }

  /** Read only persisted fields covered by an active, approved MQTT binding. */
  async getAuthorizedObservation(scope: { tenantId: string; siteId: string }, deviceId: string): Promise<DeviceObservationState | null> {
    const config = this.configs.find(item => item.binding.deviceId === deviceId &&
      item.scope.tenantId === scope.tenantId && item.scope.siteId === scope.siteId);
    if (!this.store) return null;
    const device = this.registry.getDevices().find(item =>
      item.id === deviceId && item.tenantId === scope.tenantId &&
      item.siteId === scope.siteId && item.kind === 'physical' &&
      item.trustStatus === 'approved');
    if (!device) return null;
    if (this.enrollment) {
      const enrollment = await this.enrollment.find({ ...scope, deviceId });
      if (!enrollment || enrollment.status !== 'enrolled') return null;
    }
    const installation = await this.installations.get(scope.siteId, deviceId);
    if (!installation || installation.schemaVersion !== 1 ||
      installation.device.id !== deviceId || installation.device.tenantId !== scope.tenantId ||
      installation.device.siteId !== scope.siteId || installation.device.trustStatus !== 'approved') return null;

    const state = await this.store.getState(scope, deviceId);
    if (!state) return null;
    const allowedFields = new Set<string>();
    if (config) {
      for (const field of Object.keys(config.binding.fields)) {
        if (config.policy.allowedSourcesByField?.[field]?.includes(config.binding.sourceId)) {
          allowedFields.add(`${config.binding.sourceId}:${field}`);
        }
      }
    }

    // HTTP observations are authorized by the persisted installation binding.
    // This keeps the Core/LevelDB read path aligned with the ingress authority
    // even when MQTT profiles are not configured for the device.
    const httpAuthority = resolveInstallationObservationAuthority(
      installation, ENERGRID_HTTP_OBSERVATION_SOURCE, ENERGRID_HTTP_STATUS_SELECTOR,
    );
    if (httpAuthority) {
      for (const field of Object.keys(httpAuthority.binding.fields)) {
        allowedFields.add(`${ENERGRID_HTTP_OBSERVATION_SOURCE}:${field}`);
      }
    }
    const fields = Object.fromEntries(Object.entries(state.fields).filter(([field, observation]) =>
      allowedFields.has(`${observation.sourceId}:${field}`)));
    return Object.keys(fields).length ? { ...state, fields } : null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.store?.close();
  }
}
