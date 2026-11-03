import { parseShellySwitchStatus } from './adapters/inbound/shelly/shelly-switch-status'
import { readOnlyShellyRpcDeviceInfoFromBody } from './adapters/inbound/shelly/read-only-shelly-rpc'
import type { SiteLocalShellyRpcResult } from './adapters/outbound/network/site-local-shelly-control.adapter'

interface ExpectedSiteLocalShellyCommand {
  physicalId: string
  component: string
  expectedComponentKeys: string[]
  requestedOn: boolean
}

interface VerifiedSiteLocalShellyReadback {
  on: boolean
  observedAt: string
  confirmed: boolean
}

/** Pure validation of RPC evidence; this does not authorize or execute a command. */
export function verifySiteLocalShellyCommandReadback(
  result: SiteLocalShellyRpcResult,
  expected: ExpectedSiteLocalShellyCommand,
  nowMs = Date.now(),
): VerifiedSiteLocalShellyReadback | null {
  const identityBefore = readOnlyShellyRpcDeviceInfoFromBody(result.identityBefore, 'GET /rpc/Shelly.GetDeviceInfo')
  const identityAfter = readOnlyShellyRpcDeviceInfoFromBody(result.identityAfter, 'GET /rpc/Shelly.GetDeviceInfo')
  const statusBefore = parseShellySwitchStatus(result.statusBefore, expected.component)
  const statusAfter = parseShellySwitchStatus(result.statusAfter, expected.component)
  const expectedKeys = [...expected.expectedComponentKeys].sort()
  const componentMatch = result.componentKeys.length === expectedKeys.length &&
    [...result.componentKeys].sort().every((key, index) => key === expectedKeys[index])
  const timestamp = result.observedAt ? Date.parse(result.observedAt) : Number.NaN
  const fresh = Number.isFinite(timestamp) && timestamp <= nowMs + 30_000 && nowMs - timestamp <= 15 * 60_000
  const identityMatches = identityBefore?.id?.toLowerCase() === expected.physicalId.toLowerCase() && (identityBefore.gen || 0) >= 2 &&
    identityAfter?.id?.toLowerCase() === expected.physicalId.toLowerCase() && (identityAfter.gen || 0) >= 2

  if (result.failure || !result.writeAttempted || !result.acknowledgement || !identityMatches ||
      !componentMatch || !statusBefore || !statusAfter || !fresh) {
    return null
  }

  // Invalid acknowledgement fails command confirmation, but a fresh, matching
  // status read is still real observed state and must not be discarded.
  const acknowledgement = result.acknowledgement as Record<string, unknown>
  const acknowledgementValid = typeof acknowledgement.was_on === 'boolean'
  return {
    on: statusAfter.on,
    observedAt: result.observedAt!,
    confirmed: statusAfter.on === expected.requestedOn && acknowledgementValid,
  }
}
