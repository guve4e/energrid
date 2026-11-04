import { createHash } from 'node:crypto'
import type { DeviceRegistryService } from '../../device-registry.service'
import type { TelemetryIngestService } from '../../../telemetry/telemetry-ingest.service'
import type { ApprovedMqttObservationRuntime } from '../../mqtt/approved-mqtt-observation.runtime'
import type { ApprovedMqttObservationResult } from '../../mqtt/approved-mqtt-observation.route'
import type { DeviceMqttAdapterResult, DeviceMqttMessage, DeviceMqttObservationAdmission } from '../../mqtt/device-mqtt-message-adapter'

/**
 * Shelly-specific MQTT observation admission and electrical history projection.
 * An MQTT identity is only a claim. The existing approved runtime must verify
 * a site-owned installation and exact per-field authority before history writes.
 * This handler never enrolls a device or authorizes control.
 */
export async function handleShellyMqttObservation(
  message: DeviceMqttMessage,
  result: DeviceMqttAdapterResult,
  registry: DeviceRegistryService,
  telemetry?: TelemetryIngestService,
  approvedObservationRuntime?: ApprovedMqttObservationRuntime,
): Promise<DeviceMqttAdapterResult & {
  persisted: Promise<void>
  observationAdmission: ApprovedMqttObservationResult
  observationAdmissions: DeviceMqttObservationAdmission[]
}> {
  const admissions: DeviceMqttObservationAdmission[] = [];
  const persistence: Promise<void>[] = [];
  for (const effect of result.effects) {
    if (effect.kind !== 'telemetry') continue;
    const payload = effect.payload as {
      target?: { identity?: { value?: string }; componentKey?: string };
      values?: Record<string, unknown>;
      measurements?: Record<string, unknown>;
      readings?: Array<Record<string, unknown>>;
    };
    const physicalId = payload.target?.identity?.value || '';
    const componentKey = payload.target?.componentKey || '';
    const deviceId = physicalId && componentKey ? `${physicalId}:${componentKey}` : undefined;
    const observedReading = (payload.readings || []).find(reading =>
      ['power', 'energy_import_total', 'energy_export_total'].includes(String(reading.metric)));
    const identityMaterial = observedReading?.timestampBasis === 'device-observed' &&
        typeof observedReading.observedAt === 'string'
      ? [message.topic, physicalId, componentKey, observedReading.observedAt,
        ...Object.entries(payload.values || {}).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${String(value)}`)]
          .join('\0')
      : [message.topic, message.payloadText].join('\0');
    const evidenceId = createHash('sha256').update(identityMaterial).digest('hex');
    // Shelly NotifyStatus also carries state and electrical metadata
    // (for example output, current and voltage). Those remain available
    // to the raw Bus/evidence path, but only canonical approved
    // measurements may enter deterministic observation ingress. Keep
    // invalid supported readings as null so they are rejected explicitly
    // instead of silently disappearing or becoming zero.
    const ingested = await approvedObservationRuntime?.ingestShellyMqttObservation({
      topic: message.topic,
      physicalId,
      componentKey,
      values: payload.measurements || {},
      evidenceId,
    });
    const accepted = ingested?.outcome === 'processed' && ingested.accepted === true;
    admissions.push({
      ...(deviceId ? { deviceId } : {}),
      outcome: accepted ? 'admitted' : 'rejected',
      ...(!accepted ? { reasonCode: ingested?.outcome === 'rejected'
        ? ingested.reasonCode
        : ingested?.outcome === 'processed' ? ingested.reason || 'observation_rejected'
        : 'shelly_observation_runtime_unavailable' } : {}),
    });
    if (!accepted || ingested?.outcome !== 'processed' || !ingested.scope || !deviceId) continue;

    const device = registry.getDevices(true).find(item =>
      item.id === deviceId && item.tenantId === ingested.scope.tenantId &&
      item.siteId === ingested.scope.siteId,
    );
    // Keep the existing electrical history projection, but only after
    // shared Core ingress accepted the specifically approved power field.
    const powerReadings = (payload.readings || []).filter(reading =>
      ['power', 'energy_import_total', 'energy_export_total'].includes(String(reading.metric)) &&
      reading.timestampBasis === 'device-observed' &&
      ingested?.outcome === 'processed' && Array.isArray(ingested.updatedKeys) &&
      ingested.updatedKeys.includes(String(reading.metric)),
    );
    if (powerReadings.length && telemetry) {
      persistence.push(telemetry.capture({
        deviceId,
        tenantId: ingested.scope.tenantId,
        siteId: ingested.scope.siteId,
        readings: powerReadings,
      }, device, 'shelly-mqtt'));
    }
  }
  return {
    reason: admissions.some(item => item.outcome === 'admitted')
      ? 'Shelly measurement passed approved Core observation ingress'
      : 'Shelly MQTT identity is evidence only; no authorized measurement binding matched',
    effects: [],
    persisted: Promise.all(persistence).then(() => undefined),
    observationAdmissions: admissions,
    physicalDiscoveries: result.physicalDiscoveries ?? [],
    observationAdmission: admissions.some(item => item.outcome === 'admitted')
      ? { outcome: 'admitted' }
      : { outcome: 'rejected', reasonCode: toApprovedObservationReasonCode(admissions[0]?.reasonCode) },
  };
}

function toApprovedObservationReasonCode(reason?: string): Extract<ApprovedMqttObservationResult, { outcome: 'rejected' }>['reasonCode'] {
  switch (reason) {
    case 'device_not_approved':
    case 'device_not_enrolled':
    case 'route_not_configured':
    case 'installation_missing_or_mismatched':
    case 'publisher_identity_mismatch':
    case 'invalid_sample':
    case 'observation_policy_rejected':
    case 'shelly_observation_runtime_unavailable':
      return reason;
    default:
      return 'observation_policy_rejected';
  }
}
