import { DeviceHttpPollService } from './device-http-poll.service'
import type { DeviceRegistryService } from './device-registry.service'

const ownership = { tenantId: 'tenant-demo', siteId: 'site-device-lab' }
const physicalId = 'shellyplus1-00c0de000002'
const deviceId = `${physicalId}:switch:0`
const observedAt = new Date().toISOString()
const zone = { id: 'device-lab-vlan', cidr: '172.30.250.0/28', collectionSource: 'virtual-lab' }
const device = {
  id: deviceId, tenantId: ownership.tenantId, siteId: ownership.siteId,
  trustStatus: 'approved', kind: 'physical', displayName: 'Lab Shelly', zoneName: 'Lab',
  adapter: { driver: 'shelly-lan', protocol: 'http', configured: true, target: 'http://172.30.250.13/rpc/Switch.GetStatus?id=0' },
  metadata: { physicalId, component: 'switch:0', physicalInventoryId: '70a41259-3e04-4559-a490-a41afc7a3193' },
  capabilities: [{ kind: 'switch', actions: ['read'] }],
  control: { status: 'unavailable' }, assistantEnabled: false,
}
const identityEvidence = {
  ownership,
  device: {
    vendor: 'Shelly', id: physicalId, ipAddress: '172.30.250.13', networkZoneId: zone.id,
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
  const poller = new DeviceHttpPollService(
    registry as unknown as DeviceRegistryService, undefined, discovery as never, lan as never, undefined, physical as never,
  )
  return { poller, registry, discovery, lan, remote, physical }
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
  it('uses the same canonical status projection for the direct local HTTP poll path', async () => {
    const fixture = setup()
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ id: 0, output: true }),
    } as Response)
    try {
      await fixture.poller.pollOnce()
      expect(fetch).toHaveBeenCalledWith(device.adapter.target, expect.objectContaining({ headers: { Accept: 'application/json' } }))
      expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
        deviceId, values: { output: true }, state: expect.objectContaining({ values: { output: true }, source: 'http-poll', status: 'online' }),
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
    const localZone = { ...zone, id: 'home-iot', collectionSource: 'local' as const }
    const localDevice = {
      ...device,
      metadata: { ...device.metadata, networkScope: 'home-observer:home-iot' },
    }
    fixture.registry.getDevices.mockReturnValue([localDevice])
    fixture.lan.getConfiguredZone.mockImplementation((id: string) => id === localZone.id ? localZone : undefined)
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ id: 0, output: true }),
    } as Response)

    try {
      await fixture.poller.pollOnce()
      expect(fixture.lan.getConfiguredZone).toHaveBeenCalledWith('home-iot')
      expect(fetch).toHaveBeenCalledWith(localDevice.adapter.target, expect.any(Object))
      expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
        deviceId, values: { output: true },
      }))
    } finally {
      fetch.mockRestore()
    }
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
      values: { output }, state: expect.objectContaining({ values: { output }, source: 'site-local-http-rpc:virtual-lab-observer', status: 'online', observedAt }),
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

  it('fails closed for wrong-scope or missing saved evidence and observer errors', async () => {
    const wrongScope = setup({ identity: { ...identityEvidence, device: { ...identityEvidence.device, networkZoneId: 'home-lan' } } })
    await expect(wrongScope.poller.observeShellySwitchStatusOnce(deviceId, ownership)).rejects.toThrow(/not in the configured authorized Virtual Lab scope/)
    const noEvidence = setup({ identity: {} })
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
