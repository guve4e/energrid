import type {
  ApprovedObservationBinding,
  ObservationAuthorityPolicy,
} from '@energrid/domain-devices';

import type { DeviceRegistryService } from '../device-registry.service';
import type { DeviceInstallationStore } from '../device-installation.store';
import type { ObservationScope } from '../device-observation-state.store';
import { DeviceObservationStateStore } from '../device-observation-state.store';
import type { DeviceMqttMessage } from './device-mqtt-message-adapter';
import type { DeviceEnrollmentService } from '../enrollment/device-enrollment.service';
import type { DeviceIntelligenceObservationIngress } from '../device-intelligence-observation-ingress';
import type { ResolvedObservationAuthority } from '../device-observation-installation-authority';
import { energridFirmwareSampleEvidenceId } from '../adapters/inbound/energrid/energrid-http-observation.adapter';

export interface ApprovedMqttObservationConfig {
  scope: ObservationScope;
  binding: ApprovedObservationBinding;
  policy: ObservationAuthorityPolicy;
  expectedDeviceIdentity?: string;
}

export type ApprovedMqttObservationResult =
  | { outcome: 'admitted' }
  | {
      outcome: 'rejected'
      reasonCode:
        | 'route_not_configured'
        | 'device_not_approved'
        | 'device_not_enrolled'
        | 'installation_missing_or_mismatched'
        | 'publisher_identity_mismatch'
        | 'invalid_sample'
        | 'observation_policy_rejected'
        | 'shelly_observation_runtime_unavailable'
    }

/**
 * An explicitly configured route for already-approved devices.
 *
 * Configurations must come from trusted application/installation
 * configuration, never from an incoming MQTT payload.
 *
 * This class does not authenticate the MQTT connection.
 */
export class ApprovedMqttObservationRoute {
  private readonly routes = new Map<string, ApprovedMqttObservationConfig>();

  constructor(
    private readonly registry: Pick<
      DeviceRegistryService,
      'getDevices'
      | 'projectApprovedObservation'
      | 'claimApprovedObservationFields'
      | 'restoreApprovedObservation'
    >,
    private readonly store: DeviceObservationStateStore,
    configs: readonly ApprovedMqttObservationConfig[],
    private readonly installations: Pick<DeviceInstallationStore, 'get'>,
    private readonly enrollment?: Pick<DeviceEnrollmentService, 'find'>,
    private readonly ingress?: Pick<DeviceIntelligenceObservationIngress, 'ingestConfiguredMqtt'>,
  ) {
    for (const config of configs) {
      const { binding, policy, scope } = config;

      if (
        !scope?.tenantId?.trim() ||
        !scope?.siteId?.trim() ||
        !binding?.deviceId?.trim() ||
        !binding?.sourceId?.trim() ||
        !binding?.selector?.trim() ||
        !policy ||
        policy.deviceId !== binding.deviceId ||
        binding.selector.includes('#') ||
        binding.selector.includes('+') ||
        !binding.fields ||
        Object.keys(binding.fields).length === 0
      ) {
        throw new Error('Invalid approved MQTT observation configuration');
      }

      if (this.routes.has(binding.selector)) {
        throw new Error('Duplicate approved MQTT observation topic');
      }

      this.routes.set(binding.selector, config);
    }
  }

  subscriptions(): string[] {
    return [...this.routes.keys()];
  }

  matches(topic: string): boolean {
    return this.routes.has(topic);
  }

