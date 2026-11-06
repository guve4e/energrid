import { isIP } from 'node:net'
import type { RegisteredDevice } from '../../../device-registry.types'
import { readJsonResponse } from './read-bounded-json-response'

/** Eligibility only, never proof of observer reachability or measurement authority. */
export function isShellyEm1CollectionCandidate(device: RegisteredDevice): boolean {
  const physicalId = String(device.metadata?.physicalId || '')
  const component = String(device.metadata?.component || '')
  const channel = device.metadata?.channel
  return device.trustStatus === 'approved' && device.kind === 'physical' &&
    (device.adapter.driver === 'shelly-lan' || device.adapter.driver === 'shelly-discovered') &&
    /^shelly[a-z0-9._-]{1,114}$/i.test(physicalId) &&
    Number.isInteger(channel) && typeof channel === 'number' && channel >= 0 && channel <= 31 &&
    component === `em1:${channel}` && device.id === `${physicalId}:${component}`
}

export function shellyEm1StatusRpcUrl(ipAddress: string, channel: number): string {
  return `http://${ipAddress}/rpc/EM1.GetStatus?id=${channel}`
}

export interface VerifiedShellyEm1Status {
  values: { power: number }
  observedAt: string
  statusUrl: string
}

/**
 * Manufacturer-specific, read-only Shelly Gen2+ EM1 RPC adapter.
 * The caller MUST independently authorize tenant/site installation, active
 * endpoint, observation source/field and observer network scope before calling.
 * This adapter grants no authority and writes no Core or registry state.
 */
export async function readVerifiedShellyEm1Status(
  target: { ipAddress: string; physicalId: string; component: string; channel: number },
  signal: AbortSignal,
): Promise<VerifiedShellyEm1Status> {
  if (isIP(target.ipAddress) !== 4 || !/^shelly[a-z0-9._-]{1,114}$/i.test(target.physicalId) ||
      !Number.isInteger(target.channel) || target.channel < 0 || target.channel > 31 ||
      target.component !== `em1:${target.channel}`) throw new Error('invalid_em1_target')

  const identityResponse = await fetch(`http://${target.ipAddress}/rpc/Shelly.GetDeviceInfo`, {
    signal, redirect: 'manual', cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  })
  if (identityResponse.status !== 200) throw new Error(`identity_http_${identityResponse.status}`)
  const identityBody = await readJsonResponse(identityResponse, 4 * 1024)
  const identity = isPlainObject(identityBody) ? identityBody : null
  if (String(identity?.id || '').toLowerCase() !== target.physicalId.toLowerCase() ||
      typeof identity?.gen !== 'number' || identity.gen < 2) throw new Error('identity_mismatch')

  const statusUrl = shellyEm1StatusRpcUrl(target.ipAddress, target.channel)
  const statusResponse = await fetch(statusUrl, {
    signal, redirect: 'manual', cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  })
  if (statusResponse.status !== 200) throw new Error(`status_http_${statusResponse.status}`)
  const payload = await readJsonResponse(statusResponse, 4 * 1024)
  const status = isPlainObject(payload) ? payload : null
  if (status?.id !== target.channel || typeof status.act_power !== 'number' ||
      !Number.isFinite(status.act_power)) throw new Error('invalid_em1_status')
  return { values: { power: status.act_power }, observedAt: new Date().toISOString(), statusUrl }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
