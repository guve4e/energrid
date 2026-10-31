import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { Logger } from '@nestjs/common'
import {
  buildNetworkObservations,
  candidateBelongsToConfiguredZone,
  dedupeNetworkDevices,
  icmpReachabilityCandidate,
  ipInCidr,
  ipsInCidr,
  parseArpOutput,
  parseNetworkZones,
  parseRouterClientsJson,
  mergeNeighborCandidates,
  probeShelly,
  probeShellyComponentsWithEvidence,
  tcpPortOpen,
  DeviceLanNetworkEvidenceCollector,
  DeviceLanDiscoveryService,
} from './device-lan-discovery.service'
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { DeviceRegistryService } from './device-registry.service'
import type { NetworkDiscoveredDevice } from './device-registry.types'
import { shellyLanCandidates } from './adapters/inbound/shelly/shelly-lan-candidates'
import { NmapNetworkEvidenceAdapter, type NmapCommandRunner } from './adapters/outbound/network/nmap-network-evidence.adapter'
import type { LocalNetworkRuntimeAdapter, LocalNetworkRuntimeReport } from './adapters/outbound/network/local-network-runtime.adapter'
import { EnergridHttpIdentityAdapter, type EnergridIdentityTransport } from './adapters/outbound/network/energrid-http-identity.adapter'
import type { VirtualLabNetworkEvidenceAdapter } from './adapters/outbound/network/virtual-lab-network-evidence.adapter'

let mockReachableTcpPorts = new Set<number>()
let mockHangTcpConnections = false
const TEST_OWNER = { tenantId: 'tenant-demo', siteId: 'site-home' }
const TEST_DEVICE_OWNER = { tenantId: 'tenant-test', siteId: 'site-test' }
const TEST_REGISTRY = {
  getSnapshot: () => ({ tenant: { id: TEST_OWNER.tenantId }, site: { id: TEST_OWNER.siteId, name: 'Home' }, devices: [] }),
} as unknown as DeviceRegistryService

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_command, _args, _options, callback) => callback(new Error('mocked'))),
}))
jest.mock('node:dns/promises', () => ({
  reverse: jest.fn().mockRejectedValue(new Error('mocked')),
}))
jest.mock('node:net', () => ({
  ...jest.requireActual('node:net'),
  Socket: class {
    private readonly listeners = new Map<string, (...args: unknown[]) => void>()
    once(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, listener)
      return this
    }
    setTimeout() { return this }
    connect(port: number) {
      if (mockHangTcpConnections) return this
      queueMicrotask(() => mockReachableTcpPorts.has(port)
        ? this.listeners.get('connect')?.()
        : this.listeners.get('error')?.(new Error('mocked')))
      return this
    }
    destroy() {}
  },
}))

