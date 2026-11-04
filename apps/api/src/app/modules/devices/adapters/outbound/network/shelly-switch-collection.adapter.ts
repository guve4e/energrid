import type { RegisteredDevice } from '../../../device-registry.types'
import { parseShellySwitchStatus } from '../../inbound/shelly/shelly-switch-status'
import { readJsonResponse } from './read-bounded-json-response'

/** Shelly-specific eligibility; scheduling a read never authorizes that read. */
export function isShellySwitchCollectionCandidate(device: RegisteredDevice): boolean {
  return device.trustStatus === 'approved' && device.kind === 'physical' &&
    (device.adapter.driver === 'shelly-lan' || device.adapter.driver === 'shelly-discovered') &&
    /^shelly[a-z0-9._-]{1,114}:switch:(?:[0-9]|[12][0-9]|3[01])$/i.test(device.id)
}

export function shellySwitchStatusRpcUrl(ipAddress: string, channel: number): string {
  return `http://${ipAddress}/rpc/Switch.GetStatus?id=${channel}`
}

export interface VerifiedShellySwitchStatus {
  values: { on: boolean }
  observedAt: string
  statusUrl: string
}

/**
 * Read-only, bounded Shelly Gen2+ RPC. The caller must resolve an authorized
 * tenant/site/physical-device/component/endpoint route BEFORE calling this.
 * No registry writes, discovery, installation approval, or control occurs here.
 */
export async function readVerifiedShellySwitchStatus(
  target: { ipAddress: string; physicalId: string; component: string; channel: number },
  signal: AbortSignal,
): Promise<VerifiedShellySwitchStatus> {
  const identityResponse = await fetch(`http://${target.ipAddress}/rpc/Shelly.GetDeviceInfo`, {
    signal, redirect: 'manual', cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  })
  if (identityResponse.status !== 200) throw new Error(`identity_http_${identityResponse.status}`)
  const identityBody = await readJsonResponse(identityResponse, 4 * 1024)
  const identity = identityBody && typeof identityBody === 'object' && !Array.isArray(identityBody)
    ? identityBody as Record<string, unknown> : null
  if (String(identity?.id || '').toLowerCase() !== target.physicalId.toLowerCase() ||
      typeof identity?.gen !== 'number' || identity.gen < 2) {
    throw new Error('identity_mismatch')
  }

  const statusUrl = shellySwitchStatusRpcUrl(target.ipAddress, target.channel)
  const statusResponse = await fetch(statusUrl, {
    signal, redirect: 'manual', cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  })
  if (statusResponse.status !== 200) throw new Error(`status_http_${statusResponse.status}`)
  const observedAt = new Date().toISOString()
  const values = parseShellySwitchStatus(await readJsonResponse(statusResponse, 4 * 1024), target.component)
  if (!values) throw new Error('invalid_switch_status')
  return { values, observedAt, statusUrl }
}
