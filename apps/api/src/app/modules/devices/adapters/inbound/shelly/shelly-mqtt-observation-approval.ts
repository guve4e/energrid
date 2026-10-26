import type { InstallationObservationAuthority } from '../../../device-installation.store';

export const SHELLY_MQTT_OBSERVATION_SOURCE = 'shelly-mqtt';

export function shellyMqttObservationApproval(deviceId: string): InstallationObservationAuthority {
  const identity = /^((?:shelly)[a-z0-9._-]{1,114}):((?:switch|em1)):(?:[0-9]|[12][0-9]|3[01])$/i.exec(deviceId);
  if (!identity) {
    throw new Error('Expected a Shelly physical component identity');
  }
  return {
    bindings: [{
      deviceId,
      sourceId: SHELLY_MQTT_OBSERVATION_SOURCE,
      selector: `${identity[1]}/events/rpc`,
      fields: { power: { rawKey: 'power', type: 'number' } },
    }],
    policy: {
      deviceId,
      allowedSourcesByField: { power: [SHELLY_MQTT_OBSERVATION_SOURCE] },
    },
  };
}

export function isShellyMqttObservationApproval(
  authority: InstallationObservationAuthority | undefined,
  deviceId: string,
): boolean {
  if (!authority) return false;
  return JSON.stringify(authority) === JSON.stringify(shellyMqttObservationApproval(deviceId));
}
