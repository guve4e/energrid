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
  DeviceLanNetworkEvidenceCollector,
  DeviceLanDiscoveryService,
} from './device-lan-discovery.service'
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { DeviceRegistryService } from './device-registry.service'
import type { NetworkDiscoveredDevice } from './device-registry.types'
import { shellyLanCandidates } from './adapters/inbound/shelly/shelly-lan-candidates'
import { NmapNetworkEvidenceAdapter, type NmapCommandRunner } from './adapters/outbound/network/nmap-network-evidence.adapter'
import type { LocalNetworkRuntimeAdapter, LocalNetworkRuntimeReport } from './adapters/outbound/network/local-network-runtime.adapter'

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_command, _args, _options, callback) => callback(new Error('mocked'))),
}))
jest.mock('node:dns/promises', () => ({
  reverse: jest.fn().mockRejectedValue(new Error('mocked')),
}))
jest.mock('node:net', () => ({
  Socket: class {
    private readonly listeners = new Map<string, (...args: unknown[]) => void>()
    once(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, listener)
      return this
    }
    setTimeout() { return this }
    connect() {
      queueMicrotask(() => this.listeners.get('error')?.(new Error('mocked')))
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
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    directory = await mkdtemp(join(tmpdir(), 'energrid-lan-evidence-'))
    memory = new DeviceDiscoveryMemoryStore(directory)
    process.env.HOME_LAN_ACTIVE_SCAN_ENABLED = 'false'
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

  afterEach(async () => {
    await memory.onModuleDestroy()
    await rm(directory, { recursive: true, force: true })
    process.env = originalEnv
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('requires explicit confirmation before a configured subnet scan and writes nothing before confirmation', async () => {
    const service = new DeviceLanDiscoveryService(memory, {} as DeviceRegistryService, new DeviceLanNetworkEvidenceCollector())

    await expect(service.scanNow()).rejects.toThrow('explicit operator confirmation')
    expect(await memory.listSnapshots()).toEqual([])
    expect(await memory.listIdentityEvidence()).toEqual([])
  })

  it('does not treat discovered interface scopes as configured or authorized scan scopes', async () => {
    delete process.env.HOME_NETWORK_ZONES_JSON
    delete process.env.HOME_LAN_SCAN_SUBNETS
    const service = new DeviceLanDiscoveryService(memory, {} as DeviceRegistryService, new DeviceLanNetworkEvidenceCollector())

    expect(service.getZones()).toEqual([])
    await expect(service.scanNow()).rejects.toThrow('No network scan scopes are configured')
    expect(await memory.listSnapshots()).toEqual([])
  })

  it('scans only selected scopes and discards router evidence that belongs to another configured scope', async () => {
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [
      { id: 'eero', name: 'Eero', cidr: '192.168.7.0/24' },
      { id: 'housenet', name: 'HouseNet', cidr: '192.168.1.0/24' },
    ] })
    process.env.HOME_ROUTER_CLIENTS_JSON = JSON.stringify([{
      ipAddress: '192.168.1.133', macAddress: '02:00:00:00:00:0a',
    }])
    const service = new DeviceLanDiscoveryService(memory, {} as DeviceRegistryService, new DeviceLanNetworkEvidenceCollector())

    const result = await service.scanNow({ scopeIds: ['eero'], fullSubnetConfirmed: true })

    expect(result.zones.map(zone => zone.id)).toEqual(['eero'])
    expect(result.devices).toEqual([])
    expect(result.snapshot.scopes.map(scope => scope.id)).toEqual(['eero'])
    expect(await memory.listSnapshots()).toHaveLength(1)
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
      {} as DeviceRegistryService,
      new DeviceLanNetworkEvidenceCollector(adapter),
    )

    const result = await service.scanNow({ fullSubnetConfirmed: true })
    const saved = await memory.getSnapshot(result.snapshot.scanId)
    const identityRecords = await memory.listIdentityEvidence()
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
    const service = new DeviceLanDiscoveryService(memory, {} as DeviceRegistryService, collector)

    const result = await service.scanNow({ scopeIds: ['home-lan'], fullSubnetConfirmed: true })
    const saved = await memory.getSnapshot(result.snapshot.scanId)

    expect(result.snapshot.schemaVersion).toBe(2)
    expect(saved?.runtime).toMatchObject({ observer: runtime.observer, localScopes: runtime.localScopes })
    expect(saved?.runtime?.capabilities.map(capability => capability.id)).toEqual(expect.arrayContaining(['nmap', 'active_probing']))
  })

  it('persists each same-scan MAC identity before projecting the ambiguous endpoint', async () => {
    const service = new DeviceLanDiscoveryService(
      memory,
      {} as DeviceRegistryService,
      new DeviceLanNetworkEvidenceCollector(),
    )

    const result = await service.scanNow({ fullSubnetConfirmed: true })
    const identityRecords = await memory.listIdentityEvidence()
    const endpointRecords = await memory.list()
    const savedSnapshot = await memory.getSnapshot(result.snapshot.scanId)
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
    const service = new DeviceLanDiscoveryService(memory, {} as DeviceRegistryService, new DeviceLanNetworkEvidenceCollector())
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
    let records = await memory.listIdentityEvidence()
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
    records = await memory.listIdentityEvidence()
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

    const service = new DeviceLanDiscoveryService(memory, {} as DeviceRegistryService, new DeviceLanNetworkEvidenceCollector())
    const result = await service.scanNow({ fullSubnetConfirmed: true })
    const records = await memory.listIdentityEvidence()

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
    const identityHistory = await memory.listIdentityEvidence()
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

    expect(await memory.listIdentityEvidence()).toHaveLength(1)
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
    expect(await memory.listIdentityEvidence()).toHaveLength(1)
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
