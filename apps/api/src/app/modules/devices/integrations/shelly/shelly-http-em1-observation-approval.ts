import type { InstallationObservationAuthority } from '../../device-installation.store'

/** This authority is an EM1 power reading, not a switch command or MQTT approval. */
export const SHELLY_HTTP_EM1_SOURCE = 'shelly-http-em1'

export function shellyHttpEm1Approval(deviceId: string): InstallationObservationAuthority {
  const match = /^(shelly[a-z0-9._-]{1,114}):em1:(0|[1-9]|[12][0-9]|3[01])$/i.exec(deviceId)
  if (!match) throw new Error('Expected an enrolled Shelly EM1 component')
  const selector = `EM1.GetStatus?id=${match[2]}`
  return {
    bindings: [{
      deviceId, sourceId: SHELLY_HTTP_EM1_SOURCE, selector,
      // The Shelly adapter already normalizes act_power to canonical power.
      fields: { power: { rawKey: 'power', type: 'number' } },
    }],
    policy: { deviceId, allowedSourcesByField: { power: [SHELLY_HTTP_EM1_SOURCE] } },
  }
}

export function isShellyHttpEm1Approval(
  authority: InstallationObservationAuthority | undefined, deviceId: string,
): boolean {
  return !!authority && JSON.stringify(authority) === JSON.stringify(shellyHttpEm1Approval(deviceId))
}
