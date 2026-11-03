import { verifySiteLocalShellyCommandReadback } from './site-local-shelly-command-readback'
import type { SiteLocalShellyRpcResult } from './adapters/outbound/network/site-local-shelly-control.adapter'

const physicalId = 'shellyplus1-8813bfcdc8bc'
const nowMs = Date.parse('2026-11-03T10:30:00.000Z')
const expected = { physicalId, component: 'switch:0', expectedComponentKeys: ['switch:0'], requestedOn: true }

function evidence(overrides: Partial<SiteLocalShellyRpcResult> = {}): SiteLocalShellyRpcResult {
  return {
    identityBefore: { id: physicalId, gen: 2 },
    identityAfter: { id: physicalId, gen: 2 },
    componentKeys: ['switch:0'],
    statusBefore: { id: 0, output: false },
    statusAfter: { id: 0, output: true },
    acknowledgement: { was_on: false },
    observedAt: new Date(nowMs - 1000).toISOString(),
    observer: { id: 'pi-upstream-bathroom', host: 'pi', interfaceName: 'eth0', interfaceAddress: '192.168.1.6' },
    writeAttempted: true,
    ...overrides,
  }
}

describe('site-local Shelly command readback validation', () => {
  it('confirms a correctly identified device, component, acknowledgement and fresh matching readback', () => {
    expect(verifySiteLocalShellyCommandReadback(evidence(), expected, nowMs)).toEqual({
      on: true, observedAt: new Date(nowMs - 1000).toISOString(), confirmed: true,
    })
  })

  it.each([
    ['wrong identity before', { identityBefore: { id: 'shellyplus1-000000000000', gen: 2 } }],
    ['wrong identity after', { identityAfter: { id: 'shellyplus1-000000000000', gen: 2 } }],
    ['wrong relay channel', { statusAfter: { id: 1, output: true } }],
    ['wrong physical components', { componentKeys: ['switch:1'] }],
    ['missing status before write', { statusBefore: null }],
    ['failed RPC', { failure: 'rpc_failed' }],
    ['write never attempted', { writeAttempted: false }],
    ['missing acknowledgement', { acknowledgement: null }],
    ['stale evidence', { observedAt: new Date(nowMs - 16 * 60_000).toISOString() }],
    ['future evidence', { observedAt: new Date(nowMs + 31_000).toISOString() }],
  ] as const)('rejects %s rather than accepting a command result', (_description, invalid) => {
    expect(verifySiteLocalShellyCommandReadback(evidence(invalid), expected, nowMs)).toBeNull()
  })

  it('records a genuine state but does not confirm an unfulfilled requested transition', () => {
    expect(verifySiteLocalShellyCommandReadback(evidence({ statusAfter: { id: 0, output: false } }), expected, nowMs))
      .toMatchObject({ on: false, confirmed: false })
  })

  it('does not confirm a malformed acknowledgement, even when status matches', () => {
    expect(verifySiteLocalShellyCommandReadback(evidence({ acknowledgement: { unrelated: true } }), expected, nowMs))
      .toMatchObject({ on: true, confirmed: false })
  })

  it('does not modify the caller-owned inventory component list', () => {
    const components = ['switch:1', 'switch:0']
    verifySiteLocalShellyCommandReadback(evidence({ componentKeys: ['switch:0', 'switch:1'] }),
      { ...expected, expectedComponentKeys: components }, nowMs)
    expect(components).toEqual(['switch:1', 'switch:0'])
  })
})
