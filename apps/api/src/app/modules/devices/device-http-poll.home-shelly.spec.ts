jest.mock('node:os', () => ({
  ...jest.requireActual('node:os'),
  hostname: jest.fn(() => 'test-mac.local'),
  networkInterfaces: jest.fn(() => ({
    en0: [{ address: '192.168.7.25', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  })),
}))
import { DeviceHttpPollService } from './device-http-poll.service'
import type { RegisteredDevice } from './device-registry.types'

const deviceId = 'shellypro2pm-ec6260888084:switch:0'
const physicalId = 'shellypro2pm-ec6260888084'
const owner = { tenantId: 'tenant-demo', siteId: 'site-home' }
const zone = { id: 'eero-lan', name: 'eero LAN', cidr: '192.168.7.0/24', seedIps: ['192.168.7.1'] }
const device = {
  id: deviceId, ...owner, kind: 'physical', trustStatus: 'approved', displayName: 'Washer/Fan', zoneName: 'Bathroom',
  adapter: { id: 'shelly-discovered', driver: 'shelly-discovered', protocol: 'mqtt', configured: true, target: physicalId },
  metadata: { physicalId, component: 'switch:0', channel: 0, networkScope: 'gateway-unknown:192.168.7.0/24', physicalInventoryId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9' },
  capabilities: [{ kind: 'switch', actions: ['read'] }],
} as unknown as RegisteredDevice
const observer = {
  id: 'mac-eero-en0', host: 'test-mac', tenantId: owner.tenantId, siteId: owner.siteId,
  scopeId: zone.id, cidr: zone.cidr, interfaceName: 'en0', expectedDeviceIds: [physicalId],
  expectedComponentKeys: ['switch:0'],
}
const inventory = {
  physicalDeviceId: device.metadata?.physicalInventoryId, scope: owner,
  identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
  components: [{ key: 'switch:0' }],
  assignments: [{ deviceId, physicalDeviceId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9', componentKey: 'switch:0' }],
}
const knownRecord = {
  schemaVersion: 2, ownership: owner, identity: `device:${zone.id}:${physicalId}`,
  firstSeenAt: '2026-11-01T19:00:00.000Z', lastSeenAt: '2026-11-01T19:02:00.000Z', lastScanId: 'site-observer-test',
  device: {
    id: physicalId, ipAddress: '192.168.7.39', networkZoneId: zone.id, networkZoneName: zone.name,
    vendor: 'Shelly', protocol: 'http',
    observations: [
      { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: '2026-11-01T19:02:00.000Z', scopeId: zone.id, method: 'GET /rpc/Shelly.GetDeviceInfo' },
      { source: 'http_identity', attribute: 'identity.device_id', value: physicalId, observedAt: '2026-11-01T19:02:00.000Z', scopeId: zone.id, method: 'GET /rpc/Shelly.GetDeviceInfo' },
      { source: 'site_local_http_rpc', attribute: 'observer.identity', value: observer.id, observedAt: '2026-11-01T19:02:00.000Z', scopeId: zone.id, interfaceName: 'en0' },
      { source: 'site_local_http_rpc', attribute: 'shelly.component_status', value: 'switch:0', observedAt: '2026-11-01T19:02:01.000Z', scopeId: zone.id, interfaceName: 'en0', method: 'Switch.GetStatus?id=0' },
    ],
  },
}

function response(body: unknown): Response {
  return { status: 200, headers: { get: () => null }, json: async () => body } as unknown as Response
}

describe('authorized Home Shelly operational observation', () => {
  const originalEnv = process.env
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env = { ...originalEnv, HOME_SITE_LOCAL_OBSERVERS_JSON: JSON.stringify([observer]) }
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  function setup(options: {
    authorizedObserver?: typeof observer; status?: Record<string, unknown>; identity?: Record<string, unknown>
    physicalInventoryId?: string; omitPhysicalInventoryId?: boolean
  } = {}) {
    process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = JSON.stringify([options.authorizedObserver ?? observer])
    const deviceToPoll = {
      ...device,
      metadata: {
        ...device.metadata,
        ...(options.omitPhysicalInventoryId ? { physicalInventoryId: undefined } : {}),
        ...(options.physicalInventoryId ? { physicalInventoryId: options.physicalInventoryId } : {}),
      },
    } as RegisteredDevice
    const registry = {
      getDevices: jest.fn().mockReturnValue([deviceToPoll]),
      ingestDeviceTelemetry: jest.fn(),
      ingestDeviceStatus: jest.fn(),
      recordObserverReachability: jest.fn(),
    }
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([knownRecord]) }
    const lan = { getConfiguredZone: jest.fn((id: string) => id === zone.id ? zone : undefined) }
    const physical = { forLogicalDevice: jest.fn().mockResolvedValue(inventory) }
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(options.identity ?? { id: physicalId, gen: 2 }))
      .mockResolvedValueOnce(response(options.status ?? { id: 0, output: false, apower: 1.9 })) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(
      registry as never, undefined, discovery as never, lan as never, undefined, physical as never,
    )
    return { poller, registry, discovery, lan, physical }
  }

  it('collects only switch output from the explicitly assigned Home observer and canonical RPC identity', async () => {
    const fixture = setup()
    await fixture.poller.pollOnce()

    expect(global.fetch).toHaveBeenNthCalledWith(1, 'http://192.168.7.39/rpc/Shelly.GetDeviceInfo', expect.objectContaining({
      redirect: 'manual', signal: expect.any(AbortSignal),
    }))
    expect(global.fetch).toHaveBeenNthCalledWith(2, 'http://192.168.7.39/rpc/Switch.GetStatus?id=0', expect.any(Object))
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledWith(deviceId, expect.objectContaining({
      status: 'reachable', targetIpAddress: '192.168.7.39', networkScopeId: 'eero-lan',
      observer: expect.objectContaining({ id: observer.id, host: observer.host, localScopes: [expect.objectContaining({ interfaceName: 'en0' })] }),
    }))
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      deviceId, tenantId: owner.tenantId, siteId: owner.siteId, values: { on: false },
      state: expect.objectContaining({ source: `site-local-http-rpc:${observer.id}`, status: 'online', values: { on: false } }),
      observationId: expect.stringMatching(/^shelly-local:/),
    }))
    expect(fixture.registry.ingestDeviceTelemetry.mock.calls[0][0].values).not.toHaveProperty('power')
    expect(fixture.registry.ingestDeviceTelemetry.mock.calls[0][0]).not.toHaveProperty('control')
    expect(fixture.registry.ingestDeviceTelemetry.mock.calls[0][0]).not.toHaveProperty('observationAuthority')
  })

  it('fails closed when the observer has no exact component authorization', async () => {
    const fixture = setup({ authorizedObserver: { ...observer, expectedComponentKeys: ['switch:1'] } })
    await fixture.poller.pollOnce()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
  })

  it('does not use an observer authorized for another site or scope', async () => {
    const fixture = setup({ authorizedObserver: { ...observer, siteId: 'site-other', scopeId: 'upstream-lan' } })
    await fixture.poller.pollOnce()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    expect(fixture.registry.ingestDeviceStatus).not.toHaveBeenCalled()
  })

  it('uses the site-owned assigned inventory record when the optional registry mirror is absent', async () => {
    const fixture = setup({ omitPhysicalInventoryId: true })
    await fixture.poller.pollOnce()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      deviceId, values: { on: false }, tenantId: owner.tenantId, siteId: owner.siteId,
    }))
  })

  it('rejects a present but conflicting physical inventory ID before RPC', async () => {
    const fixture = setup({ physicalInventoryId: 'conflicting-inventory-id' })
    await fixture.poller.pollOnce()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
  })

  it('rejects a mismatched live identity without ingesting relay state', async () => {
    const fixture = setup({ identity: { id: 'shellypro2pm-000000000000', gen: 2 } })
    await fixture.poller.pollOnce()
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledWith(deviceId,
      expect.objectContaining({ status: 'unreachable', reason: 'Error' }))
  })

  it('keeps the last observation on a failed poll and accepts state again after reconnect', async () => {
    const fixture = setup()
    global.fetch = jest.fn().mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch
    await fixture.poller.pollOnce()
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledWith(deviceId,
      expect.objectContaining({ status: 'unreachable' }))
    expect(fixture.registry.ingestDeviceStatus).not.toHaveBeenCalled()
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()

    global.fetch = jest.fn()
      .mockResolvedValueOnce(response({ id: physicalId, gen: 2 }))
      .mockResolvedValueOnce(response({ id: 0, output: true })) as unknown as typeof fetch
    await fixture.poller.pollOnce()
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      values: { on: true },
      state: expect.objectContaining({ status: 'online', values: { on: true } }),
    }))
  })
})
