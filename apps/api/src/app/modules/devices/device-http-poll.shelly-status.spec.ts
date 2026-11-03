import { DeviceHttpPollService } from './device-http-poll.service'
import { ShellyRouteResolver } from './shelly-route.resolver'
import type { DeviceRegistryService } from './device-registry.service'
import type { NetworkDiscoveryZone } from './device-registry.types'

const ownership = { tenantId: 'tenant-demo', siteId: 'site-device-lab' }
const physicalId = 'shellyplus1-00c0de000002'
const deviceId = `${physicalId}:switch:0`
const observedAt = new Date().toISOString()
const zone: NetworkDiscoveryZone = { id: 'device-lab-vlan', cidr: '172.30.250.0/28', collectionSource: 'virtual-lab' }
const device = {
  id: deviceId, tenantId: ownership.tenantId, siteId: ownership.siteId,
  trustStatus: 'approved', kind: 'physical', displayName: 'Lab Shelly', zoneName: 'Lab',
  adapter: { driver: 'shelly-lan', protocol: 'http', configured: true, target: 'http://172.30.250.13/rpc/Switch.GetStatus?id=0' },
  metadata: {
    physicalId, component: 'switch:0', channel: 0, ipAddress: '172.30.250.13',
    networkScope: 'virtual-lab-observer:device-lab-vlan', physicalInventoryId: '70a41259-3e04-4559-a490-a41afc7a3193',
    identityEvidenceSource: 'verified_site_local_shelly_rpc', componentEvidenceSource: 'verified_site_local_shelly_rpc',
    siteLocalEvidenceScanId: 'site-observer-fixture-scan', siteLocalObserverId: 'virtual-lab-observer',
  },
  capabilities: [{ kind: 'switch', actions: ['read'] }],
  control: { status: 'unavailable' }, assistantEnabled: false,
}
const identityEvidence = {
  ownership,
  device: {
    vendor: 'Shelly', id: physicalId, ipAddress: '172.30.250.13', networkZoneId: zone.id, protocol: 'http',
    components: [{ component: 'switch:0' }],
    observations: [
      { source: 'http_rpc', attribute: 'shelly.device_id', value: physicalId },
      { source: 'http_rpc', attribute: 'shelly.component_status', value: 'switch:0', method: 'Switch.GetStatus?id=0' },
    ],
  },
  lastSeenAt: observedAt,
}
const inventory = {
  physicalDeviceId: '70a41259-3e04-4559-a490-a41afc7a3193', scope: ownership,
  identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
  components: [{ key: 'switch:0', capabilities: ['switch'] }],
  assignments: [{ deviceId, physicalDeviceId: '70a41259-3e04-4559-a490-a41afc7a3193', componentKey: 'switch:0' }],
  networkObservations: [{ ipAddress: '172.30.250.13', networkScope: 'virtual-lab-observer:device-lab-vlan', isCurrent: true }],
}

function setup(overrides: { ownership?: typeof ownership; identity?: Record<string, unknown>; remote?: unknown; remoteError?: Error } = {}) {
  const registry = {
    ensureInstallationsLoaded: jest.fn(), getDevices: jest.fn().mockReturnValue([device]),
    getShellyReconciliationTargetDecision: jest.fn().mockResolvedValue({ matched: true, device }),
    ingestDeviceTelemetry: jest.fn(), ingestDeviceStatus: jest.fn(), recordObserverReachability: jest.fn(),
  }
  const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([overrides.identity || identityEvidence]) }
  const remote = jest.fn(overrides.remoteError
    ? () => Promise.reject(overrides.remoteError)
    : async () => overrides.remote || ({
      identity: { id: physicalId, gen: 2 }, componentKeys: ['switch:0'],
      componentStatuses: [{ componentKey: 'switch:0', body: { id: 0, output: false }, observedAt }],
      observer: { id: 'virtual-lab-observer', host: '192.168.1.138', interfaceName: 'eth0' },
    }))
  const lan = { getConfiguredZone: jest.fn((id: string) => id === zone.id ? zone : undefined), readVirtualLabShellyStatusEvidence: remote }
  const physical = { forLogicalDevice: jest.fn().mockResolvedValue(inventory) }
  const routes = new ShellyRouteResolver(
    registry as unknown as DeviceRegistryService, discovery as never, lan as never, physical as never,
  )
  const poller = new DeviceHttpPollService(
    registry as unknown as DeviceRegistryService, undefined, discovery as never, lan as never, undefined, physical as never, routes,
  )
  return { poller, routes, registry, discovery, lan, remote, physical }
}