describe('LAN discovery evidence persistence', () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch
  let directory: string
  let memory: DeviceDiscoveryMemoryStore

  beforeEach(async () => {
    mockReachableTcpPorts = new Set()
    mockHangTcpConnections = false
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    directory = await mkdtemp(join(tmpdir(), 'energrid-lan-evidence-'))
    memory = new DeviceDiscoveryMemoryStore(directory)
    process.env.HOME_LAN_ACTIVE_SCAN_ENABLED = 'false'
    process.env.HOME_VIRTUAL_LAB_ENABLED = 'false'
    process.env.PORTAL_TENANT_ID = TEST_OWNER.tenantId
    process.env.PORTAL_SITE_ID = TEST_OWNER.siteId
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({
      zones: [{ id: 'home-lan', name: 'Home LAN', cidr: '192.168.1.0/24' }],
    })
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([
      {
        ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0a',
        vendor: 'Acme A', model: 'Sensor A', firmwareVersion: '1.2.3',
        protocol: 'mqtt', deviceReportedMacAddress: '02:00:00:00:00:aa',
        components: [{ component: 'temperature:0', channel: 0 }],
      },
      {
        ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0b',
        vendor: 'Acme B', model: 'Relay B', firmwareVersion: '4.5.6',
        protocol: 'http', deviceReportedMacAddress: '02:00:00:00:00:0b',
        components: [{ component: 'switch:0', channel: 0 }],
      },
    ])
    global.fetch = jest.fn().mockRejectedValue(new Error('mocked')) as unknown as typeof fetch
  })

  function selectedShellyVerifier(options: { registerCandidate?: boolean } = {}) {
    const physicalId = 'shellyproem50-8c4f00dbd258'
    const ipAddress = '192.168.7.54'
    const candidateId = `${physicalId}:em1:0`
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({
      zones: [{ id: 'eero-lan', name: 'Eero LAN', cidr: '192.168.7.0/24' }],
    })
    const candidate = {
      id: candidateId, tenantId: TEST_OWNER.tenantId, siteId: TEST_OWNER.siteId,
      displayName: 'Shelly Pro EM-50 em1:0', trustStatus: 'discovered', kind: 'physical',
      adapter: { protocol: 'http', driver: 'shelly-lan', target: `http://${ipAddress}/rpc/EM1.GetStatus?id=0` },
      metadata: { physicalId, component: 'em1:0', ipAddress, networkScope: 'gateway-unknown:eero-lan' },
      capabilities: [{ kind: 'power', actions: ['read'] }],
    }
    const registry = {
      getSnapshot: () => ({ tenant: { id: TEST_OWNER.tenantId }, site: { id: TEST_OWNER.siteId, name: 'Home' } }),
      getDevices: () => options.registerCandidate === false ? [] : [candidate],
      registerDiscoveredDevice: jest.fn(() => true),
    }
    const observedAt = new Date(Date.now() - 16 * 60_000).toISOString()
    const prior: NetworkDiscoveredDevice = {
      id: physicalId, ipAddress, networkZoneId: 'eero-lan', networkZoneName: 'Eero LAN',
      vendor: 'Shelly', protocol: 'http', confidence: 0.9, status: 'online', generation: 2,
      components: [{ component: 'em1:0', channel: 0 }, { component: 'em1:1', channel: 1 }, { component: 'switch:0', channel: 0 }],
      discoveredAt: observedAt,
      observations: [
        { source: 'http_rpc', attribute: 'shelly.device_id', value: physicalId, observedAt,
          scopeId: 'eero-lan', method: 'GET /rpc/Shelly.GetDeviceInfo' },
        ...['em1:0', 'em1:1', 'switch:0'].map(component => ({
          source: 'http_rpc' as const, attribute: 'shelly.component_status', value: component, observedAt,
          scopeId: 'eero-lan', method: `GET /rpc/${component.startsWith('switch:') ? 'Switch' : 'EM1'}.GetStatus?id=${component.split(':')[1]}`,
        })),
      ],
    }
    const inventory = {
      physicalDeviceId: 'physical-eero-inventory', scope: TEST_OWNER,
      identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      components: ['em1:0', 'em1:1', 'switch:0', 'input:0'].map(key => ({
        key, capabilities: key.startsWith('switch:') ? ['switch'] : ['power'], firstSeenAt: observedAt, lastSeenAt: observedAt,
      })),
      assignments: [], endpoints: [], networkObservations: [], verificationStatus: 'protocol_observed',
      firstSeenAt: observedAt, lastSeenAt: observedAt,
    }
    const physicalInventory = {
      list: jest.fn().mockResolvedValue([inventory]),
      discover: jest.fn().mockResolvedValue(inventory),
      refreshNetworkObservations: jest.fn().mockResolvedValue(undefined),
    }
    const service = new DeviceLanDiscoveryService(memory, registry as never,
      new DeviceLanNetworkEvidenceCollector(), physicalInventory as never)
    return { service, registry, physicalInventory, candidate, candidateId, physicalId, ipAddress, prior }
  }

  function mockFreshShellyRpc(components = ['em1:0', 'em1:1', 'switch:0']) {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'shellyproem50-8c4f00dbd258', mac: '8C:4F:00:DB:D2:58', model: 'SPEM-50', app: 'ProEM-50', gen: 2, fw_id: '1.0.0' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: components.map(key => ({ key })), total: components.length }) })
    for (const component of components) {
      const [kind, channel] = component.split(':')
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => kind === 'switch'
        ? { id: Number(channel), output: false, apower: 0 }
        : { id: Number(channel), act_power: 0 } })
    }
  }

  function virtualShellyVerifier(componentStatus: Record<string, unknown> = { id: 0, source: 'init', output: false }) {
    const physicalId = 'shellyplus1-00c0de000001'
    const ipAddress = '172.30.250.11'
    const component = 'switch:0'
    const candidateId = `${physicalId}:${component}`
    const zone = {
      id: 'device-lab-vlan', name: 'Virtual Lab LAN', cidr: '172.30.250.0/28',
      interfaceName: 'eth0', seedIps: ['172.30.250.10', ipAddress], collectionSource: 'virtual-lab' as const,
    }
    process.env.HOME_VIRTUAL_LAB_ENABLED = 'true'
    process.env.HOME_VIRTUAL_LAB_SCOPE_JSON = JSON.stringify({ zones: [zone] })
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [] })
    process.env.HOME_NETWORK_SCAN_ZONES_JSON = JSON.stringify({ zones: [] })
    const old = new Date(Date.now() - 20 * 60_000).toISOString()
    const prior: NetworkDiscoveredDevice = {
      id: physicalId, ipAddress, networkZoneId: zone.id, networkZoneName: zone.name,
      vendor: 'Shelly', model: 'SNSW-001X16EU', app: 'Plus1', firmwareVersion: '1.7.5',
      protocol: 'http', confidence: 0.95, status: 'online', generation: 2, components: [{ component, channel: 0 }],
      discoveredAt: old, reason: 'Read-only protocol identity was verified.',
      observations: [
        { source: 'http_rpc', attribute: 'shelly.device_id', value: physicalId, observedAt: old, scopeId: zone.id, method: 'GET /rpc/Shelly.GetDeviceInfo' },
        { source: 'http_rpc', attribute: 'shelly.component_status', value: component, observedAt: old, scopeId: zone.id, method: 'Switch.GetStatus?id=0' },
      ],
    }
    const candidate = {
      id: candidateId, tenantId: TEST_OWNER.tenantId, siteId: TEST_OWNER.siteId,
      displayName: `${physicalId} ${component}`, trustStatus: 'discovered', kind: 'physical',
      adapter: { protocol: 'http', driver: 'shelly-lan', target: `http://${ipAddress}/rpc/Switch.GetStatus?id=0` },
      metadata: { physicalId, component, ipAddress, networkScope: `virtual-lab-docker/192.168.1.138/eth0:${zone.id}` },
      capabilities: [{ kind: 'switch', actions: ['read'] }],
    }
    const registry = {
      getSnapshot: () => ({ tenant: { id: TEST_OWNER.tenantId }, site: { id: TEST_OWNER.siteId, name: 'Virtual Device Lab' }, devices: [] }),
      getDevices: () => [candidate],
      registerDiscoveredDevice: jest.fn(() => true),
    }
    const inventoryRecord = {
      physicalDeviceId: 'physical-virtual-shelly', scope: TEST_OWNER,
      identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      components: [{ key: component, capabilities: ['switch'], firstSeenAt: old, lastSeenAt: old }],
      assignments: [], endpoints: [], networkObservations: [], verificationStatus: 'protocol_observed',
      firstSeenAt: old, lastSeenAt: old,
    }
    const physicalInventory = {
      list: jest.fn().mockResolvedValue([]),
      discover: jest.fn().mockResolvedValue(inventoryRecord),
      refreshNetworkObservations: jest.fn().mockResolvedValue(undefined),
    }
    const virtualLabEvidence = {
      verifyShellyComponent: jest.fn().mockResolvedValue({
        identity: { id: physicalId, mac: '02:C0:DE:00:00:01', model: 'SNSW-001X16EU', app: 'Plus1', gen: 2, fw_id: 'synthetic-plus1-1.7.5', ver: '1.7.5' },
        componentKeys: [component],
        componentStatuses: [{ componentKey: component, body: componentStatus }],
        observer: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaceName: 'eth0' },
      }),
    }
    const service = new DeviceLanDiscoveryService(memory, registry as never,
      new DeviceLanNetworkEvidenceCollector(), physicalInventory as never, virtualLabEvidence as never)
    return { service, registry, physicalInventory, virtualLabEvidence, prior, candidateId, physicalId, ipAddress, zone, inventoryRecord }
  }

  it('revalidates an expired saved Shelly endpoint and persists only fresh read-only evidence', async () => {
    const fixture = selectedShellyVerifier()
    await memory.recordScan(new Date(Date.now() - 16 * 60_000).toISOString(), [fixture.prior], TEST_OWNER)
    mockReachableTcpPorts.add(80)
    mockFreshShellyRpc()

    const result = await fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER)

    expect(result).toMatchObject({ status: 'verified', physicalId: fixture.physicalId,
      physicalDeviceId: 'physical-eero-inventory', componentKeys: ['em1:0', 'em1:1', 'switch:0'] })
    expect(Date.parse(result.identityVerifiedAt)).toBeGreaterThan(Date.now() - 15 * 60_000)
    expect(fixture.physicalInventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      physicalDeviceId: 'physical-eero-inventory', scope: TEST_OWNER, evidenceSource: 'selected_device_read_only_rpc_verification',
    }))
    expect(fixture.registry.registerDiscoveredDevice).toHaveBeenCalledTimes(3)
    const saved = await memory.listIdentityEvidence(TEST_OWNER)
    expect(saved.find(item => item.device.id === fixture.physicalId)?.device.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'http_rpc', attribute: 'shelly.device_id', observedAt: result.identityVerifiedAt }),
    ]))
  })

  it('rebuilds the selected candidate from site-owned Discovery Memory after runtime candidate state is lost', async () => {
    const fixture = selectedShellyVerifier({ registerCandidate: false })
    await memory.recordScan(new Date(Date.now() - 16 * 60_000).toISOString(), [fixture.prior], TEST_OWNER)
    mockReachableTcpPorts.add(80)
    mockFreshShellyRpc()

    const result = await fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER)

    expect(result.status).toBe('verified')
    expect(result.componentKeys).toEqual(['em1:0', 'em1:1', 'switch:0'])
    expect(fixture.registry.registerDiscoveredDevice).toHaveBeenCalledTimes(3)
  })

  it('verifies the selected Virtual Lab Shelly through its configured observer and exposes fresh enrollment evidence', async () => {
    const fixture = virtualShellyVerifier()
    await memory.recordScan(fixture.prior.discoveredAt, [fixture.prior], TEST_OWNER)

    const result = await fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER)

    expect(fixture.virtualLabEvidence.verifyShellyComponent).toHaveBeenCalledWith(
      expect.objectContaining({ id: fixture.zone.id, collectionSource: 'virtual-lab' }),
      fixture.ipAddress, fixture.physicalId, ['switch:0'], expect.any(AbortSignal),
    )
    expect(result).toMatchObject({ status: 'verified', physicalId: fixture.physicalId,
      physicalDeviceId: 'physical-virtual-shelly', componentKeys: ['switch:0'] })
    expect(Date.parse(result.identityVerifiedAt)).toBeGreaterThan(Date.now() - 60_000)
    expect(fixture.physicalInventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      scope: TEST_OWNER, identity: { namespace: 'mqtt:shelly-protocol-id', value: fixture.physicalId },
      evidenceSource: 'selected_device_read_only_rpc_verification',
      components: [{ key: 'switch:0', capabilities: ['switch'] }],
    }))
    expect(fixture.registry.registerDiscoveredDevice).toHaveBeenCalledTimes(1)
    const candidate = fixture.registry.registerDiscoveredDevice.mock.calls[0][0]
    expect(candidate).toMatchObject({
      id: fixture.candidateId,
      metadata: {
        identityEvidenceSource: 'verified_site_local_shelly_rpc',
        componentEvidenceSource: 'verified_site_local_shelly_rpc',
        siteLocalObserverId: 'virtual-lab-docker/192.168.1.138/eth0',
      },
    })
    expect(candidate.capabilities).toEqual(['switch'])
    expect(candidate.metadata.verifiedMeasurementFields).toBeUndefined()
    expect(candidate.metadata.shellyMqttObservationApprovalRequired).toBe(false)
    const saved = await memory.getSnapshot(result.scanId, TEST_OWNER)
    expect(saved).toMatchObject({
      collector: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaces: ['eth0'] },
      scopes: [{ id: fixture.zone.id, collectionSource: 'virtual-lab' }],
      endpoints: [expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({ source: 'site_local_http_rpc', attribute: 'observer.identity' }),
          expect.objectContaining({ source: 'site_local_http_rpc', attribute: 'shelly.device_id', value: fixture.physicalId }),
          expect.objectContaining({ source: 'site_local_http_rpc', attribute: 'shelly.component_status', value: 'switch:0' }),
        ]),
      })],
    })
  })

  it('refreshes evidence for an existing unlinked Lab enrollment without projecting a second candidate', async () => {
    const fixture = virtualShellyVerifier()
    const candidate = fixture.registry.getDevices()[0]
    fixture.inventoryRecord.identity = { namespace: 'mac', value: '02:c0:de:00:00:01' }
    fixture.inventoryRecord.identities = [
      { namespace: 'mac', value: '02:c0:de:00:00:01' },
      { namespace: 'mqtt:shelly-protocol-id', value: fixture.physicalId },
    ]
    fixture.registry.getDevices = () => [{ ...candidate, trustStatus: 'approved', metadata: {
      ...candidate.metadata, approvedFromDiscovery: true,
    } }]
    ;(fixture.registry as any).getShellyReconciliationTargetDecision = jest.fn().mockResolvedValue({
      matched: true, device: fixture.registry.getDevices()[0],
    })
    ;(fixture.registry as any).refreshShellyVerificationEvidence = jest.fn().mockResolvedValue(fixture.registry.getDevices()[0])
    fixture.physicalInventory.list.mockResolvedValue([fixture.inventoryRecord])
    await memory.recordScan(fixture.prior.discoveredAt, [fixture.prior], TEST_OWNER)

    const result = await fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER)

    expect(result.status).toBe('verified')
    expect((fixture.registry as any).getShellyReconciliationTargetDecision).toHaveBeenCalledWith(
      TEST_OWNER.tenantId, TEST_OWNER.siteId, fixture.candidateId, fixture.physicalId, 'switch:0', 'physical-virtual-shelly',
    )
    expect((fixture.registry as any).refreshShellyVerificationEvidence).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TEST_OWNER.tenantId, siteId: TEST_OWNER.siteId, deviceId: fixture.candidateId,
      physicalId: fixture.physicalId, component: 'switch:0', physicalInventoryId: 'physical-virtual-shelly',
      observerId: 'virtual-lab-docker/192.168.1.138/eth0',
    }))
    expect(fixture.registry.registerDiscoveredDevice).not.toHaveBeenCalled()
    expect(fixture.inventoryRecord.assignments).toEqual([])
  })

  it('rejects a remote observer identity that differs from the server-resolved physical candidate', async () => {
    const fixture = virtualShellyVerifier()
    await memory.recordScan(fixture.prior.discoveredAt, [fixture.prior], TEST_OWNER)
    const savedBefore = await memory.listIdentityEvidence(TEST_OWNER)
    fixture.virtualLabEvidence.verifyShellyComponent.mockResolvedValueOnce({
      identity: { id: 'shellyplus1-other000001', mac: '02:C0:DE:00:00:01', model: 'SNSW-001X16EU',
        app: 'Plus1', gen: 2, fw_id: 'synthetic-plus1-1.7.5', ver: '1.7.5' },
      componentKeys: ['switch:0'],
      componentStatuses: [{ componentKey: 'switch:0', body: { id: 0, source: 'init', output: false } }],
      observer: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaceName: 'eth0' },
    })

    await expect(fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER))
      .rejects.toThrow(/identity mismatch.*expected shellyplus1-00c0de000001/)
    expect(fixture.physicalInventory.discover).not.toHaveBeenCalled()
    expect(fixture.registry.registerDiscoveredDevice).not.toHaveBeenCalled()
    expect(await memory.listIdentityEvidence(TEST_OWNER)).toEqual(savedBefore)
  })

  it('rejects malformed remote component status before persisting or projecting verification', async () => {
    const fixture = virtualShellyVerifier({ id: 1, source: 'init', output: false })
    await memory.recordScan(fixture.prior.discoveredAt, [fixture.prior], TEST_OWNER)
    const savedBefore = await memory.listIdentityEvidence(TEST_OWNER)

    await expect(fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER))
      .rejects.toThrow(/did not confirm switch:0/)
    expect(fixture.physicalInventory.discover).not.toHaveBeenCalled()
    expect(fixture.registry.registerDiscoveredDevice).not.toHaveBeenCalled()
    expect(await memory.listIdentityEvidence(TEST_OWNER)).toEqual(savedBefore)
  })

  it('rejects a candidate attributed to another site before remote execution', async () => {
    const fixture = virtualShellyVerifier()
    const candidate = fixture.registry.getDevices()[0]
    fixture.registry.getDevices = () => [{ ...candidate, siteId: 'site-other' }]
    await memory.recordScan(fixture.prior.discoveredAt, [fixture.prior], TEST_OWNER)

    await expect(fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER))
      .rejects.toThrow('registered under a different tenant or site')
    expect(fixture.virtualLabEvidence.verifyShellyComponent).not.toHaveBeenCalled()
    expect(fixture.physicalInventory.discover).not.toHaveBeenCalled()
    expect(fixture.registry.registerDiscoveredDevice).not.toHaveBeenCalled()
  })

  it('rejects saved evidence whose network scope is no longer configured for the site', async () => {
    const fixture = virtualShellyVerifier()
    fixture.prior.networkZoneId = 'unapproved-lab-scope'
    await memory.recordScan(fixture.prior.discoveredAt, [fixture.prior], TEST_OWNER)

    await expect(fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER))
      .rejects.toThrow('saved endpoint is no longer inside an authorized network scope')
    expect(fixture.virtualLabEvidence.verifyShellyComponent).not.toHaveBeenCalled()
    expect(fixture.physicalInventory.discover).not.toHaveBeenCalled()
    expect(fixture.registry.registerDiscoveredDevice).not.toHaveBeenCalled()
  })

  it('recovers an inventory write failure on retry without enrollment, authority grants, or duplicate inventory', async () => {
    const fixture = virtualShellyVerifier()
    await memory.recordScan(fixture.prior.discoveredAt, [fixture.prior], TEST_OWNER)

    const recordsByIdentity = new Map<string, typeof fixture.inventoryRecord>()
    let failFirstInventoryWrite = true
    fixture.physicalInventory.list.mockImplementation(async () => [...recordsByIdentity.values()])
    fixture.physicalInventory.discover.mockImplementation(async input => {
      if (failFirstInventoryWrite) {
        failFirstInventoryWrite = false
        throw new Error('Physical inventory persistence unavailable')
      }
      const key = `${input.scope.tenantId}/${input.scope.siteId}/${input.identity.namespace}/${input.identity.value}`
      const existing = recordsByIdentity.get(key)
      if (existing) return existing
      recordsByIdentity.set(key, fixture.inventoryRecord)
      return fixture.inventoryRecord
    })

    await expect(fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER))
      .rejects.toThrow('Physical inventory persistence unavailable')

    const afterFailure = await memory.listSnapshots(TEST_OWNER)
    expect(afterFailure).toHaveLength(1)
    expect(afterFailure[0].endpoints[0]).toMatchObject({ id: fixture.physicalId, components: [{ component: 'switch:0', channel: 0 }] })
    expect(recordsByIdentity.size).toBe(0)
    expect(fixture.registry.registerDiscoveredDevice).not.toHaveBeenCalled()
    expect(fixture.registry.getDevices()[0].trustStatus).toBe('discovered')

    const retry = await fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER)

    expect(retry).toMatchObject({ status: 'verified', physicalId: fixture.physicalId, componentKeys: ['switch:0'] })
    expect(fixture.physicalInventory.discover).toHaveBeenCalledTimes(2)
    expect(recordsByIdentity.size).toBe(1)
    expect([...recordsByIdentity.values()][0]).toBe(fixture.inventoryRecord)
    expect(fixture.registry.registerDiscoveredDevice).toHaveBeenCalledTimes(1)
    const candidate = fixture.registry.registerDiscoveredDevice.mock.calls[0][0]
    expect(candidate).toMatchObject({ id: fixture.candidateId, capabilities: ['switch'] })
    expect(candidate.metadata.verifiedMeasurementFields).toBeUndefined()
    expect(candidate.metadata.shellyMqttObservationApprovalRequired).toBe(false)
    expect(candidate).not.toHaveProperty('measurementAuthority')
    expect(candidate).not.toHaveProperty('controlAuthority')
    expect(candidate).not.toHaveProperty('control')
    expect(fixture.inventoryRecord.assignments).toEqual([])
    expect(fixture.registry.getDevices()[0].trustStatus).toBe('discovered')
    expect(await memory.listSnapshots(TEST_OWNER)).toHaveLength(2)
  })

  it.each([
    ['plain Shelly Plus 1', { id: 0, source: 'init', output: false }, []],
    ['reported electrical measurements', {
      id: 0, output: false, apower: 0, aenergy: { total: 120.5 }, ret_aenergy: { total: 2.25 },
    }, ['switch:0:power', 'switch:0:energy_import_total', 'switch:0:energy_export_total']],
  ])('projects identical %s status evidence through local and remote paths', async (_name, status, expectedCapabilities) => {
    const componentStatus = status as Record<string, unknown>
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: [{ key: 'switch:0' }], total: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => componentStatus }) as unknown as typeof fetch
    const local = await probeShellyComponentsWithEvidence('192.168.1.220', 'home-lan', 'en0')

    const fixture = virtualShellyVerifier(componentStatus)
    await memory.recordScan(fixture.prior.discoveredAt, [fixture.prior], TEST_OWNER)
    const result = await fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER)
    const remote = await memory.getSnapshot(result.scanId, TEST_OWNER)
    const localProjection = {
      components: local.components,
      capabilities: local.observations.filter(item => item.attribute === 'shelly.measurement_capability').map(item => item.value).sort(),
    }
    const remoteDevice = remote?.endpoints[0]
    const remoteProjection = {
      components: remoteDevice?.components,
      capabilities: remoteDevice?.observations
        ?.filter(item => item.attribute === 'shelly.measurement_capability').map(item => item.value).sort(),
    }

    expect(localProjection).toEqual({
      components: [{ component: 'switch:0', channel: 0 }],
      capabilities: (expectedCapabilities as string[]).slice().sort(),
    })
    expect(remoteProjection).toEqual(localProjection)
  })

  it('reports an unreachable saved endpoint without issuing RPC or persisting verification', async () => {
    const fixture = selectedShellyVerifier()
    await memory.recordScan(new Date(Date.now() - 16 * 60_000).toISOString(), [fixture.prior], TEST_OWNER)
    mockHangTcpConnections = true

    await expect(fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER))
      .rejects.toThrow(/timed out after 1500 ms/)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(fixture.physicalInventory.discover).not.toHaveBeenCalled()
  })

  it('rejects a fresh RPC hardware identity mismatch before writing evidence', async () => {
    const fixture = selectedShellyVerifier()
    await memory.recordScan(new Date(Date.now() - 16 * 60_000).toISOString(), [fixture.prior], TEST_OWNER)
    mockReachableTcpPorts.add(80)
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
      id: 'shellyproem50-other', mac: '8C:4F:00:00:00:00', model: 'SPEM-50', gen: 2,
    }) }) as unknown as typeof fetch

    await expect(fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER))
      .rejects.toThrow(/identity mismatch/)
    expect(fixture.physicalInventory.discover).not.toHaveBeenCalled()
    expect(fixture.registry.registerDiscoveredDevice).not.toHaveBeenCalled()
  })

  it('rejects a component profile mismatch without refreshing the candidate', async () => {
    const fixture = selectedShellyVerifier()
    await memory.recordScan(new Date(Date.now() - 16 * 60_000).toISOString(), [fixture.prior], TEST_OWNER)
    mockReachableTcpPorts.add(80)
    mockFreshShellyRpc(['em1:0', 'switch:0'])

    await expect(fixture.service.verifyShellyCandidate(fixture.candidateId, TEST_OWNER))
      .rejects.toThrow(/component profile mismatch.*em1:1/)
    expect(fixture.physicalInventory.discover).not.toHaveBeenCalled()
    expect(fixture.registry.registerDiscoveredDevice).not.toHaveBeenCalled()
  })

  it('bounds a TCP connect attempt when the OS leaves it pending without a response', async () => {
    mockHangTcpConnections = true

    await expect(tcpPortOpen('192.168.7.48', 80, 10)).resolves.toBe(false)
  })

  it('records Shelly power capability only when the read-only component status confirms a numeric value', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: [{ key: 'switch:0' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, output: false, apower: 18.5 }) }) as unknown as typeof fetch

    const result = await probeShellyComponentsWithEvidence('192.168.1.220', 'upstream-lan', 'en0')

    expect(result.components).toEqual([{ component: 'switch:0', channel: 0 }])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'http_rpc', attribute: 'shelly.measurement_capability', value: 'switch:0:power',
        scopeId: 'upstream-lan', interfaceName: 'en0', method: 'Switch.GetStatus?id=0',
        observedAt: expect.any(String),
      }),
    ]))
  })

  it('does not infer Shelly power capability from a component or its model without status evidence', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: [{ key: 'switch:0' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, output: false }) }) as unknown as typeof fetch

    const result = await probeShellyComponentsWithEvidence('192.168.1.220', 'upstream-lan', 'en0')

    expect(result.components).toEqual([{ component: 'switch:0', channel: 0 }])
    expect(result.observations.some(item => item.attribute === 'shelly.measurement_capability')).toBe(false)
  })

  afterEach(async () => {
    await memory.onModuleDestroy()
    await rm(directory, { recursive: true, force: true })
    process.env = originalEnv
    global.fetch = originalFetch
    mockReachableTcpPorts = new Set()
    jest.restoreAllMocks()
  })

  it('confirms Shelly switch channels with read-only RPC and preserves actual power and energy evidence', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: [
        { key: 'switch:0' }, { key: 'switch:1' },
      ], total: 2 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, output: false, apower: 1150, voltage: 234.8, current: 4.9, aenergy: { total: 600 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1, output: true, apower: 320, voltage: 234.8, current: 1.4, aenergy: { total: 120 } }) }) as unknown as typeof fetch
    const result = await probeShellyComponentsWithEvidence('192.168.1.166', 'home-lan', 'eth0')
    expect(result.components).toEqual([{ component: 'switch:0', channel: 0 }, { component: 'switch:1', channel: 1 }])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'http_rpc', attribute: 'shelly.component_status', value: 'switch:0', method: 'Switch.GetStatus?id=0' }),
      expect.objectContaining({ source: 'http_rpc', attribute: 'shelly.measurement_capability', value: 'switch:0:power' }),
      expect.objectContaining({ source: 'http_rpc', attribute: 'shelly.measurement_capability', value: 'switch:0:energy_import_total' }),
      expect.objectContaining({ source: 'http_rpc', attribute: 'shelly.measurement_capability', value: 'switch:1:power' }),
    ]))
    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(global.fetch).toHaveBeenNthCalledWith(2, 'http://192.168.1.166/rpc/Switch.GetStatus?id=0', expect.objectContaining({ method: 'GET', redirect: 'error' }))
  })

  it('requires explicit confirmation before a configured subnet scan and writes nothing before confirmation', async () => {
    const service = new DeviceLanDiscoveryService(memory, TEST_REGISTRY, new DeviceLanNetworkEvidenceCollector())

    await expect(service.scanNow()).rejects.toThrow('explicit operator confirmation')
    expect(await memory.listSnapshots(TEST_OWNER)).toEqual([])
    expect(await memory.listIdentityEvidence(TEST_OWNER)).toEqual([])
  })

  it('does not treat discovered interface scopes as configured or authorized scan scopes', async () => {
    delete process.env.HOME_NETWORK_ZONES_JSON
    delete process.env.HOME_LAN_SCAN_SUBNETS
    const service = new DeviceLanDiscoveryService(memory, TEST_REGISTRY, new DeviceLanNetworkEvidenceCollector())

    expect(service.getZones()).toEqual([])
    await expect(service.scanNow()).rejects.toThrow('No network scan scopes are configured')
    expect(await memory.listSnapshots(TEST_OWNER)).toEqual([])
  })

  it('verifies Energrid firmware identity from a bounded HTTP host and scopes its evidence', async () => {
    mockReachableTcpPorts = new Set([80])
    const transport: EnergridIdentityTransport = {
      get: jest.fn().mockResolvedValue({
        schemaVersion: 1, id: 'esp8266:324864', model: 'Energrid ESP8266 DHT22',
        firmwareVersion: '0.2.0', capabilities: ['temperature', 'humidity'],
      }),
    }
    const identityAdapter = new EnergridHttpIdentityAdapter(transport)
    const collector = new DeviceLanNetworkEvidenceCollector(undefined, undefined, identityAdapter)
    const device = await collector.enrichCandidate({
      ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan', networkZoneName: 'Upstream LAN',
      status: 'online', reason: 'Host responded to an active ICMP probe.',
    }, '2026-10-23T12:00:00.000Z', true)

    expect(transport.get).toHaveBeenCalledWith('192.168.1.198', 2_000, 4_096)
    expect(device).toMatchObject({
      id: 'esp8266:324864', vendor: 'Energrid', model: 'Energrid ESP8266 DHT22',
      firmwareVersion: '0.2.0', protocol: 'http', status: 'online',
    })
    expect(device.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'http_identity', attribute: 'identity.verified', value: true, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' }),
      expect.objectContaining({ source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864' }),
      expect.objectContaining({ source: 'http_identity', attribute: 'device.capability', value: 'temperature' }),
      expect.objectContaining({ source: 'http_identity', attribute: 'device.capability', value: 'humidity' }),
    ]))
  })

  it('does not enrich a router-reported address outside the configured CIDR even when it carries the zone label', async () => {
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([{
      ipAddress: '10.42.1.9', networkZoneId: 'home-lan', networkZoneName: 'Home LAN',
    }])
    mockReachableTcpPorts = new Set([80])
    const transport: EnergridIdentityTransport = {
      get: jest.fn().mockResolvedValue({
        schemaVersion: 1, id: 'esp8266:324864', model: 'Energrid ESP8266 DHT22',
        firmwareVersion: '0.2.0', capabilities: ['temperature', 'humidity'],
      }),
    }
    const service = new DeviceLanDiscoveryService(
      memory, TEST_REGISTRY,
      new DeviceLanNetworkEvidenceCollector(undefined, undefined, new EnergridHttpIdentityAdapter(transport)),
    )

    await service.scanNow({ fullSubnetConfirmed: true })

    expect(transport.get).not.toHaveBeenCalled()
  })

  it('scans only selected scopes and discards router evidence that belongs to another configured scope', async () => {
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [
      { id: 'eero', name: 'Eero', cidr: '192.168.7.0/24' },
      { id: 'housenet', name: 'HouseNet', cidr: '192.168.1.0/24' },
    ] })
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([{
      ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0a',
    }])
    const service = new DeviceLanDiscoveryService(memory, TEST_REGISTRY, new DeviceLanNetworkEvidenceCollector())

    const result = await service.scanNow({ scopeIds: ['eero'], fullSubnetConfirmed: true })

    expect(result.zones.map(zone => zone.id)).toEqual(['eero'])
    expect(result.devices).toEqual([])
    expect(result.snapshot.scopes.map(scope => scope.id)).toEqual(['eero'])
    expect(await memory.listSnapshots(TEST_OWNER)).toHaveLength(1)
  })

  it('persists fixed-target Virtual Lab results through Discovery Memory without local probing or physical inventory writes', async () => {
    process.env.HOME_VIRTUAL_LAB_ENABLED = 'true'
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [{
      id: 'device-lab-vlan', name: 'Virtual Lab LAN', cidr: '172.30.250.0/28',
      interfaceName: 'eth0', seedIps: ['172.30.250.10', '172.30.250.11'],
      collectionSource: 'virtual-lab', role: 'service',
    }] })
    const identities = [
      { ipAddress: '172.30.250.10', id: 'esp8266:a1b2c3', macAddress: '5e:24:06:c6:81:59', deviceReportedMacAddress: undefined, protocol: 'http' as const, vendor: 'Energrid' },
      { ipAddress: '172.30.250.11', id: 'shellyplus1-00c0de000001', macAddress: '56:73:18:cd:7a:d9', deviceReportedMacAddress: '02:c0:de:00:00:01', protocol: 'http' as const, vendor: 'Shelly' },
    ]
    const devices: NetworkDiscoveredDevice[] = identities.map(item => ({
      ...item, networkZoneId: 'device-lab-vlan', networkZoneName: 'Virtual Lab LAN',
      confidence: 0.95, status: 'online', discoveredAt: '2026-10-25T10:00:00.000Z',
      reason: 'The simulated device returned a matching read-only protocol identity.',
      observations: item.id.startsWith('esp8266:') ? [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: '2026-10-25T10:00:00.000Z', scopeId: 'device-lab-vlan', method: 'GET /api/v1/identity' },
        { source: 'http_identity', attribute: 'identity.device_id', value: item.id, observedAt: '2026-10-25T10:00:00.000Z', scopeId: 'device-lab-vlan', method: 'GET /api/v1/identity' },
      ] : [
        { source: 'http_rpc', attribute: 'shelly.device_id', value: item.id, observedAt: '2026-10-25T10:00:00.000Z', scopeId: 'device-lab-vlan', method: 'Shelly.GetDeviceInfo' },
      ],
    }))
    const virtualLab = {
      scan: jest.fn().mockResolvedValue({
        devices,
        candidates: devices.map(device => ({
          ipAddress: device.ipAddress, macAddress: device.macAddress,
          deviceReportedMacAddress: device.deviceReportedMacAddress,
          networkZoneId: device.networkZoneId, networkZoneName: device.networkZoneName,
          evidenceSource: 'nmap', observedAt: device.discoveredAt,
        })),
        nmap: {
          capability: { available: true, version: '7.93' }, hosts: [],
          scopes: [{ scopeId: 'device-lab-vlan', complete: true, targetCount: 2, hostsReported: 2,
            hostDiscovery: { durationMs: 12, complete: true, targetCount: 2, hostsReported: 2 },
            serviceEnrichment: { durationMs: 31, complete: true, targetCount: 2, hostsReported: 2 } }],
          methods: ['nmap_host_discovery', 'nmap_tcp_connect_service_scan'], failures: [], limitations: [], cancelled: false,
        },
        collector: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaces: ['eth0'] },
      }),
    } as unknown as VirtualLabNetworkEvidenceAdapter
    const localCollector = new DeviceLanNetworkEvidenceCollector()
    const localScan = jest.spyOn(localCollector, 'collectEvidence')
    const physicalInventory = { discover: jest.fn(), refreshNetworkObservations: jest.fn() }
    const service = new DeviceLanDiscoveryService(
      memory, TEST_REGISTRY, localCollector, physicalInventory as never, virtualLab,
    )

    const result = await service.scanNow({ scopeIds: ['device-lab-vlan'], fullSubnetConfirmed: true })
    const saved = await memory.getSnapshot(result.snapshot.scanId, TEST_OWNER)
    const historicalEvidence = await memory.listIdentityEvidence(TEST_OWNER)

    expect(virtualLab.scan).toHaveBeenCalledWith(expect.objectContaining({
      id: 'device-lab-vlan', collectionSource: 'virtual-lab', seedIps: ['172.30.250.10', '172.30.250.11'],
    }), undefined)
    expect(localScan).not.toHaveBeenCalled()
    expect(result.devices.map(device => device.id)).toEqual(['esp8266:a1b2c3', 'shellyplus1-00c0de000001'])
    expect(saved?.collector).toEqual({ id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaces: ['eth0'] })
    expect(saved?.scopes[0]).toMatchObject({ collectionSource: 'virtual-lab', complete: true, cidr: '172.30.250.0/28' })
    expect(saved?.endpoints.find(item => item.id.startsWith('shelly'))).toMatchObject({
      ipAddress: '172.30.250.11', macAddress: '56:73:18:cd:7a:d9', deviceReportedMacAddress: '02:c0:de:00:00:01',
    })
    expect(historicalEvidence.map(record => record.device.id).sort()).toEqual(['esp8266:a1b2c3', 'shellyplus1-00c0de000001'])
    expect(physicalInventory.discover).not.toHaveBeenCalled()
    expect(physicalInventory.refreshNetworkObservations).not.toHaveBeenCalled()
  })

  it('binds a snapshot to the server-authorized site captured before asynchronous collection', async () => {
    process.env.HOME_VIRTUAL_LAB_ENABLED = 'true'
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [{
      id: 'device-lab-vlan', name: 'Virtual Lab LAN', cidr: '172.30.250.0/28',
      seedIps: ['172.30.250.10'], collectionSource: 'virtual-lab',
    }] })
    let activeOwner = { tenant: { id: 'tenant-demo' }, site: { id: 'site-home', name: 'Home' } }
    const registry = { getSnapshot: jest.fn(() => activeOwner) }
    const virtualLab = {
      scan: jest.fn(async () => {
        activeOwner = { tenant: { id: 'tenant-demo' }, site: { id: 'site-virtual-lab', name: 'Virtual Lab' } }
        return {
          devices: [], candidates: [], collector: { id: 'lab', host: 'lab', interfaces: ['eth0'] },
          nmap: { capability: { available: true }, hosts: [], scopes: [], methods: [], failures: [], limitations: [], cancelled: false },
        }
      }),
    } as unknown as VirtualLabNetworkEvidenceAdapter
    const service = new DeviceLanDiscoveryService(memory, registry as never, new DeviceLanNetworkEvidenceCollector(), undefined, virtualLab)

    const result = await service.scanNow({ scopeIds: ['device-lab-vlan'], fullSubnetConfirmed: true })

    expect(result.snapshot.ownership).toEqual(TEST_OWNER)
    expect(await memory.getSnapshot(result.snapshot.scanId, TEST_OWNER)).toMatchObject({ ownership: TEST_OWNER })
    expect(await memory.getSnapshot(result.snapshot.scanId, { tenantId: 'tenant-demo', siteId: 'site-virtual-lab' })).toBeNull()
  })

  it('does not expose the Virtual Lab scope unless it is explicitly enabled', () => {
    process.env.HOME_VIRTUAL_LAB_ENABLED = 'false'
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [{
      id: 'device-lab-vlan', name: 'Virtual Lab LAN', cidr: '172.30.250.0/28',
      seedIps: ['172.30.250.10', '172.30.250.11'], collectionSource: 'virtual-lab',
    }] })
    expect(new DeviceLanDiscoveryService(memory, TEST_REGISTRY, new DeviceLanNetworkEvidenceCollector()).getZones()).toEqual([])
  })

  it('persists Nmap observations and services through the existing immutable snapshot store', async () => {
    process.env.HOME_NMAP_ENABLED = 'true'
    process.env.HOME_LAN_ACTIVE_SCAN_ENABLED = 'true'
    jest.mocked(execFile).mockClear()
    const hostXml = `<nmaprun><host endtime="1792560001"><status state="up"/><address addr="192.168.1.133" addrtype="ipv4"/></host><runstats><finished exit="success"/><hosts up="1" down="253" total="254"/></runstats></nmaprun>`
    const serviceXml = `<nmaprun><host endtime="1792560002"><status state="up"/><address addr="192.168.1.133" addrtype="ipv4"/><ports><port protocol="tcp" portid="80"><state state="open"/><service name="http"/></port></ports></host><runstats><finished exit="success"/><hosts up="1" down="0" total="1"/></runstats></nmaprun>`
    const runner: NmapCommandRunner = async (_command, args) => ({
      stdout: args[0] === '--version' ? 'Nmap version 7.95' : args.includes('-sn') ? hostXml : serviceXml,
      stderr: '',
    })
    const adapter = new NmapNetworkEvidenceAdapter(runner, () => ({}), () => new Date('2026-10-21T00:00:00.000Z'))
    const service = new DeviceLanDiscoveryService(
      memory,
      TEST_REGISTRY,
      new DeviceLanNetworkEvidenceCollector(adapter),
    )

    const result = await service.scanNow({ fullSubnetConfirmed: true })
    const saved = await memory.getSnapshot(result.snapshot.scanId, TEST_OWNER)
    const identityRecords = await memory.listIdentityEvidence(TEST_OWNER)
    const endpoint = saved?.endpoints.find(item => item.ipAddress === '192.168.1.133')

    expect(result.snapshot.methods).toContain('nmap_tcp_connect_service_scan')
    expect(result.snapshot.methods).toContain('nmap_host_discovery')
    expect(result.snapshot.schemaVersion).toBe(2)
    expect(result.snapshot.methods).not.toContain('icmp')
    expect(result.snapshot.methods).not.toContain('tcp_reachability')
    expect(jest.mocked(execFile).mock.calls.filter(([command]) => command === 'ping')).toHaveLength(0)
    expect(result.snapshot.scopes[0]).toMatchObject({
      id: 'home-lan', complete: true,
      collectionStages: {
        hostDiscovery: { complete: true, targetCount: 254, hostsReported: 1 },
        serviceEnrichment: { complete: true, targetCount: 1, hostsReported: 1 },
      },
    })
    expect(result.snapshot.scopes[0].collectionStages?.hostDiscovery.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.snapshot.scopes[0].collectionStages?.serviceEnrichment.durationMs).toBeGreaterThanOrEqual(0)
    expect(endpoint?.observations).toContainEqual(expect.objectContaining({
      source: 'tcp', attribute: 'port.80.open', value: true, scopeId: 'home-lan',
      method: 'nmap_tcp_connect_service_scan', observedAt: '2026-10-21T05:20:02.000Z',
    }))
    expect(identityRecords.flatMap(record => record.device.observations || [])).not.toContainEqual(
      expect.objectContaining({ method: 'nmap_tcp_connect_service_scan' }),
    )
    expect(saved?.rawEvidence).toContainEqual(expect.objectContaining({
      source: 'nmap', scopeId: 'home-lan',
      evidence: expect.objectContaining({ observations: expect.arrayContaining([expect.objectContaining({ method: 'nmap_tcp_connect_service_scan' })]) }),
    }))
  })

  it('persists normalized local observer capabilities in a version 2 immutable snapshot', async () => {
    process.env.HOME_NMAP_ENABLED = 'false'
    const runner: NmapCommandRunner = async () => ({ stdout: 'Nmap version 7.95', stderr: '' })
    const runtime: LocalNetworkRuntimeReport = {
      observedAt: '2026-10-21T00:00:00.000Z',
      observer: { id: 'test-observer/linux', host: 'test-observer', platform: 'linux' },
      interfaces: [{ name: 'eth0', internal: false, addresses: [{ family: 'IPv4', address: '10.42.6.35', netmask: '255.255.255.192', prefixLength: 26, cidr: '10.42.6.0/26' }] }],
      routes: [{ destination: '10.42.6.0/26', family: 'IPv4', interfaceName: 'eth0', evidence: 'ip_route_table' }],
      localScopes: [{ cidr: '10.42.6.0/26', interfaceName: 'eth0' }],
      configuredScopes: [{ id: 'eth0-local', name: 'Local', cidr: '10.42.6.0/26', interfaceName: 'eth0', reachability: 'on_link', boundedScanEligible: true, reason: 'Direct route.' }],
      capabilities: [], limitations: [],
    }
    const runtimeAdapter = { inspect: jest.fn().mockResolvedValue(runtime) } as unknown as LocalNetworkRuntimeAdapter
    const collector = new DeviceLanNetworkEvidenceCollector(
      new NmapNetworkEvidenceAdapter(runner),
      runtimeAdapter,
    )
    const service = new DeviceLanDiscoveryService(memory, TEST_REGISTRY, collector)

    const result = await service.scanNow({ scopeIds: ['home-lan'], fullSubnetConfirmed: true })
    const saved = await memory.getSnapshot(result.snapshot.scanId, TEST_OWNER)

    expect(result.snapshot.schemaVersion).toBe(2)
    expect(saved?.runtime).toMatchObject({ observer: runtime.observer, localScopes: runtime.localScopes })
    expect(saved?.runtime?.capabilities.map(capability => capability.id)).toEqual(expect.arrayContaining(['nmap', 'active_probing']))
  })

  it('persists each same-scan MAC identity before projecting the ambiguous endpoint', async () => {
    const service = new DeviceLanDiscoveryService(
      memory,
      TEST_REGISTRY,
      new DeviceLanNetworkEvidenceCollector(),
    )

    const result = await service.scanNow({ fullSubnetConfirmed: true })
    const identityRecords = await memory.listIdentityEvidence(TEST_OWNER)
    const endpointRecords = await memory.list(TEST_OWNER)
    const savedSnapshot = await memory.getSnapshot(result.snapshot.scanId, TEST_OWNER)
    expect(savedSnapshot).toEqual(result.snapshot)
    expect(savedSnapshot?.rawEvidence.length).toBeGreaterThan(0)
    expect(savedSnapshot?.rawEvidence.length).toBeLessThanOrEqual(2048)
    const byMac = new Map(identityRecords.map(record => [record.device.macAddress, record.device]))

    expect(identityRecords).toHaveLength(2)
    expect(byMac.get('02:00:00:00:00:0a')).toMatchObject({
      vendor: 'Acme A', model: 'Sensor A', firmwareVersion: '1.2.3',
      protocol: 'mqtt', deviceReportedMacAddress: '02:00:00:00:00:aa',
      components: [{ component: 'temperature:0', channel: 0 }],
    })
    expect(byMac.get('02:00:00:00:00:0b')).toMatchObject({
      vendor: 'Acme B', model: 'Relay B', firmwareVersion: '4.5.6',
      protocol: 'http', deviceReportedMacAddress: '02:00:00:00:00:0b',
      components: [{ component: 'switch:0', channel: 0 }],
    })
    expect(result.devices).toHaveLength(1)
    expect(result.devices[0]).toMatchObject({
      ipAddress: '192.168.1.133',
      identityConflict: {
        reason: 'multiple_macs_for_endpoint',
        macAddresses: ['02:00:00:00:00:0a', '02:00:00:00:00:0b'],
      },
      endpoints: [
        { ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0a' },
        { ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0b' },
      ],
    })
    expect(result.devices[0]).not.toHaveProperty('macAddress')
    expect(result.devices[0]).not.toHaveProperty('components')
    expect(result.devices[0]).not.toHaveProperty('model')
    expect(endpointRecords).toHaveLength(1)
    expect(endpointRecords[0].device).toMatchObject({
      identityConflict: {
        reason: 'multiple_macs_for_endpoint',
        macAddresses: ['02:00:00:00:00:0a', '02:00:00:00:00:0b'],
      },
    })
    expect(endpointRecords[0].device).not.toHaveProperty('components')
    expect(endpointRecords[0].device).not.toHaveProperty('model')
  })

  it('deduplicates repeated hardware, retains DHCP history, and uses only the current endpoint identity', async () => {
    const service = new DeviceLanDiscoveryService(memory, TEST_REGISTRY, new DeviceLanNetworkEvidenceCollector())
    await service.scanNow({ fullSubnetConfirmed: true })

    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([
      {
        ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0a',
        vendor: 'Acme A', model: 'Sensor A', firmwareVersion: '1.2.3',
        components: [{ component: 'temperature:0', channel: 0 }],
      },
      {
        ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0a',
        vendor: 'Acme A', model: 'Sensor A', firmwareVersion: '1.2.3',
        components: [{ component: 'humidity:0', channel: 0 }],
      },
    ])
    const repeatedIdentityScan = await service.scanNow({ fullSubnetConfirmed: true })
    let records = await memory.listIdentityEvidence(TEST_OWNER)
    const identityA = records.find(record => record.device.macAddress === '02:00:00:00:00:0a')!
    expect(records).toHaveLength(2)
    expect(identityA.device.components).toEqual([
      { component: 'temperature:0', channel: 0 },
      { component: 'humidity:0', channel: 0 },
    ])
    expect(repeatedIdentityScan.devices).toHaveLength(1)
    expect(repeatedIdentityScan.devices[0].identityConflict).toBeUndefined()

    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([{
      ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0b',
      vendor: 'Acme B', model: 'Relay B', firmwareVersion: '4.5.6',
      components: [{ component: 'switch:0', channel: 0 }],
    }])
    const reusedAddressScan = await service.scanNow({ fullSubnetConfirmed: true })
    records = await memory.listIdentityEvidence(TEST_OWNER)
    expect(records).toHaveLength(2)
    expect(records.find(record => record.device.macAddress === '02:00:00:00:00:0a')?.device)
      .toMatchObject({ model: 'Sensor A', firmwareVersion: '1.2.3' })
    expect(reusedAddressScan.devices).toHaveLength(1)
    expect(reusedAddressScan.devices[0]).toMatchObject({
      macAddress: '02:00:00:00:00:0b', model: 'Relay B',
    })
    expect(reusedAddressScan.devices[0].identityConflict).toBeUndefined()
    expect(reusedAddressScan.comparison?.ipReuse).toContainEqual(expect.objectContaining({
      scopeId: 'home-lan', ipAddress: '192.168.1.133',
    }))
  })

  it('keeps the same address isolated across configured network scopes', async () => {
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [
      { id: 'home-lan', name: 'Home LAN', cidr: '192.168.1.0/24' },
      { id: 'guest-lan', name: 'Guest LAN', cidr: '192.168.1.0/24' },
    ] })
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([
      {
        ipAddress: '192.168.1.133', networkZoneId: 'home-lan', networkZoneName: 'Home LAN',
        macAddress: '02:00:00:00:00:0a', vendor: 'Acme A', model: 'Sensor A',
      },
      {
        ipAddress: '192.168.1.133', networkZoneId: 'guest-lan', networkZoneName: 'Guest LAN',
        macAddress: '02:00:00:00:00:0b', vendor: 'Acme B', model: 'Relay B',
      },
    ])

    const service = new DeviceLanDiscoveryService(memory, TEST_REGISTRY, new DeviceLanNetworkEvidenceCollector())
    const result = await service.scanNow({ fullSubnetConfirmed: true })
    const records = await memory.listIdentityEvidence(TEST_OWNER)

    expect(records).toHaveLength(2)
    expect(new Set(records.map(record => record.device.networkZoneId)))
      .toEqual(new Set(['home-lan', 'guest-lan']))
    expect(result.devices).toHaveLength(2)
    expect(result.devices.every(device => !device.identityConflict)).toBe(true)
  })

  it('records exact Shelly RPC identity and both ProEM components without approval', async () => {
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([{
      ipAddress: '192.168.1.204',
      macAddress: '08:F9:E0:E8:49:13',
      vendor: 'Shelly',
    }])
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        id: 'shellyproem50-08f9e0e84910',
        mac: '08:F9:E0:E8:49:10',
        model: 'SPEM-002CEBEU50',
        gen: 2,
        app: 'ProEM',
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        components: [{ key: 'em1:0' }, { key: 'em1:1' }],
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, act_power: 42 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1, act_power: 84 }) }) as unknown as typeof fetch
    const registry = {
      getSnapshot: jest.fn(() => ({ tenant: { id: 'tenant-test' }, site: { id: 'site-test' } })),
      registerDiscoveredDevice: jest.fn(),
      approveDiscoveredDevice: jest.fn(),
    }
    const inventory = {
      discover: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-proem' }),
      refreshNetworkObservations: jest.fn().mockResolvedValue(undefined),
    }
    const service = new DeviceLanDiscoveryService(
      memory, registry as never, new DeviceLanNetworkEvidenceCollector(), inventory as never,
    )

    const result = await service.scanNow({ fullSubnetConfirmed: true })

    expect(result.devices).toHaveLength(1)
    expect(result.devices[0]).toMatchObject({
      id: 'shellyproem50-08f9e0e84910',
      ipAddress: '192.168.1.204',
      macAddress: '08:f9:e0:e8:49:13',
      deviceReportedMacAddress: '08:f9:e0:e8:49:10',
      components: [{ component: 'em1:0' }, { component: 'em1:1' }],
    })
    expect(inventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 'tenant-test', siteId: 'site-test' },
      identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyproem50-08f9e0e84910' },
      evidenceSource: 'lan_discovery_protocol_identity',
      components: [
        { key: 'em1:0', capabilities: ['power'] },
        { key: 'em1:1', capabilities: ['power'] },
      ],
    }))
    expect(inventory.refreshNetworkObservations).toHaveBeenCalledWith(
      { tenantId: 'tenant-test', siteId: 'site-test' },
      [expect.objectContaining({
        physicalDeviceId: 'physical-proem',
        ipAddress: '192.168.1.204',
        macAddress: '08:f9:e0:e8:49:13',
        networkScope: 'gateway-unknown:home-lan',
        evidenceSource: 'lan_discovery_protocol_match',
      })],
    )
    expect(registry.approveDiscoveredDevice).not.toHaveBeenCalled()
    expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled()
  })

  it('discovers and timestamps a Gen2 switch only after its component RPC confirms it', async () => {
    process.env.HOME_NMAP_ENABLED = 'false'
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([{
      ipAddress: '192.168.1.220',
      macAddress: '88:13:bf:cd:c8:bc',
    }])
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        id: 'shellyplus1-8813bfcdc8bc', gen: 2, app: 'Plus1', model: 'SNSW-001X16EU',
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ components: [
        { key: 'switch:0', status: { id: 0 } },
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, output: false }) }) as unknown as typeof fetch
    const registry = {
      getSnapshot: jest.fn(() => ({ tenant: { id: 'tenant-test' }, site: { id: 'site-test' } })),
    }
    const inventory = {
      discover: jest.fn().mockResolvedValue({ physicalDeviceId: 'physical-plus1' }),
      refreshNetworkObservations: jest.fn().mockResolvedValue(undefined),
    }
    const service = new DeviceLanDiscoveryService(
      memory, registry as never, new DeviceLanNetworkEvidenceCollector(), inventory as never,
    )

    const result = await service.scanNow({ scopeIds: ['home-lan'], fullSubnetConfirmed: true })
    const shelly = result.devices.find(device => device.id === 'shellyplus1-8813bfcdc8bc')!
    const candidate = shellyLanCandidates(shelly)
    const componentObservation = shelly.observations?.find(item =>
      item.attribute === 'shelly.component_status' && item.value === 'switch:0',
    )

    expect(shelly).toMatchObject({
      id: 'shellyplus1-8813bfcdc8bc',
      ipAddress: '192.168.1.220',
      macAddress: '88:13:bf:cd:c8:bc',
      vendor: 'Shelly',
      generation: 2,
      model: 'SNSW-001X16EU',
      app: 'Plus1',
      components: [{ component: 'switch:0', channel: 0 }],
    })
    expect(componentObservation).toEqual(expect.objectContaining({
      source: 'http_rpc', value: 'switch:0', scopeId: 'home-lan',
      method: 'Switch.GetStatus?id=0', observedAt: expect.any(String),
    }))
    expect(Date.parse(componentObservation!.observedAt)).not.toBeNaN()
    expect(result.snapshot.rawEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'shelly_http_rpc',
        evidence: expect.objectContaining({
          protocolId: 'shellyplus1-8813bfcdc8bc',
          observations: expect.arrayContaining([expect.objectContaining({
            attribute: 'shelly.component_status',
            value: 'switch:0',
            method: 'Switch.GetStatus?id=0',
            observedAt: componentObservation!.observedAt,
          })]),
        }),
      }),
    ]))
    const identityHistory = await memory.listIdentityEvidence(TEST_DEVICE_OWNER)
    expect(identityHistory.find(record => record.device.id === 'shellyplus1-8813bfcdc8bc')?.device.observations)
      .toContainEqual(expect.objectContaining({
        attribute: 'shelly.component_status', value: 'switch:0', observedAt: componentObservation!.observedAt,
      }))
    expect(candidate).toHaveLength(1)
    expect(candidate[0]).toMatchObject({
      id: 'shellyplus1-8813bfcdc8bc:switch:0',
      protocol: 'http', transport: 'http', driver: 'shelly-lan',
      capabilities: ['switch'],
      metadata: {
        physicalId: 'shellyplus1-8813bfcdc8bc',
        component: 'switch:0', channel: 0,
        ipAddress: '192.168.1.220',
        networkObservedAt: shelly.discoveredAt,
      },
    })
    expect(inventory.discover).toHaveBeenCalledWith(expect.objectContaining({
      identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyplus1-8813bfcdc8bc' },
      components: [{ key: 'switch:0', capabilities: ['switch'] }],
      evidenceSource: 'lan_discovery_protocol_identity',
    }))
    expect(registry).not.toHaveProperty('approveDiscoveredDevice')
  })

  it('retains Discovery Memory evidence and rejects the scan when physical persistence fails', async () => {
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([{
      ipAddress: '192.168.1.204', macAddress: '08:F9:E0:E8:49:13', vendor: 'Shelly',
    }])
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        id: 'shellyproem50-08f9e0e84910', mac: '08:F9:E0:E8:49:10', gen: 2,
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        components: [{ key: 'em1:0' }],
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 0, act_power: 42 }) }) as unknown as typeof fetch
    const inventory = {
      discover: jest.fn().mockRejectedValue(new Error('inventory unavailable')),
      refreshNetworkObservations: jest.fn(),
    }
    const registry = {
      getSnapshot: jest.fn(() => ({ tenant: { id: 'tenant-test' }, site: { id: 'site-test' } })),
    }
    const service = new DeviceLanDiscoveryService(
      memory, registry as never, new DeviceLanNetworkEvidenceCollector(), inventory as never,
    )

    await expect(service.scanNow({ fullSubnetConfirmed: true })).rejects.toThrow('inventory unavailable')

    expect(await memory.listIdentityEvidence(TEST_DEVICE_OWNER)).toHaveLength(1)
    expect(inventory.refreshNetworkObservations).not.toHaveBeenCalled()
  })

  it('keeps an unknown ESP host discoverable without Registry approval effects', async () => {
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([{
      ipAddress: '192.168.1.88',
      macAddress: '8c:aa:b5:01:02:03',
      hostname: 'esp8266-temp',
      vendor: 'Espressif',
    }])
    const registry = {
      ...TEST_REGISTRY,
      registerDiscoveredDevice: jest.fn(),
      approveDiscoveredDevice: jest.fn(),
    }
    const service = new DeviceLanDiscoveryService(memory, registry as never, new DeviceLanNetworkEvidenceCollector())

    const result = await service.scanNow({ fullSubnetConfirmed: true })

    expect(result.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ipAddress: '192.168.1.88',
        macAddress: '8c:aa:b5:01:02:03',
        vendor: 'Espressif',
      }),
    ]))
    expect(await memory.listIdentityEvidence(TEST_OWNER)).toHaveLength(1)
    expect(registry.approveDiscoveredDevice).not.toHaveBeenCalled()
    expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled()
  })
})