  /**
   * Restore authorized fields from durable observation state.
   * A historical measurement does not establish connectivity.
   */
  async recover(): Promise<void> {
    for (const { scope, binding, policy } of this.routes.values()) {
      if (this.enrollment) {
        const enrollment = await this.enrollment.find({
          ...scope,
          deviceId: binding.deviceId,
        });
        if (!enrollment || enrollment.status !== 'enrolled') continue;
      }
      const approved = this.registry.getDevices(true).some(
        (device) =>
          device.id === binding.deviceId &&
          device.tenantId === scope.tenantId &&
          device.siteId === scope.siteId &&
          device.kind === 'physical' &&
          device.trustStatus === 'approved',
      );

      if (!approved) continue;

      const installation = await this.installations.get(
        scope.siteId,
        binding.deviceId,
      );

      if (
        !installation ||
        installation.schemaVersion !== 1 ||
        installation.device.id !== binding.deviceId ||
        installation.device.tenantId !== scope.tenantId ||
        installation.device.siteId !== scope.siteId ||
        installation.device.trustStatus !== 'approved'
      ) {
        continue;
      }

      const ownedFields = Object.keys(binding.fields).filter(
        (field) =>
          policy.allowedSourcesByField?.[field]?.includes(
            binding.sourceId,
          ),
      );

      if (!ownedFields.length) continue;

      this.registry.claimApprovedObservationFields(
        binding.deviceId,
        ownedFields,
      );

      const state = await this.store.getState(
        scope,
        binding.deviceId,
      );

      if (!state) continue;

      const fields = Object.entries(state.fields).filter(
        ([field, observation]) =>
          ownedFields.includes(field) &&
          observation.sourceId === binding.sourceId &&
          Number.isFinite(Date.parse(observation.receivedAt)),
      );

      if (!fields.length) continue;

      const values = Object.fromEntries(
        fields.map(([field, observation]) => [
          field,
          observation.value,
        ]),
      );

      const observedAt = fields
        .map(([, observation]) => observation.receivedAt)
        .reduce((latest, current) =>
          Date.parse(current) > Date.parse(latest)
            ? current
            : latest,
        );

      this.registry.restoreApprovedObservation({
        deviceId: binding.deviceId,
        values,
        observedAt,
      });
    }
  }

  async process(
    message: DeviceMqttMessage,
  ): Promise<ApprovedMqttObservationResult> {
    const config = this.routes.get(message.topic);
    if (!config) {
      return { outcome: 'rejected', reasonCode: 'route_not_configured' };
    }

    if (this.enrollment) {
      const enrollment = await this.enrollment.find({
        ...config.scope,
        deviceId: config.binding.deviceId,
      });
      if (!enrollment || enrollment.status !== 'enrolled') {
        return { outcome: 'rejected', reasonCode: 'device_not_enrolled' };
      }
    }

    const { scope, binding, policy } = config;

    // This is a second check, not an installation/approval operation.
    // The profile itself must have been explicitly provisioned.
    const device = this.registry.getDevices(true).find(
      (candidate) =>
        candidate.id === binding.deviceId &&
        candidate.tenantId === scope.tenantId &&
        candidate.siteId === scope.siteId &&
        candidate.kind === 'physical' &&
        candidate.trustStatus === 'approved',
    );

    if (!device) {
      // Do not mutate authoritative state or create a device
      // from a message with no approved installation.
      return { outcome: 'rejected', reasonCode: 'device_not_approved' };
    }

    // Registry state alone is not proof of approval.
    // Require an explicit, persisted installation.
    const installation = await this.installations.get(
      scope.siteId,
      binding.deviceId,
    );

    if (
      !installation ||
      installation.schemaVersion !== 1 ||
      installation.device.id !== binding.deviceId ||
      installation.device.tenantId !== scope.tenantId ||
      installation.device.siteId !== scope.siteId ||
      installation.device.trustStatus !== 'approved'
    ) {
      return {
        outcome: 'rejected',
        reasonCode: 'installation_missing_or_mismatched',
      };
    }

    if (config.expectedDeviceIdentity) {
      const parsed = parseExpectedDeviceSample(
        message.payload,
        config.expectedDeviceIdentity,
        (device as { metadata?: Record<string, unknown> }).metadata?.physicalId,
      );
      if (!parsed.ok) return { outcome: 'rejected', reasonCode: parsed.reasonCode };
      if (!this.ingress) return { outcome: 'rejected', reasonCode: 'observation_policy_rejected' };
      const sample = parsed.sample;
      const evidenceId = energridFirmwareSampleEvidenceId(config.expectedDeviceIdentity!, sample.sampleId);
      if (!evidenceId) return { outcome: 'rejected', reasonCode: 'invalid_sample' };
      const authority: ResolvedObservationAuthority = { binding, policy };
      const outcome = await this.ingress.ingestConfiguredMqtt({
        scope, deviceId: binding.deviceId, sourceId: binding.sourceId,
        selector: binding.selector, payload: sample.values, evidenceId,
      }, authority);
      if (outcome.outcome !== 'processed' ||
          (!outcome.accepted && outcome.reason !== 'duplicate_evidence')) {
        return { outcome: 'rejected', reasonCode: 'observation_policy_rejected' };
      }
      if (outcome.accepted && outcome.state) {
        const values = Object.fromEntries(Object.entries(outcome.state.fields).map(([key, field]) => [key, field.value]));
        this.registry.projectApprovedObservation({ deviceId: binding.deviceId, values, observedAt: new Date().toISOString() });
      }
      return { outcome: 'admitted' };
    }

    // Reception time is assigned by Energrid.
    // Publisher-supplied timestamp is NOT interpreted as wall time.
    const receivedAt = new Date().toISOString();

    const result = await this.store.process(
      scope,
      binding.deviceId,
      {
        binding,
        policy,
        context: {
          selector: message.topic,
          receivedAt,
        },
        payload: message.payload,
      },
    );

    if (!result.accepted || !result.state) {
      return {
        outcome: 'rejected',
        reasonCode: 'observation_policy_rejected',
      };
    }

    const values = Object.fromEntries(
      Object.entries(result.state.fields).map(([key, field]) => [
        key,
        field.value,
      ]),
    );

    // The durable state transition has completed.
    // Now project the accepted state into the existing registry.
    this.registry.projectApprovedObservation({
      deviceId: binding.deviceId,
      values,
      observedAt: receivedAt,
    });
    return { outcome: 'admitted' };
  }
}