// Virtual Lab routes intentionally use their current virtual observer rather than
// historical site-local RPC evidence. Test that fail-closed contract on a local
// route instead of accidentally asserting it for the virtual transport.
function requireSavedSiteLocalEvidence(fixture: ReturnType<typeof setup>) {
  fixture.lan.getConfiguredZone.mockImplementation((id: string) =>
    id === zone.id ? { ...zone, collectionSource: 'local' } : undefined)
}

function loggerSpies(poller: DeviceHttpPollService) {
  const logger = (poller as unknown as { logger: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void } }).logger
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined)
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
  return {
    log,
    error,
    records: () => [...log.mock.calls, ...error.mock.calls]
      .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>),
  }
}

describe('one-shot authorized Shelly status observation', () => {
  it('resolves the enrolled switch from one saved endpoint inside its configured scope', async () => {
    const fixture = setup()
    const target = await fixture.poller.resolveShellyControlTarget(deviceId, ownership)
    expect(target).toMatchObject({
      physicalId,
      component: 'switch:0',
      channel: 0,
      ipAddress: '172.30.250.13',
      zone: { id: zone.id, collectionSource: 'virtual-lab' },
    })
  })

  it('observes switch:1 independently while retaining the shared physical identity and inventory', async () => {
    const device1Id = `${physicalId}:switch:1`
    const device1 = {
      ...device,
      id: device1Id,
      adapter: { ...device.adapter, target: 'http://172.30.250.13/rpc/Switch.GetStatus?id=1' },
      metadata: {
        ...device.metadata,
        component: 'switch:1', channel: 1, ipAddress: '172.30.250.13',
        identityEvidenceSource: 'verified_site_local_shelly_rpc',
        componentEvidenceSource: 'verified_site_local_shelly_rpc',
        siteLocalEvidenceScanId: 'site-observer-test-scan', siteLocalObserverId: 'virtual-lab-observer',
      },
    }
    const sharedInventory = {
      ...inventory,
      networkObservations: [{ ipAddress: '172.30.250.13', networkScope: zone.id, isCurrent: true }],
      components: [
        { key: 'switch:0', capabilities: ['switch'] },
        { key: 'switch:1', capabilities: ['switch'] },
      ],
      assignments: [
        ...inventory.assignments,
        { deviceId: device1Id, physicalDeviceId: inventory.physicalDeviceId, componentKey: 'switch:1' },
      ],
    }
    const channelEvidence = {
      ownership,
      device: {
        vendor: 'Shelly', id: physicalId, ipAddress: '172.30.250.13', networkZoneId: zone.id, protocol: 'http',
        components: [{ component: 'switch:0' }, { component: 'switch:1' }],
        observations: [
          { source: 'http_rpc', attribute: 'shelly.device_id', value: physicalId },
          { source: 'http_rpc', attribute: 'shelly.component_status', value: 'switch:1', method: 'Switch.GetStatus?id=1' },
        ],
      },
      lastSeenAt: observedAt,
    }
    const fixture = setup({ identity: channelEvidence, remote: {
      identity: { id: physicalId, gen: 2 },
      componentKeys: ['switch:0', 'switch:1'],
      componentStatuses: [{ componentKey: 'switch:1', body: { id: 1, output: false }, observedAt }],
      observer: { id: 'virtual-lab-observer', host: '192.168.1.138', interfaceName: 'eth0' },
    } })
    fixture.registry.getDevices.mockReturnValue([device1])
    fixture.registry.getShellyReconciliationTargetDecision.mockResolvedValue({ matched: true, device: device1 })
    fixture.physical.forLogicalDevice.mockResolvedValue(sharedInventory as never)

    const target = await fixture.poller.resolveShellyControlTarget(device1Id, ownership)
    expect(target).toMatchObject({ component: 'switch:1', channel: 1, physicalId, ipAddress: '172.30.250.13' })
    const observation = await fixture.poller.observeShellySwitchStatusOnce(device1Id, ownership)

    expect(fixture.remote).toHaveBeenCalledWith(zone.id, '172.30.250.13', physicalId, ['switch:0', 'switch:1'], expect.any(AbortSignal))
    expect(observation).toMatchObject({ deviceId: device1Id, component: 'switch:1', output: false, physicalInventoryId: inventory.physicalDeviceId })
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: device1Id, values: { on: false }, state: expect.objectContaining({ values: { on: false } }),
    }))
  })

  it('treats legacy configured Home scopes without a source as local execution scopes', async () => {
    const homeZone: NetworkDiscoveryZone = { id: 'upstream-lan', cidr: '192.168.1.0/24', seedIps: [] }
    const homeEvidence = {
      ...identityEvidence,
      device: { ...identityEvidence.device, ipAddress: '192.168.1.166', networkZoneId: homeZone.id },
    }
    const fixture = setup({ identity: homeEvidence })
    fixture.registry.getDevices.mockReturnValue([{
      ...device,
      adapter: { ...device.adapter, target: 'http://192.168.1.166/rpc/Switch.GetStatus?id=0' },
      metadata: { ...device.metadata, ipAddress: '192.168.1.166', networkScope: 'home-observer:upstream-lan', siteLocalObserverId: 'mac-eero-en0' },
    }])
    fixture.physical.forLogicalDevice.mockResolvedValue({
      ...inventory, networkObservations: [{ ipAddress: '192.168.1.166', networkScope: homeZone.id, isCurrent: true }],
    } as never)
    jest.spyOn(fixture.routes, 'resolveAuthorizedLocalShellyStatusTarget').mockResolvedValue({
      ipAddress: '192.168.1.166', physicalId, component: 'switch:0', channel: 0,
      zone: homeZone, interfaceAddress: '192.168.1.10',
      observer: { id: 'mac-eero-en0', host: 'localhost', tenantId: ownership.tenantId, siteId: ownership.siteId,
        scopeId: homeZone.id, cidr: homeZone.cidr, interfaceName: 'en0', expectedDeviceIds: [physicalId],
        expectedComponentKeys: ['switch:0'] },
    } as never)
    const legacyZone = homeZone
    fixture.lan.getConfiguredZone.mockReturnValue(legacyZone)
    const target = await fixture.poller.resolveShellyControlTarget(deviceId, ownership)
    expect(target).toMatchObject({ ipAddress: '192.168.1.166', zone: { id: 'upstream-lan', collectionSource: 'local' } })
  })

  it('rejects a saved IP that is associated with the scope ID but outside its configured CIDR', async () => {
    const outsideEvidence = {
      ...identityEvidence,
      device: { ...identityEvidence.device, ipAddress: '192.168.1.21' },
    }
    const fixture = setup({ identity: outsideEvidence })
    fixture.registry.getDevices.mockReturnValue([{
      ...device, metadata: { ...device.metadata, ipAddress: '192.168.1.21' },
    }])
    fixture.physical.forLogicalDevice.mockResolvedValue({
      ...inventory, networkObservations: [{ ipAddress: '192.168.1.21', networkScope: zone.id, isCurrent: true }],
    } as never)
    await expect(fixture.poller.resolveShellyControlTarget(deviceId, ownership))
      .rejects.toThrow('outside the configured network scope')
  })

  it('uses the same canonical status projection for the direct local HTTP poll path', async () => {
    const fixture = setup()
    const localDevice = {
      ...device,
      adapter: { ...device.adapter, target: 'http://192.168.1.166/rpc/Switch.GetStatus?id=0' },
      metadata: { ...device.metadata, ipAddress: '192.168.1.166', networkScope: 'home-observer:upstream-lan' },
    }
    const localZone: NetworkDiscoveryZone = { id: 'upstream-lan', cidr: '192.168.1.0/24', seedIps: [] }
    fixture.registry.getDevices.mockReturnValue([localDevice])
    fixture.lan.getConfiguredZone.mockImplementation((id: string) => id === localZone.id ? localZone : undefined)
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ id: 0, output: true }),
    } as Response)
    try {
      await fixture.poller.pollOnce()
      expect(fetch).toHaveBeenCalledWith(localDevice.adapter.target, expect.objectContaining({ headers: { Accept: 'application/json' } }))
      expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
        deviceId, values: { on: true }, state: expect.objectContaining({ values: { on: true }, source: 'http-poll', status: 'online' }),
      }))
    } finally {
      fetch.mockRestore()
    }
  })

  it('does not turn a failed API-host Shelly request into device-reported offline state', async () => {
    const fixture = setup()
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('local route unavailable'))
    try {
      await fixture.poller.pollOnce()
      expect(fixture.registry.ingestDeviceStatus).not.toHaveBeenCalled()
      expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it('does not direct-poll a Shelly whose saved scope is assigned to the configured Virtual Lab observer', async () => {
    const fixture = setup()
    const virtualDevice = {
      ...device,
      metadata: { ...device.metadata, networkScope: 'virtual-lab-observer:device-lab-vlan' },
    }
    fixture.registry.getDevices.mockReturnValue([virtualDevice])
    const fetch = jest.spyOn(global, 'fetch')

    try {
      await fixture.poller.pollOnce()
      expect(fixture.lan.getConfiguredZone).toHaveBeenCalledWith('device-lab-vlan')
      expect(fetch).not.toHaveBeenCalled()
      expect(fixture.registry.ingestDeviceStatus).not.toHaveBeenCalled()
      expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
      expect(fixture.remote).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it('continues direct polling for a Shelly assigned to a configured local scope', async () => {
    const fixture = setup()
    const localZone: NetworkDiscoveryZone = { id: 'upstream-lan', cidr: '192.168.1.0/24', seedIps: [] }
    const localDevice = {
      ...device,
      adapter: { ...device.adapter, target: 'http://192.168.1.166/rpc/Switch.GetStatus?id=0' },
      metadata: { ...device.metadata, networkScope: 'home-observer:upstream-lan' },
    }
    fixture.registry.getDevices.mockReturnValue([localDevice])
    fixture.lan.getConfiguredZone.mockImplementation((id: string) => id === localZone.id ? localZone : undefined)
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ id: 0, output: true }),
    } as Response)

    try {
      await fixture.poller.pollOnce()
      expect(fixture.lan.getConfiguredZone).toHaveBeenCalledWith('upstream-lan')
      expect(fetch).toHaveBeenCalledWith(localDevice.adapter.target, expect.any(Object))
      expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
        deviceId, values: { on: true },
      }))
    } finally {
      fetch.mockRestore()
    }
  })

  it('keeps one remote read-only observer and sends accepted status through the shared writer', async () => {
    const fixture = setup()
    let onMessage: ((message: unknown) => void) | undefined
    let observerSessionId = ''
    const lan = fixture.lan as typeof fixture.lan & { startRemoteShellyOperationalObserver: jest.Mock }
    const handle = { update: jest.fn(() => true), close: jest.fn(), isAlive: jest.fn(() => true) }
    lan.startRemoteShellyOperationalObserver = jest.fn(async (
      _scopeId: string, sessionId: string, _assignments: unknown[], receive: (message: unknown) => void,
    ) => {
      observerSessionId = sessionId
      onMessage = receive
      return { handle, observer: { id: 'remote-observer', host: '192.0.2.20', interfaceName: 'eth0' } }
    })
    const fetch = jest.spyOn(global, 'fetch')
    await fixture.poller.pollOnce()
    expect(lan.startRemoteShellyOperationalObserver).toHaveBeenCalledTimes(1)
    expect(handle.update).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()

    const assignments = lan.startRemoteShellyOperationalObserver.mock.calls[0][2] as any[]
    const assignedComponent = assignments[0].components[0]
    const assignedTarget = assignments[0]
    const observedAt = new Date(Date.now() - 1_000).toISOString()
    const event = {
      schemaVersion: 1, kind: 'observation', scopeId: zone.id, observerSessionId,
      sequence: 1, observationId: `${observerSessionId}:1`,
      assignmentKey: assignedComponent.assignmentKey, targetKey: assignedTarget.key,
      physicalId, ipAddress: '172.30.250.13', componentKey: 'switch:0',
      componentKeys: ['switch:0'], identity: { id: physicalId, gen: 2 },
      body: { id: 0, output: false }, observedAt,
    }
    onMessage!(event)
    onMessage!(event)
    onMessage!({ ...event, sequence: 2, observationId: `${observerSessionId}:2`, body: { id: 0, output: true }, observedAt: new Date(Date.now() - 2_000).toISOString() })
    const laterObservedAt = new Date().toISOString()
    onMessage!({ ...event, sequence: 3, observationId: `${observerSessionId}:3`, body: { id: 0, output: true }, observedAt: laterObservedAt })

    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledTimes(2)
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenNthCalledWith(1, expect.objectContaining({
      values: { on: false }, observationId: `${observerSessionId}:1`, observedAt,
      state: expect.objectContaining({ values: { on: false }, source: 'site-local-http-rpc:remote-observer', status: 'online' }),
    }))
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenNthCalledWith(2, expect.objectContaining({
      values: { on: true }, observationId: `${observerSessionId}:3`, observedAt: laterObservedAt,
    }))
    expect(fixture.registry.ingestDeviceTelemetry.mock.calls.every(([payload]) =>
      !('control' in (payload as Record<string, unknown>)) && !('measurementApproval' in (payload as Record<string, unknown>)),
    )).toBe(true)
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledTimes(2)
    fetch.mockRestore()
  })

  it('does not let a remote failure replace last-known output and rejects wrong-scope events', async () => {
    const fixture = setup()
    let onMessage: ((message: unknown) => void) | undefined
    let observerSessionId = ''
    const lan = fixture.lan as typeof fixture.lan & { startRemoteShellyOperationalObserver: jest.Mock }
    const handle = { update: jest.fn(() => true), close: jest.fn(), isAlive: jest.fn(() => true) }
    lan.startRemoteShellyOperationalObserver = jest.fn(async (_scopeId: string, sessionId: string, _targets: unknown[], receive: (message: unknown) => void) => {
      observerSessionId = sessionId; onMessage = receive
      return { handle, observer: { id: 'remote-observer', host: '192.0.2.20', interfaceName: 'eth0' } }
    })
    await fixture.poller.pollOnce()
    const target = (lan.startRemoteShellyOperationalObserver.mock.calls[0][2] as any[])[0]
    const component = target.components[0]
    const base = {
      schemaVersion: 1, kind: 'failure', scopeId: zone.id, observerSessionId,
      sequence: 1, observationId: `${observerSessionId}:1`, assignmentKey: component.assignmentKey,
      targetKey: target.key, physicalId, ipAddress: '172.30.250.13', componentKey: 'switch:0',
      reasonCode: 'rpc_unavailable', checkedAt: new Date().toISOString(),
    }
    onMessage!({ ...base, scopeId: 'home-iot' })
    onMessage!(base)
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    expect(fixture.registry.ingestDeviceStatus).not.toHaveBeenCalled()
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledTimes(1)
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledWith(deviceId, expect.objectContaining({ status: 'unreachable' }))
  })

  it.each([true, false])('writes only the canonical output=%s through the shared registry writer', async output => {
    const fixture = setup({ remote: {
      identity: { id: physicalId, gen: 2 }, componentKeys: ['switch:0'],
      componentStatuses: [{ componentKey: 'switch:0', body: { id: 0, output }, observedAt }],
      observer: { id: 'virtual-lab-observer', host: '192.168.1.138', interfaceName: 'eth0' },
    } })
    const diagnostics = loggerSpies(fixture.poller)
    const result = await fixture.poller.observeShellySwitchStatusOnce(deviceId, ownership)
    expect(result.output).toBe(output)
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      deviceId, tenantId: ownership.tenantId, siteId: ownership.siteId,
      values: { on: output }, state: expect.objectContaining({ values: { on: output }, source: 'site-local-http-rpc:virtual-lab-observer', status: 'online', observedAt }),
    }))
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledWith(deviceId, expect.objectContaining({
      status: 'reachable', targetIpAddress: '172.30.250.13', networkScopeId: zone.id,
      observer: expect.objectContaining({ id: 'virtual-lab-observer', host: '192.168.1.138' }),
    }))
    expect(fixture.remote).toHaveBeenCalledWith(zone.id, '172.30.250.13', physicalId, ['switch:0'], expect.any(AbortSignal))
    expect(fixture.registry.ingestDeviceTelemetry.mock.calls[0][0]).not.toHaveProperty('control')
    expect(fixture.registry.ingestDeviceTelemetry.mock.calls[0][0]).not.toHaveProperty('observationAuthority')
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledTimes(1)
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledTimes(1)
    expect(diagnostics.records().map(record => record.stage)).toEqual([
      'request_accepted_site_resolved', 'enrollment_inventory_validated',
      'saved_endpoint_observer_scope_validated', 'remote_execution_started',
      'remote_execution_completed', 'rpc_response_validated', 'operational_state_ingestion_completed',
    ])
    expect(diagnostics.records().every(record => typeof record.correlationId === 'string' && typeof record.durationMs === 'number')).toBe(true)
  })

  it('rejects malformed or component-mismatched status without changing operational state', async () => {
    const fixture = setup({ remote: {
      identity: { id: physicalId, gen: 2 }, componentKeys: ['switch:0'],
      componentStatuses: [{ componentKey: 'switch:0', body: { id: 1, output: true }, observedAt }],
      observer: { id: 'virtual-lab-observer', host: '192.168.1.138', interfaceName: 'eth0' },
    } })
    await expect(fixture.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow(/malformed or mismatched/)
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    expect(fixture.registry.recordObserverReachability).not.toHaveBeenCalled()
  })

  it('rejects a different physical identity and a wrong site before state is written', async () => {
    const mismatch = setup({ remote: {
      identity: { id: 'shellyplus1-000000000000', gen: 2 }, componentKeys: ['switch:0'],
      componentStatuses: [{ componentKey: 'switch:0', body: { id: 0, output: true }, observedAt }],
      observer: { id: 'virtual-lab-observer', host: '192.168.1.138', interfaceName: 'eth0' },
    } })
    await expect(mismatch.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow(/identity that does not match/)
    const wrongSite = setup()
    await expect(wrongSite.poller.observeShellySwitchStatusOnce(deviceId, { ...ownership, siteId: 'site-home' })).rejects.toThrow(/No Shelly installation/)
    expect(mismatch.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    expect(wrongSite.remote).not.toHaveBeenCalled()
  })

  it('fails closed for wrong-scope or missing saved site-local evidence and for observer errors', async () => {
    const wrongScope = setup({ identity: { ...identityEvidence, device: { ...identityEvidence.device, networkZoneId: 'home-lan' } } })
    requireSavedSiteLocalEvidence(wrongScope)
    await expect(wrongScope.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow(/component-status evidence supports the reconciled/)
    const noEvidence = setup({ identity: {} })
    requireSavedSiteLocalEvidence(noEvidence)
    await expect(noEvidence.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow(/No saved site-owned identity/)
    const failure = setup({ remoteError: new Error('observer failure') })
    await expect(failure.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow('observer failure')
    expect(wrongScope.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    expect(failure.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
  })

  it('reports the failing enrollment and inventory validation stage', async () => {
    const fixture = setup()
    fixture.physical.forLogicalDevice.mockRejectedValueOnce(Object.assign(new Error('inventory unavailable'), { code: 'EIO' }))
    const diagnostics = loggerSpies(fixture.poller)
    await expect(fixture.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow('inventory unavailable')
    expect(diagnostics.records().at(-1)).toMatchObject({
      stage: 'enrollment_and_inventory_validation', outcome: 'failed', failureCategory: 'precondition_failed',
      error: [{ type: 'Error', code: 'EIO', message: 'inventory unavailable' }],
    })
    expect(fixture.remote).not.toHaveBeenCalled()
  })

  it('reports the saved endpoint and scope failure without starting remote execution', async () => {
    const fixture = setup({ identity: {} })
    requireSavedSiteLocalEvidence(fixture)
    const diagnostics = loggerSpies(fixture.poller)
    await expect(fixture.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow(/No saved site-owned identity/)
    expect(diagnostics.records().at(-1)).toMatchObject({
      stage: 'saved_endpoint_observer_scope_validation', outcome: 'failed', failureCategory: 'precondition_failed',
    })
    expect(fixture.remote).not.toHaveBeenCalled()
  })

  it('reports remote execution failure with safe cause details and no command output', async () => {
    const original = Object.assign(new Error('runner stopped\nUNRESTRICTED_STDERR'), { code: 'ETIMEDOUT', stderr: 'SECRET_OUTPUT' })
    const fixture = setup({ remoteError: original })
    const diagnostics = loggerSpies(fixture.poller)
    await expect(fixture.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow('runner stopped')
    const failure = diagnostics.records().at(-1)!
    expect(failure).toMatchObject({ stage: 'remote_execution', outcome: 'failed', failureCategory: 'remote_execution_failed' })
    expect(JSON.stringify(failure)).toContain('ETIMEDOUT')
    expect(JSON.stringify(failure)).not.toContain('UNRESTRICTED_STDERR')
    expect(JSON.stringify(failure)).not.toContain('SECRET_OUTPUT')
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
  })

  it('reports malformed RPC response at validation and writer failure at ingestion', async () => {
    const malformed = setup({ remote: {
      identity: { id: physicalId, gen: 2 }, componentKeys: ['switch:0'],
      componentStatuses: [{ componentKey: 'switch:0', body: { id: 1, output: true }, observedAt }],
      observer: { id: 'virtual-lab-observer', host: '192.168.1.138', interfaceName: 'eth0' },
    } })
    const malformedDiagnostics = loggerSpies(malformed.poller)
    await expect(malformed.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow(/malformed or mismatched/)
    expect(malformedDiagnostics.records().at(-1)).toMatchObject({
      stage: 'rpc_response_validation', outcome: 'failed', failureCategory: 'rpc_response_rejected',
    })

    const ingestion = setup()
    ingestion.registry.ingestDeviceTelemetry.mockImplementationOnce(() => { throw new Error('state writer failed') })
    const ingestionDiagnostics = loggerSpies(ingestion.poller)
    await expect(ingestion.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow('state writer failed')
    expect(ingestionDiagnostics.records().at(-1)).toMatchObject({
      stage: 'operational_state_ingestion', outcome: 'failed', failureCategory: 'state_ingestion_failed',
    })
    expect(ingestion.registry.ingestDeviceTelemetry).toHaveBeenCalledTimes(1)
    expect(ingestion.registry.recordObserverReachability).not.toHaveBeenCalled()
  })
})
