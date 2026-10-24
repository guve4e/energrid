import type { InstallationObservationAuthority } from '../../../device-installation.store';
import {
  ENERGRID_HTTP_OBSERVATION_SOURCE,
  ENERGRID_HTTP_STATUS_SELECTOR,
} from './energrid-http-observation.adapter';

/** Explicit installation authority for only the two DHT22 status measurements. */
export function energridHttpObservationApproval(deviceId: string): InstallationObservationAuthority {
  if (!/^device:[^:]+:esp8266:[0-9a-f]{6}$/i.test(deviceId)) {
    throw new Error('Expected an enrolled Energrid ESP8266 device identity');
  }
  const fields = {
    temperature: { rawKey: 'temperatureC', type: 'number' as const },
    humidity: { rawKey: 'humidityPct', type: 'number' as const },
  };
  return {
    bindings: [{
      deviceId,
      sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE,
      selector: ENERGRID_HTTP_STATUS_SELECTOR,
      fields,
    }],
    policy: {
      deviceId,
      allowedSourcesByField: {
        temperature: [ENERGRID_HTTP_OBSERVATION_SOURCE],
        humidity: [ENERGRID_HTTP_OBSERVATION_SOURCE],
      },
    },
  };
}
