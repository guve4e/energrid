import { DeviceHttpPollService } from './device-http-poll.service'
import type { RegisteredDevice } from './device-registry.types'

const deviceId = 'shellyplus1-8813bfcdc8bc:switch:0'
const physicalId = 'shellyplus1-8813bfcdc8bc'
const owner = { tenantId: 'tenant-demo', siteId: 'site-home' }
const observer = { id: 'pi-upstream-bathroom', host: 'pi', interfaceName: 'eth0', platform: 'linux' as const,
  localScopes: [{ interfaceName: 'eth0', cidr: '192.168.1.0/24', address: '192.168.1.6' }] }
const device = { id: deviceId, ...owner, displayName: 'Bathroom switch', zoneName: 'Bathroom',
  capabilities: [{ kind: 'switch', actions: ['read'] }], adapter: { driver: 'shelly-discovered' } } as unknown as RegisteredDevice
const assignment = { assignmentKey: 'b'.repeat(32), targetKey: 'a'.repeat(32), device, ...owner,
  physicalId, physicalInventoryId: 'dc565b3f-87ad-410c-9ae3-862d6b655c47', component: 'switch:0',
  ipAddress: '192.168.1.219', scopeId: 'upstream-lan', expectedComponentKeys: ['switch:0'] }
const sessionId = '11111111-1111-4111-8111-111111111111'

function event(options: { sequence?: number; observedAt?: string; output?: boolean; scopeId?: string;
  physicalId?: string; componentKey?: string; kind?: 'observation' | 'failure' } = {}) {
  const sequence = options.sequence ?? 1
  return {
    schemaVersion: 1, kind: options.kind ?? 'observation', scopeId: options.scopeId ?? assignment.scopeId,
    observerSessionId: sessionId, sequence, observationId: `${sessionId}:${sequence}`,
    assignmentKey: assignment.assignmentKey, targetKey: assignment.targetKey,
    physicalId: options.physicalId ?? physicalId, ipAddress: assignment.ipAddress,
    componentKey: options.componentKey ?? assignment.component,
    componentKeys: ['switch:0'], identity: { id: options.physicalId ?? physicalId, gen: 2 },
    body: { id: 0, output: options.output ?? false }, observedAt: options.observedAt ?? new Date().toISOString(),
  }
}

function setup() {
  const registry = {
    getDevices: jest.fn().mockReturnValue([device]),
    ingestDeviceTelemetry: jest.fn(),
    recordObserverReachability: jest.fn(),
  }
  const poller = new DeviceHttpPollService(registry as never)
  const logger = (poller as any).logger
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined)
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
  const session = {
    sessionId, scopeId: assignment.scopeId, owner, observer,
    assignmentMap: new Map([[assignment.assignmentKey, assignment]]),
    lastSequence: 0, lastObservedAtByAssignmentKey: new Map<string, number>(),
  }
  return { poller, registry, session, log, warn }
}

describe('remote site-local Shelly observations', () => {
  it.each([true, false])('passes actual output=%s through the canonical operational-state writer', output => {
    const fixture = setup()
    ;(fixture.poller as any).acceptRemoteShellyMessage(fixture.session, event({ output }))

    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      id: deviceId, deviceId, ...owner, protocol: 'http', transport: 'http', driver: 'shelly-lan',
      values: { on: output },
      state: expect.objectContaining({ values: { on: output }, source: `site-local-http-rpc:${observer.id}`, status: 'online' }),
      observationId: `${sessionId}:1`,
    }))
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledWith(deviceId,
      expect.objectContaining({ status: 'reachable', targetIpAddress: '192.168.1.219', networkScopeId: 'upstream-lan',
        observer: expect.objectContaining({ id: observer.id, host: 'pi', platform: 'linux' }) }), expect.objectContaining(owner))
    expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining('"outcome":"submitted_to_canonical_writer"'))
    const payload = fixture.registry.ingestDeviceTelemetry.mock.calls[0][0]
    expect(payload.values).toEqual({ on: output })
    expect(payload).not.toHaveProperty('control')
    expect(payload).not.toHaveProperty('observationAuthority')
    expect(payload).not.toHaveProperty('measurementApproval')
  })

  it('rejects wrong scope, physical identity and component without writing operational state', () => {
    const fixture = setup()
    const handler = (fixture.poller as any).acceptRemoteShellyMessage.bind(fixture.poller)
    handler(fixture.session, event({ scopeId: 'eero-lan' }))
    handler(fixture.session, event({ sequence: 2, physicalId: 'shellyplus1-000000000000' }))
    handler(fixture.session, event({ sequence: 3, componentKey: 'switch:1' }))

    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    expect(fixture.registry.recordObserverReachability).not.toHaveBeenCalled()
  })

  it('rejects duplicate sequence numbers and older samples even when the worker sequence advances', () => {
    const fixture = setup()
    const observedAt = new Date().toISOString()
    const handler = (fixture.poller as any).acceptRemoteShellyMessage.bind(fixture.poller)
    handler(fixture.session, event({ observedAt, output: true }))
    handler(fixture.session, event({ observedAt, output: false }))
    handler(fixture.session, event({ sequence: 2, observedAt: new Date(Date.parse(observedAt) - 1000).toISOString(), output: false }))

    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledTimes(1)
    expect(fixture.session.lastObservedAtByAssignmentKey.get(assignment.assignmentKey)).toBe(Date.parse(observedAt))
  })

  it('records observer failure separately without inventing a relay state', () => {
    const fixture = setup()
    const checkedAt = new Date().toISOString()
    ;(fixture.poller as any).acceptRemoteShellyMessage(fixture.session, {
      ...event({ kind: 'failure' }), reasonCode: 'rpc_unavailable', checkedAt,
    })

    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledWith(deviceId,
      expect.objectContaining({ status: 'unreachable', reason: 'rpc_unavailable' }), expect.objectContaining(owner))
    expect(fixture.warn).toHaveBeenCalledWith(expect.stringContaining('"outcome":"observer_failure"'))
    expect(fixture.warn).toHaveBeenCalledWith(expect.stringContaining('"observerId":"pi-upstream-bathroom"'))
  })
})