describe('parseArpOutput', () => {
  it('parses macOS arp output', () => {
    expect(
      parseArpOutput('? (192.168.1.60) at dc:a6:32:12:34:56 on en0 ifscope [ethernet]'),
    ).toEqual([
      {
        ipAddress: '192.168.1.60',
        macAddress: 'dc:a6:32:12:34:56',
        interfaceName: 'en0',
      },
    ])
  })

  it('parses linux ip neighbour style output', () => {
    expect(
      parseArpOutput('192.168.1.88 dev wlan0 lladdr 8c:aa:b5:01:02:03 REACHABLE'),
    ).toEqual([
      {
        ipAddress: '192.168.1.88',
        macAddress: '8c:aa:b5:01:02:03',
        interfaceName: 'wlan0',
      },
    ])
  })

  it('pads single-digit ARP octets so the observed interface MAC stays canonical', () => {
    expect(parseArpOutput('? (192.168.1.204) at 8:f9:e0:e8:49:13 on en0 ifscope [ethernet]'))
      .toEqual([{ ipAddress: '192.168.1.204', macAddress: '08:f9:e0:e8:49:13', hostname: undefined, interfaceName: 'en0' }])
  })

  it('ignores non-device neighbour entries', () => {
    expect(
      parseArpOutput([
        '? (224.0.0.251) at 01:00:5e:00:00:fb on en0 ifscope permanent [ethernet]',
        '? (169.254.10.5) at 00:11:22:33:44:55 on en0 ifscope [ethernet]',
        '? (127.0.0.1) at 00:00:00:00:00:00 on lo0 permanent [ethernet]',
      ].join('\n')),
    ).toEqual([])
  })

  it('ignores incomplete active-scan arp entries', () => {
    expect(
      parseArpOutput('? (192.168.7.99) at (incomplete) on en0 ifscope [ethernet]'),
    ).toEqual([])
  })

  it('retains identical IP observations from different network interfaces', () => {
    expect(parseArpOutput([
      '? (192.168.1.133) at 3c:71:bf:32:54:b7 on en0 ifscope [ethernet]',
      '? (192.168.1.133) at 3c:71:bf:32:54:b8 on en1 ifscope [ethernet]',
    ].join('\n'))).toEqual([
      { ipAddress: '192.168.1.133', macAddress: '3c:71:bf:32:54:b7', interfaceName: 'en0' },
      { ipAddress: '192.168.1.133', macAddress: '3c:71:bf:32:54:b8', interfaceName: 'en1' },
    ])
  })
})

