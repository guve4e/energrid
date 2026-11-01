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
    components: [{ component: 'switch:0' }],
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
      ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
      getShellyReconciliationTargetDecision: jest.fn().mockResolvedValue({ matched: true, device: deviceToPoll }),
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

  it('resolves the discovered MQTT-profile Home Shelly to its exact local RPC route', async () => {
    const fixture = setup()
    const target = await fixture.poller.resolveShellyControlTarget(deviceId, owner)

    expect(target).toMatchObject({
      physicalId, component: 'switch:0', channel: 0, ipAddress: '192.168.7.39',
      zone: { id: 'eero-lan', collectionSource: 'local' },
    })
    expect(fixture.registry.getShellyReconciliationTargetDecision).toHaveBeenCalledWith(
      owner.tenantId, owner.siteId, deviceId, physicalId, 'switch:0', inventory.physicalDeviceId,
    )
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects an installation scope that does not identify the configured endpoint zone', async () => {
    const fixture = setup()
    fixture.registry.getDevices.mockReturnValue([{
      ...device,
      metadata: { ...device.metadata, networkScope: 'upstream-lan:192.168.1.0/24' },
    } as RegisteredDevice])
    fixture.registry.getShellyReconciliationTargetDecision.mockResolvedValue({ matched: true, device } as never)

    await expect(fixture.poller.resolveShellyControlTarget(deviceId, owner))
      .rejects.toThrow('The saved endpoint does not belong to the installation network scope.')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('resolves a Virtual Lab route from the saved observer-qualified zone ID', async () => {
    const labOwner = { tenantId: owner.tenantId, siteId: 'site-device-lab' }
    const labPhysicalId = 'shellyplus1-00c0de000001'
    const labDeviceId = `${labPhysicalId}:switch:0`
    const labZone = {
      id: 'device-lab-vlan', name: 'Virtual Device Lab', cidr: '172.30.250.0/28',
      seedIps: ['172.30.250.11'], collectionSource: 'virtual-lab' as const,
    }
    const labDevice = {
      ...device, ...labOwner, id: labDeviceId, siteName: 'Virtual Device Lab',
      adapter: { id: 'shelly-lan', driver: 'shelly-lan', protocol: 'http', configured: true, target: 'http://172.30.250.11/rpc/Switch.GetStatus?id=0' },
      metadata: { physicalId: labPhysicalId, component: 'switch:0', channel: 0, networkScope: 'virtual-lab-observer:device-lab-vlan', physicalInventoryId: 'lab-inventory-id' },
    } as unknown as RegisteredDevice
    const labInventory = {
      ...inventory, physicalDeviceId: 'lab-inventory-id', scope: labOwner,
      identity: { namespace: 'mqtt:shelly-protocol-id', value: labPhysicalId },
      assignments: [{ deviceId: labDeviceId, physicalDeviceId: 'lab-inventory-id', componentKey: 'switch:0' }],
    }
    const labEvidence = {
      ...knownRecord, ownership: labOwner, identity: `device:${labZone.id}:${labPhysicalId}`,
      device: {
        ...knownRecord.device, id: labPhysicalId, ipAddress: '172.30.250.11',
        networkZoneId: labZone.id, networkZoneName: labZone.name,
        observations: [
          { source: 'http_rpc', attribute: 'shelly.device_id', value: labPhysicalId },
          { source: 'http_rpc', attribute: 'shelly.component_status', value: 'switch:0', method: 'Switch.GetStatus?id=0' },
        ],
      },
    }
    const registry = {
      getDevices: jest.fn().mockReturnValue([labDevice]), ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
      getShellyReconciliationTargetDecision: jest.fn().mockResolvedValue({ matched: true, device: labDevice }),
    }
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([labEvidence]) }
    const lan = { getConfiguredZone: jest.fn((id: string) => id === labZone.id ? labZone : undefined) }
    const physical = { forLogicalDevice: jest.fn().mockResolvedValue(labInventory) }
    const fetch = jest.spyOn(global, 'fetch')
    const poller = new DeviceHttpPollService(registry as never, undefined, discovery as never, lan as never, undefined, physical as never)

    await expect(poller.resolveShellyControlTarget(labDeviceId, labOwner)).resolves.toMatchObject({
      physicalId: labPhysicalId, component: 'switch:0', channel: 0, ipAddress: '172.30.250.11',
      zone: { id: labZone.id, collectionSource: 'virtual-lab' },
    })
    expect(fetch).not.toHaveBeenCalled()
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