function parseExpectedDeviceSample(
  payload: unknown,
  expectedIdentity: string,
  registeredPhysicalIdentity: unknown,
): { ok: true; sample: { values: { temperatureC: number; humidityPct: number }; sampleId: string } } | { ok: false; reasonCode: 'publisher_identity_mismatch' | 'invalid_sample' } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reasonCode: 'invalid_sample' };
  const root = payload as Record<string, unknown>;
  if (registeredPhysicalIdentity !== expectedIdentity || root.deviceId !== expectedIdentity) return { ok: false, reasonCode: 'publisher_identity_mismatch' };
  if (root.schemaVersion !== 1 || root.deviceId !== expectedIdentity || !Number.isSafeInteger(root.uptimeMs) || Number(root.uptimeMs) < 0 ||
      !Number.isSafeInteger(root.sampleIntervalMs) || Number(root.sampleIntervalMs) < 1) return { ok: false, reasonCode: 'invalid_sample' };
  const sensor = root.sensor;
  if (!sensor || typeof sensor !== 'object' || Array.isArray(sensor)) return { ok: false, reasonCode: 'invalid_sample' };
  const sample = sensor as Record<string, unknown>;
  if (sample.state !== 'ok' || !Number.isSafeInteger(sample.sampleCount) || Number(sample.sampleCount) < 1 ||
      !Number.isSafeInteger(sample.lastSampleUptimeMs) || Number(sample.lastSampleUptimeMs) < 0 ||
      !Number.isSafeInteger(sample.readingAgeMs) || Number(sample.readingAgeMs) < 0 ||
      Number(sample.readingAgeMs) > Math.min(15_000, Math.max(5_000, Number(root.sampleIntervalMs) * 3)) ||
      typeof root.sampleId !== 'string' || !energridFirmwareSampleEvidenceId(expectedIdentity, root.sampleId) ||
      root.sampleId.split(':')[1] !== String(sample.sampleCount) || root.sampleId.split(':')[2] !== String(sample.lastSampleUptimeMs) ||
      typeof sample.temperatureC !== 'number' || !Number.isFinite(sample.temperatureC) || sample.temperatureC < -40 || sample.temperatureC > 80 ||
      typeof sample.humidityPct !== 'number' || !Number.isFinite(sample.humidityPct) || sample.humidityPct < 0 || sample.humidityPct > 100) return { ok: false, reasonCode: 'invalid_sample' };
  return {
    ok: true,
    sample: { values: { temperatureC: sample.temperatureC, humidityPct: sample.humidityPct }, sampleId: root.sampleId as string },
  };
}