describe('Shelly RPC identity evidence', () => {
  it('retains the Shelly-reported interface MAC separately from the LAN MAC', async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'shellyproem50-08f9e0e84910',
        mac: '08F9E0E84910',
        model: 'SPEM-002CEBEU50',
        gen: 2,
        app: 'ProEM',
      }),
    }) as unknown as typeof fetch

    try {
      await expect(probeShelly('192.168.1.204')).resolves.toEqual({
        id: 'shellyproem50-08f9e0e84910',
        mac: '08:f9:e0:e8:49:10',
        model: 'SPEM-002CEBEU50',
        gen: 2,
        app: 'ProEM',
      })
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('parseRouterClientsJson', () => {
  it('parses a router client table export', () => {
    expect(
      parseRouterClientsJson(JSON.stringify({
        clients: [
          {
            ip: '192.168.1.31',
            mac: 'EC:62:60:88:80:84',
            hostname: 'shelly-plus-1',
            vendor: 'Shelly',
            model: 'SPSW-202PE16EU',
            status: 'connected',
          },
        ],
      })),
    ).toEqual([
      {
        ipAddress: '192.168.1.31',
        macAddress: 'ec:62:60:88:80:84',
        hostname: 'shelly-plus-1',
        vendor: 'Shelly',
        model: 'SPSW-202PE16EU',
        protocol: 'unknown',
        confidence: 0.45,
        status: 'online',
        reason: 'Router/client table reported this device on the site network.',
      },
    ])
  })

  it('accepts array exports and common DHCP lease field names', () => {
    expect(
      parseRouterClientsJson(JSON.stringify([
        {
          address: '192.168.1.88',
          hwaddr: '8c:aa:b5:01:02:03',
          name: 'esp8266-temp',
          manufacturer: 'Espressif',
        },
      ])),
    ).toEqual([
      expect.objectContaining({
        ipAddress: '192.168.1.88',
        macAddress: '8c:aa:b5:01:02:03',
        hostname: 'esp8266-temp',
        vendor: 'Espressif',
        status: 'unknown',
      }),
    ])
  })

  it('ignores malformed and non-useful router client entries', () => {
    expect(
      parseRouterClientsJson(JSON.stringify({
        clients: [
          { ip: 'not-an-ip' },
          { ip: '224.0.0.1', mac: '01:00:5e:00:00:01' },
          { name: 'missing-ip' },
        ],
      })),
    ).toEqual([])
  })
})

describe('network discovery zones', () => {
  it('parses configured site network zones', () => {
    expect(
      parseNetworkZones(JSON.stringify({
        zones: [
          {
            id: 'main-lan',
            name: 'Main LAN',
            cidr: '192.168.7.0/24',
            role: 'primary',
          },
          {
            id: 'camera-vlan',
            name: 'Camera VLAN',
            cidr: '192.168.20.0/24',
            role: 'camera',
            seedIps: ['192.168.20.40', 'not-an-ip', '224.0.0.1'],
          },
        ],
      })),
    ).toEqual([
      {
        id: 'main-lan',
        name: 'Main LAN',
        cidr: '192.168.7.0/24',
        interfaceName: undefined,
        seedIps: [],
        gatewayIps: [],
        role: 'primary',
      },
      {
        id: 'camera-vlan',
        name: 'Camera VLAN',
        cidr: '192.168.20.0/24',
        interfaceName: undefined,
        seedIps: ['192.168.20.40'],
        gatewayIps: [],
        role: 'camera',
      },
    ])
  })

  it('matches IPv4 addresses against CIDR zones', () => {
    expect(ipInCidr('192.168.20.40', '192.168.20.0/24')).toBe(true)
    expect(ipInCidr('192.168.21.40', '192.168.20.0/24')).toBe(false)
    expect(ipInCidr('192.168.7.31', '192.168.0.0/16')).toBe(true)
    expect(ipInCidr('192.168.7.31', 'not-a-cidr')).toBe(false)
  })

  it('keeps scan candidates scoped to configured zones', () => {
    const zones = parseNetworkZones(JSON.stringify({
      zones: [
        {
          id: 'main-lan',
          name: 'Main LAN',
          cidr: '192.168.1.0/24',
          seedIps: ['192.168.20.40'],
        },
      ],
    }))

    expect(candidateBelongsToConfiguredZone({ ipAddress: '192.168.1.31' }, zones)).toBe(true)
    expect(candidateBelongsToConfiguredZone({ ipAddress: '192.168.20.40' }, zones)).toBe(true)
    expect(candidateBelongsToConfiguredZone({ ipAddress: '172.17.0.3' }, zones)).toBe(false)
  })

  it('expands only installer-safe CIDR ranges for active scan', () => {
    expect(ipsInCidr('192.168.7.0/30')).toEqual(['192.168.7.1', '192.168.7.2'])
    expect(ipsInCidr('192.168.7.0/24', 3)).toEqual([
      '192.168.7.1',
      '192.168.7.2',
      '192.168.7.3',
    ])
    expect(ipsInCidr('192.168.0.0/16')).toEqual([])
    expect(ipsInCidr('not-a-cidr')).toEqual([])
  })
})


describe('ICMP reachability evidence', () => {
  it('retains a reachable host across routed networks', () => {
    const candidate = icmpReachabilityCandidate('192.168.1.138', true)

    expect(candidate).toEqual({
      ipAddress: '192.168.1.138',
      status: 'online',
      confidence: 0.6,
      reason: 'Host responded to an active ICMP probe.',
    })
  })

  it('does not report a host online when ICMP fails', () => {
    expect(icmpReachabilityCandidate('192.168.1.99', false)).toBeNull()
  })
})


describe('buildNetworkObservations', () => {
  const observedAt = '2026-10-18T10:00:00.000Z'

  it('records ICMP, DNS, and TCP evidence independently', () => {
    expect(buildNetworkObservations(
      {
        status: 'online',
        reason: 'Host responded to an active ICMP probe.',
      },
      {
        hostname: 'exo',
        services: ['ssh'],
      },
      observedAt,
    )).toEqual([
      {
        source: 'icmp',
        attribute: 'reachable',
        value: true,
        observedAt,
      },
      {
        source: 'dns',
        attribute: 'hostname',
        value: 'exo',
        observedAt,
      },
      {
        source: 'tcp',
        attribute: 'port.22.open',
        value: true,
        observedAt,
      },
    ])
  })

  it('does not infer ICMP reachability from router status', () => {
    expect(buildNetworkObservations(
      {
        status: 'online',
        reason: 'Router reported a connected client.',
      },
      {
        services: [],
      },
      observedAt,
    )).toEqual([])
  })

  it('does not infer a closed port from an absent TCP observation', () => {
    expect(buildNetworkObservations(
      { status: 'unknown' },
      { services: [] },
      observedAt,
    )).toEqual([])
  })
})

describe('dedupeNetworkDevices', () => {
  const networkDevice = (
    overrides: Partial<NetworkDiscoveredDevice> = {},
  ): NetworkDiscoveredDevice => ({
    id: '3c:71:bf:32:54:b7',
    ipAddress: '192.168.1.133',
    networkZoneId: 'upstream-lan',
    networkZoneName: 'Upstream LAN',
    macAddress: '3c:71:bf:32:54:b7',
    hostname: 'esp-3254b7',
    protocol: 'unknown',
    confidence: 0.6,
    status: 'online',
    discoveredAt: '2026-10-20T08:08:53.213Z',
    reason: 'Host responded to an active ICMP probe.',
    ...overrides,
  })

  it('keeps one scoped endpoint for hostname variants while retaining observed spelling', () => {
    const devices = dedupeNetworkDevices([
      networkDevice({
        hostname: 'esp-3254b7',
        observations: [{ source: 'dns', attribute: 'hostname', value: 'esp-3254b7', observedAt: '2026-10-20T08:00:00.000Z' }],
      }),
      networkDevice({
        hostname: 'ESP-3254B7',
        macAddress: undefined,
        observations: [{ source: 'dns', attribute: 'hostname', value: 'ESP-3254B7', observedAt: '2026-10-20T08:01:00.000Z' }],
      }),
    ])

    expect(devices).toHaveLength(1)
    expect(['esp-3254b7', 'ESP-3254B7']).toContain(devices[0].hostname)
    expect(devices[0].observations).toContainEqual(expect.objectContaining({
      source: 'dns', attribute: 'hostname', value: 'esp-3254b7',
    }))
    expect(devices[0].observations).toContainEqual(expect.objectContaining({
      source: 'dns', attribute: 'hostname', value: 'ESP-3254B7',
    }))
  })

  it('deduplicates repeated scans by endpoint rather than treating a MAC as permanent identity', () => {
    const first = networkDevice({ discoveredAt: '2026-10-20T08:00:00.000Z' })
    const fresh = networkDevice({
      ipAddress: '192.168.1.134',
      discoveredAt: '2026-10-20T08:15:00.000Z',
    })

    expect(dedupeNetworkDevices([first, fresh])).toHaveLength(2)
  })

  it('prefers a fresh live endpoint over a stale memory duplicate and retains evidence', () => {
    const historical = networkDevice({
      hostname: 'esp-3254b7',
      discoveredAt: '2026-10-20T04:58:47.868Z',
      observations: [{
        source: 'dns', attribute: 'hostname', value: 'esp-3254b7',
        observedAt: '2026-10-20T04:58:47.868Z',
      }],
    })
    const live = networkDevice({
      hostname: 'ESP-3254B7',
      discoveredAt: '2026-10-20T08:08:53.213Z',
      observations: [{
        source: 'dns', attribute: 'hostname', value: 'ESP-3254B7',
        observedAt: '2026-10-20T08:08:53.213Z',
      }],
    })

    const devices = dedupeNetworkDevices([historical, live])

    expect(devices).toHaveLength(1)
    expect(devices[0].discoveredAt).toBe(live.discoveredAt)
    expect(devices[0].observations).toHaveLength(2)
  })

  it('flags conflicting MAC evidence without silently merging across scopes', () => {
    const devices = dedupeNetworkDevices([
      networkDevice(),
      networkDevice({ id: '00:11:22:33:44:55', macAddress: '00:11:22:33:44:55' }),
      networkDevice({ networkZoneId: 'guest-lan', networkZoneName: 'Guest LAN' }),
    ])

    expect(devices).toHaveLength(2)
    expect(devices.find(device => device.networkZoneId === 'upstream-lan'))
      .toMatchObject({ identityConflict: { macAddresses: ['00:11:22:33:44:55', '3c:71:bf:32:54:b7'] } })
    expect(devices.find(device => device.networkZoneId === 'guest-lan')?.identityConflict)
      .toBeUndefined()
  })

  it('preserves components sharing one physical endpoint', () => {
    const devices = dedupeNetworkDevices([
      networkDevice({ components: [{ component: 'em1:0', channel: 0 }] }),
      networkDevice({ components: [{ component: 'em1:1', channel: 1 }] }),
    ])

    expect(devices).toHaveLength(1)
    expect(devices[0].components).toEqual([
      { component: 'em1:0', channel: 0 },
      { component: 'em1:1', channel: 1 },
    ])
  })

  it('does not flag the device-reported Shelly MAC as an ARP MAC conflict', () => {
    const devices = dedupeNetworkDevices([networkDevice({
      id: 'shellyproem50-08f9e0e84910',
      vendor: 'Shelly',
      macAddress: '08:f9:e0:e8:49:13',
      deviceReportedMacAddress: '08:f9:e0:e8:49:10',
      components: [{ component: 'em1:0', channel: 0 }, { component: 'em1:1', channel: 1 }],
    })])

    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({
      id: 'shellyproem50-08f9e0e84910',
      macAddress: '08:f9:e0:e8:49:13',
      deviceReportedMacAddress: '08:f9:e0:e8:49:10',
      components: [{ component: 'em1:0' }, { component: 'em1:1' }],
    })
    expect(devices[0].identityConflict).toBeUndefined()
  })
})

describe('mergeNeighborCandidates', () => {
  it('deduplicates scanner methods by scoped endpoint and retains conflicting MAC evidence', () => {
    const devices = mergeNeighborCandidates([
      {
        ipAddress: '192.168.1.133', networkZoneId: 'upstream-lan',
        networkZoneName: 'Upstream LAN', macAddress: '3c:71:bf:32:54:b7',
        hostname: 'esp-3254b7',
      },
      {
        ipAddress: '192.168.1.133', networkZoneId: 'upstream-lan',
        networkZoneName: 'Upstream LAN', macAddress: '00:11:22:33:44:55',
        hostname: 'ESP-3254B7',
      },
      {
        ipAddress: '192.168.1.133', networkZoneId: 'guest-lan',
        networkZoneName: 'Guest LAN', macAddress: '00:11:22:33:44:55',
      },
    ])

    expect(devices).toHaveLength(2)
    expect(devices.find(device => device.networkZoneId === 'upstream-lan'))
      .toMatchObject({
        hostnameEvidence: ['esp-3254b7', 'ESP-3254B7'],
        macEvidence: ['00:11:22:33:44:55', '3c:71:bf:32:54:b7'],
      })
  })
})
