import type { InstallationObservationAuthority } from '../../../device-installation.store';

export const SHELLY_MQTT_OBSERVATION_SOURCE = 'shelly-mqtt';

export const SHELLY_APPROVABLE_MEASUREMENT_FIELDS = ['power', 'energy_import_total', 'energy_export_total'] as const;
export type ShellyApprovableMeasurementField = typeof SHELLY_APPROVABLE_MEASUREMENT_FIELDS[number];

/** An exact reviewed topic selector. MQTT topics are routing claims, not device identity proof. */
export function isSafeShellyMqttEventTopic(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 192 &&
    /^(?:[A-Za-z0-9._@-]+\/)*[A-Za-z0-9._@-]+\/events\/rpc$/.test(value) &&
    !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function shellyMqttObservationApproval(
  deviceId: string,
  requestedFields: readonly ShellyApprovableMeasurementField[] = ['power'],
  selector?: string,
): InstallationObservationAuthority {
  const identity = /^((?:shelly)[a-z0-9._-]{1,114}):((?:switch|em1)):(?:[0-9]|[12][0-9]|3[01])$/i.exec(deviceId);
  if (!identity) {
    throw new Error('Expected a Shelly physical component identity');
  }
  const fields = [...new Set(requestedFields)].sort();
  if (!fields.length || fields.some(field => !SHELLY_APPROVABLE_MEASUREMENT_FIELDS.includes(field))) {
    throw new Error('Expected one or more supported Shelly measurement fields');
  }
  const topic = selector ?? `${identity[1]}/events/rpc`;
  if (!isSafeShellyMqttEventTopic(topic)) throw new Error('Expected an exact Shelly MQTT events/rpc topic without wildcards');
  const fieldBindings = Object.fromEntries(fields.map(field => [field, { rawKey: field, type: 'number' as const }]));
  const allowedSourcesByField = Object.fromEntries(fields.map(field => [field, [SHELLY_MQTT_OBSERVATION_SOURCE]]));
  return {
    bindings: [{
      deviceId,
      sourceId: SHELLY_MQTT_OBSERVATION_SOURCE,
      selector: topic,
      fields: fieldBindings,
    }],
    policy: {
      deviceId,
      allowedSourcesByField,
    },
  };
}

export function isShellyMqttObservationApproval(
  authority: InstallationObservationAuthority | undefined,
  deviceId: string,
): boolean {
  if (!authority) return false;
  if (!authority || authority.bindings.length !== 1) return false;
  const binding = authority.bindings[0];
  if (binding.deviceId !== deviceId || binding.sourceId !== SHELLY_MQTT_OBSERVATION_SOURCE ||
      !isSafeShellyMqttEventTopic(binding.selector) ||
      authority.policy.deviceId !== deviceId) return false;
  const fields = Object.keys(binding.fields).sort();
  if (!fields.length || fields.some(field => !SHELLY_APPROVABLE_MEASUREMENT_FIELDS.includes(field as ShellyApprovableMeasurementField))) return false;
  const expected = shellyMqttObservationApproval(deviceId, fields as ShellyApprovableMeasurementField[], binding.selector);
  return JSON.stringify(authority) === JSON.stringify(expected);
}
