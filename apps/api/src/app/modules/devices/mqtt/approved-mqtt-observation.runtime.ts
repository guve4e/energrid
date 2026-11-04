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
import { configuredShellyMqttBroker, isSafeShellyMqttEventTopic, SHELLY_MQTT_OBSERVATION_SOURCE } from '../adapters/inbound/shelly/shelly-mqtt-observation-approval';

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
  readonly labRoute?: ApprovedMqttObservationRoute;

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
    const labRaw = process.env.LAB_MQTT_OBSERVATION_BINDINGS_JSON?.trim();
    if (labRaw && process.env.NODE_ENV === 'production') {
      throw new Error('LAB_MQTT_OBSERVATION_BINDINGS_JSON is disabled in production');
    }

    const httpEnabled = ['1', 'true', 'yes'].includes(
      String(process.env.HOME_HTTP_POLL_ENABLED).toLowerCase(),
    );
    const mqttEnabled = ['1', 'true', 'yes'].includes(
      String(process.env.HOME_MQTT_INGEST_ENABLED).toLowerCase(),
    );

    if (!raw && !labRaw && !httpEnabled && !mqttEnabled) {
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
    const labParsed: unknown = labRaw ? JSON.parse(labRaw) : [];

    if (!Array.isArray(parsed) || (raw && parsed.length === 0)) {
      throw new Error(
        'HOME_OBSERVATION_BINDINGS_JSON must be a nonempty array when configured',
      );
    }

    const configs = parsed as ApprovedMqttObservationConfig[];
    if (!Array.isArray(labParsed) || (labRaw && labParsed.length !== 1)) {
      throw new Error('LAB_MQTT_OBSERVATION_BINDINGS_JSON must contain exactly one explicitly scoped Virtual Device Lab route');
    }
    const labConfigs = labParsed as ApprovedMqttObservationConfig[];
    for (const config of labConfigs) {
      const expectedRegistration = /^device:device-lab-vlan:(esp8266:[0-9a-f]{6})$/i.exec(config.binding?.deviceId || '');
      const fields = Object.keys(config.binding?.fields || {}).sort();
      if (config.scope?.tenantId !== 'tenant-demo' || config.scope?.siteId !== 'site-device-lab' ||
        !expectedRegistration || expectedRegistration[1].toLowerCase() !== config.expectedDeviceIdentity?.toLowerCase() ||
        !config.binding.selector.startsWith('energrid/tenant-demo/site-device-lab/devices/') ||
        !config.binding.selector.endsWith(`/devices/${config.binding.deviceId}/telemetry`) ||
        !config.binding.selector.endsWith('/telemetry') || config.binding.selector.includes('+') ||
        config.binding.selector.includes('#') || fields.join(',') !== 'humidity,temperature' ||
        config.binding.fields.temperature?.rawKey !== 'temperatureC' || config.binding.fields.temperature?.type !== 'number' ||
        config.binding.fields.humidity?.rawKey !== 'humidityPct' || config.binding.fields.humidity?.type !== 'number' ||
        !config.policy.allowedSourcesByField?.temperature?.includes(config.binding.sourceId) ||
        !config.policy.allowedSourcesByField?.humidity?.includes(config.binding.sourceId)) {
        throw new Error('Lab MQTT route must be an exact tenant-demo/site-device-lab telemetry binding with a verified ESP8266 identity');
      }
    }
    this.configs.push(...configs, ...labConfigs);

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
    if (labConfigs.length) {
      this.labRoute = new ApprovedMqttObservationRoute(
        registry, this.store!, labConfigs, installations, enrollment,
        this.ingress,
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
        this.registry.projectApprovedObservation({ deviceId: input.deviceId, scope: input.scope, values: fields, observedAt });
      }
    }
    return result;
  }

  /**
   * Shelly's ordinary MQTT topic is only admitted for an already enrolled,
   * independently LAN-verified component with a persisted per-field approval.
   * MQTT identity claims never create devices or supply their own site scope.
   */
  async ingestShellyMqttObservation(input: {
    topic: string;
    physicalId: string;
    componentKey: string;
    values: Record<string, unknown>;
    evidenceId: string;
  }) {
    const rejected = (reasonCode: string) => ({
      outcome: 'rejected' as const,
      reasonCode,
      deviceId: `${input.physicalId}:${input.componentKey}`,
    });
    const supportedFields = ['power', 'energy_import_total', 'energy_export_total'];
    if (!/^shelly[a-z0-9._-]{1,114}$/i.test(input.physicalId) ||
        !/^(?:switch|em1):(?:[0-9]|[12][0-9]|3[01])$/.test(input.componentKey) ||
        !isSafeShellyMqttEventTopic(input.topic) ||
        !input.evidenceId || input.evidenceId.length > 128 ||
        !input.values || typeof input.values !== 'object' || Array.isArray(input.values) ||
        !Object.keys(input.values).length || Object.keys(input.values).some(key => !supportedFields.includes(key))) {
      return rejected('shelly_observation_contract_invalid');
    }
    if (Object.entries(input.values).some(([key, value]) => typeof value !== 'number' ||
        !Number.isFinite(value) || (key !== 'power' && value < 0))) {
      return rejected('shelly_observation_measurement_invalid');
    }
    const deviceId = `${input.physicalId}:${input.componentKey}`;
    await this.registry.ensureInstallationsLoaded();
    const matchingDevices = this.registry.getDevices(true).filter(candidate => {
      const directRpcVerified = candidate.metadata?.identityEvidenceSource === 'verified_shelly_http_rpc' &&
        candidate.metadata?.componentEvidenceSource === 'verified_shelly_component_status_rpc';
      const siteLocalRpcVerified = candidate.metadata?.identityEvidenceSource === 'verified_site_local_shelly_rpc' &&
        candidate.metadata?.componentEvidenceSource === 'verified_site_local_shelly_rpc' &&
        typeof candidate.metadata?.siteLocalObserverId === 'string' && !!candidate.metadata.siteLocalObserverId;
      return candidate.id === deviceId && candidate.kind === 'physical' &&
      candidate.trustStatus === 'approved' &&
      candidate.metadata?.physicalId === input.physicalId &&
      candidate.metadata?.component === input.componentKey &&
      (directRpcVerified || siteLocalRpcVerified) &&
      candidate.metadata?.shellyMqttObservationApprovalRequired === true &&
      Object.keys(input.values).every(field => String(candidate.metadata?.verifiedMeasurementFields || '')
        .split(',').includes(field))
    });
    if (matchingDevices.length !== 1) return rejected(matchingDevices.length
      ? 'shelly_observation_identity_ambiguous'
      : 'shelly_lan_verified_enrollment_missing');
    const device = matchingDevices[0];
    const scope = { tenantId: device.tenantId, siteId: device.siteId };
    if (!this.ingress) return rejected('observation_authority_missing');
    const installation = await this.installations.get(scope, deviceId);
    if (installation?.observationAuthority?.broker !== configuredShellyMqttBroker()) {
      return rejected('observation_authority_missing');
    }
    const authorizedFields = installation?.observationAuthority?.bindings.find(binding =>
      binding.deviceId === deviceId && binding.sourceId === SHELLY_MQTT_OBSERVATION_SOURCE &&
      binding.selector === input.topic)?.fields || {};
    const approvedPayload = Object.fromEntries(Object.entries(input.values)
      .filter(([field]) => Object.hasOwn(authorizedFields, field)));
    if (!Object.keys(approvedPayload).length) return rejected('observation_authority_missing');
    const result = await this.ingress.ingest({
      scope,
      deviceId,
      sourceId: SHELLY_MQTT_OBSERVATION_SOURCE,
      selector: input.topic,
      payload: approvedPayload,
      evidenceId: input.evidenceId,
    });
    if (result.outcome === 'processed' && result.accepted && result.state) {
      const fields = Object.fromEntries(Object.entries(result.state.fields)
        .filter(([, field]) => field.sourceId === SHELLY_MQTT_OBSERVATION_SOURCE)
        .map(([name, field]) => [name, field.value]));
      const observedAt = Object.values(result.state.fields)
        .filter(field => field.sourceId === SHELLY_MQTT_OBSERVATION_SOURCE)
        .map(field => field.measuredAt ?? field.receivedAt)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      if (Object.keys(fields).length && observedAt) {
        this.registry.projectApprovedObservation({ deviceId, scope, values: fields, observedAt });
      }
    }
    return { ...result, deviceId, scope };
  }

  async recover(): Promise<void> {
    if (!this.route && !this.labRoute) return;

    await this.registry.ensureInstallationsLoaded();
    await this.route?.recover();
    await this.labRoute?.recover();
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
    const installation = await this.installations.get(scope, deviceId);
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

  /**
   * Read-only inspection of persisted field/source authority. The resolver is
   * the same one used by trusted ingress; this method never grants authority.
   * These records do NOT prove a subscriber/poller is running, that a broker is
   * connected, or that a network route is reachable.
   */
  async inspectPersistedObservationAuthority(
    scope: { tenantId: string; siteId: string },
    deviceId: string,
  ): Promise<{
    status: 'device_not_approved' | 'device_not_enrolled' | 'installation_not_approved' | 'installation_approved';
    sources: Array<{ sourceId: string; selector: string; fields: string[] }>;
  }> {
    const empty = (status: 'device_not_approved' | 'device_not_enrolled' | 'installation_not_approved') =>
      ({ status, sources: [] });

    await this.registry.ensureInstallationsLoaded();
    const matching = this.registry.getDevices(true).filter(candidate =>
      candidate.id === deviceId && candidate.tenantId === scope.tenantId &&
      candidate.siteId === scope.siteId && candidate.kind === 'physical' &&
      candidate.trustStatus === 'approved');
    if (matching.length !== 1) return empty('device_not_approved');

    const enrolled = await this.enrollment.find({ ...scope, deviceId });
    if (!enrolled || enrolled.status !== 'enrolled') return empty('device_not_enrolled');

    const installation = await this.installations.get(scope, deviceId);
    if (!installation || installation.schemaVersion !== 1 ||
      installation.device.id !== deviceId ||
      installation.device.tenantId !== scope.tenantId ||
      installation.device.siteId !== scope.siteId ||
      installation.device.trustStatus !== 'approved') {
      return empty('installation_not_approved');
    }

    const sources = (installation.observationAuthority?.bindings ?? [])
      .flatMap(binding => {
        const authority = resolveInstallationObservationAuthority(
          installation, binding.sourceId, binding.selector,
        );
        return authority ? [{
          sourceId: authority.binding.sourceId,
          selector: authority.binding.selector,
          fields: Object.keys(authority.binding.fields).sort(),
        }] : [];
      })
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.selector.localeCompare(b.selector));
    return { status: 'installation_approved', sources };
  }

  async onModuleDestroy(): Promise<void> {
    await this.store?.close();
  }
}
