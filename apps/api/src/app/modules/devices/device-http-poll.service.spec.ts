import { buildFirmwareDiagnosticCollectionContext, DeviceHttpPollService, selectScheduledHttpCollection } from './device-http-poll.service'
import { DeviceRegistryService } from './device-registry.service'
import type { NetworkDiscoveryZone, RegisteredDevice } from './device-registry.types'
import type { KnownNetworkDevice } from './device-discovery-memory.store'

const upstreamZone: NetworkDiscoveryZone = {
  id: 'upstream-lan', name: 'Upstream LAN', cidr: '192.168.1.0/24', seedIps: [],
}
const virtualLabZone: NetworkDiscoveryZone = {
  id: 'device-lab-vlan', name: 'Virtual Lab LAN', cidr: '172.30.250.0/28',
  seedIps: ['172.30.250.10', '172.30.250.11'], collectionSource: 'virtual-lab',
}
const verifiedIdentity = (id = 'esp8266:324864') => ({
  schemaVersion: 1, id, model: 'Energrid ESP8266 DHT22', firmwareVersion: '0.2.0',
  capabilities: ['temperature', 'humidity'],
})

describe('DeviceHttpPollService', () => {
  const originalEnv = process.env
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.PORTAL_TENANT_ID = 'valentin'
    process.env.PORTAL_SITE_ID = 'boyana-home'
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'kitchen.temperature.http',
          name: 'Kitchen temperature HTTP sensor',
          protocol: 'http',
          transport: 'http',
          driver: 'http-json-sensor',
          target: 'http://127.0.0.1:8088/status',
          location: 'Kitchen',
          capabilities: ['temperature', 'humidity'],
          values: { temperature: 22.4, humidity: 48 },
        },
      ],
    })
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
  })

  it('selects scheduled HTTP reads separately from MQTT and Shelly switch observations', () => {
    const makeDevice = (
      id: string, driver: string, protocol: string, configured: boolean, trustStatus = 'approved',
    ) => ({
      id, tenantId: 'tenant-demo', siteId: 'site-home', kind: 'physical', trustStatus,
      adapter: { driver, protocol, configured, target: 'http://192.168.1.10/status' },
    }) as unknown as RegisteredDevice
    const esp = makeDevice('device:upstream-lan:esp8266:324864', 'energrid-esp8266', 'http', false)
    const generic = makeDevice('generic-1', 'http-json-sensor', 'http', true)
    const unconfigured = makeDevice('generic-unconfigured', 'http-json-sensor', 'http', false)
    const mqttSwitch = makeDevice('shellypro2pm-ec6260888084:switch:0', 'shelly-discovered', 'mqtt', true)
    const httpSwitch = makeDevice('shellypro2pm-ec6260888084:switch:1', 'shelly-lan', 'http', true)
    const em = makeDevice('shellyproem50-8c4f00dbd258:em1:0', 'shelly-lan', 'http', true)
    const unapproved = makeDevice('shellyplus1-78ee4ccf4b54:switch:0', 'shelly-discovered', 'mqtt', true, 'discovered')

    const work = selectScheduledHttpCollection([esp, generic, unconfigured, mqttSwitch, httpSwitch, em, unapproved])
    expect(work.httpDevices.map(device => device.id)).toEqual([esp.id])
    expect(work.httpDevices).not.toContain(generic)
    expect(work.httpDevices).not.toContain(httpSwitch)
    expect(work.shellySwitches.map(device => device.id)).toEqual([mqttSwitch.id, httpSwitch.id])
    // EM1 needs a verified measurement adapter; switch RPC must never be used.
    expect(work.httpDevices).not.toContain(em)
    expect(work.shellySwitches).not.toContain(em)
  })

  it('does not fall back to legacy HTTP telemetry when verified switch collection rejects', async () => {
    const device = {
      id: 'shellypro2pm-ec6260888084:switch:0',
      tenantId: 'tenant-demo', siteId: 'site-home', kind: 'physical', trustStatus: 'approved',
      adapter: { driver: 'shelly-lan', protocol: 'http', configured: true,
        target: 'http://192.168.7.39/rpc/Switch.GetStatus?id=0' },
    } as unknown as RegisteredDevice
    const registry = { getDevices: jest.fn().mockReturnValue([device]) }
    const shelly = {
      pollLegacyShellyHttp: jest.fn(),
      pollAuthorizedLocalShellyStatus: jest.fn().mockResolvedValue(null),
      refreshRemoteShellyObservers: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
    }
    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService,
      undefined, undefined, undefined, undefined, undefined, undefined,
      shelly as never,
    )

    await poller.pollOnce()

    expect(shelly.pollAuthorizedLocalShellyStatus).toHaveBeenCalledTimes(1)
    expect(shelly.pollAuthorizedLocalShellyStatus).toHaveBeenCalledWith(device)
    expect(shelly.refreshRemoteShellyObservers).toHaveBeenCalledWith([device])
    expect(shelly.pollLegacyShellyHttp).not.toHaveBeenCalled()
  })

  it('reads registered devices once per HTTP scheduling cycle', async () => {
    const registry = { getDevices: jest.fn().mockReturnValue([]) }
    const poller = new DeviceHttpPollService(registry as unknown as DeviceRegistryService)
    await poller.pollOnce()
    expect(registry.getDevices).toHaveBeenCalledTimes(1)
    expect(registry.getDevices).toHaveBeenCalledWith(true)
  })

  it('does not poll or project configured generic HTTP JSON without a verified integration', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ values: { temperature: 23.2, humidity: 47.4 } }),
    } as Response) as unknown as typeof fetch

    const registry = new DeviceRegistryService()
    const poller = new DeviceHttpPollService(registry)
    const telemetryWriter = jest.spyOn(registry, 'ingestDeviceTelemetry')

    await poller.pollOnce()

    expect(global.fetch).not.toHaveBeenCalled()
    expect(telemetryWriter).not.toHaveBeenCalled()
    const device = registry.getSnapshot().devices.find(item => item.id === 'kitchen.temperature.http')
    expect(device?.state.source).not.toBe('http-poll')
  })

  it('polls an approved Lab-site ESP through the scoped remote HTTP transport and the same observation ingress', async () => {
    const device = {
      id: 'device:device-lab-vlan:esp8266:a1b2c3', tenantId: 'tenant-demo', siteId: 'site-device-lab',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://172.30.250.10/api/v1/status' },
      metadata: { physicalId: 'esp8266:a1b2c3', networkScope: 'device-lab-vlan' }, capabilities: [], zoneName: 'Lab',
    } as unknown as RegisteredDevice
    const observedAt = new Date().toISOString()
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([{
      schemaVersion: 2, ownership: { tenantId: 'tenant-demo', siteId: 'site-device-lab' },
      identity: 'device:device-lab-vlan:esp8266:a1b2c3', firstSeenAt: observedAt,
      lastSeenAt: observedAt, lastScanId: 'lab-scan-1', device: {
        id: 'esp8266:a1b2c3', ipAddress: '172.30.250.10', networkZoneId: 'device-lab-vlan',
        networkZoneName: 'Virtual Lab LAN', protocol: 'http', confidence: 1, status: 'online',
        discoveredAt: observedAt, reason: 'identity verified in the isolated Lab network',
        observations: [
          { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: 'device-lab-vlan', method: 'GET /api/v1/identity' },
          { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:a1b2c3', observedAt, scopeId: 'device-lab-vlan', method: 'GET /api/v1/identity' },
        ],
      },
    }]) }
    const observations = {
      sourceSampleEvidenceId: jest.fn().mockResolvedValue('lab-sample-2-10000'),
      ingestHttpObservation: jest.fn().mockResolvedValue({ outcome: 'processed', accepted: true, stage: 'observation', reason: 'accepted', updatedKeys: ['temperature', 'humidity'], rejectedFields: [], state: null }),
    }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    const remoteEvidence = {
      identity: { status: 200, body: verifiedIdentity('esp8266:a1b2c3') },
      status: { status: 200, body: {
        schemaVersion: 1, deviceId: 'esp8266:a1b2c3', uptimeMs: 12000, sampleIntervalMs: 5000,
        sensor: { state: 'ok', sampleCount: 2, lastSampleUptimeMs: 10000, readingAgeMs: 0, temperatureC: 27.25, humidityPct: 51 },
      } },
    }
    const virtualRead = jest.fn().mockResolvedValue(remoteEvidence)
    global.fetch = jest.fn() as unknown as typeof fetch

    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService,
      observations as never,
      discovery as never,
      { getZones: () => [virtualLabZone], getConfiguredZone: () => virtualLabZone, readVirtualLabEnergridHttpEvidence: virtualRead } as never,
    )
    await poller.pollOnce()

    expect(registry.getDevices).toHaveBeenCalledWith(true)
    expect(virtualRead).toHaveBeenCalledWith('device-lab-vlan', '172.30.250.10', 'esp8266:a1b2c3', expect.any(AbortSignal))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(observations.ingestHttpObservation).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 'tenant-demo', siteId: 'site-device-lab' }, deviceId: device.id,
      sourceId: 'energrid-http-status', selector: '/api/v1/status',
      payload: { temperatureC: 27.25, humidityPct: 51 }, evidenceId: 'lab-sample-2-10000',
    }))
  })

  it('does not invent offline state for an unverified generic HTTP endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 } as Response) as unknown as typeof fetch

    const registry = new DeviceRegistryService()
    const poller = new DeviceHttpPollService(registry)
    const statusWriter = jest.spyOn(registry, 'ingestDeviceStatus')

    await poller.pollOnce()

    expect(global.fetch).not.toHaveBeenCalled()
    expect(statusWriter).not.toHaveBeenCalled()
  })

  it('keeps the configured gate for non-Energrid HTTP adapters', async () => {
    const device = {
      id: 'generic-http-sensor', tenantId: 'valentin', siteId: 'boyana-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'http-json-sensor', target: 'http://127.0.0.1/status' },
      metadata: {}, capabilities: [], zoneName: 'Kitchen',
    } as unknown as RegisteredDevice
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    global.fetch = jest.fn() as unknown as typeof fetch
    const poller = new DeviceHttpPollService(registry as unknown as DeviceRegistryService)

    await poller.pollOnce()

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('verifies scoped firmware identity before submitting the source sample through approved ingress', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'valentin', siteId: 'boyana-home',
      trustStatus: 'approved', kind: 'physical',
      // Real enrollment shape: observation approval is separate, so the
      // hardware adapter remains unconfigured until a binding is approved.
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Kitchen',
    } as unknown as RegisteredDevice
    const observedAt = new Date().toISOString()
    const discovery = {
      listIdentityEvidence: jest.fn().mockResolvedValue([{
        schemaVersion: 1, identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: observedAt,
        lastSeenAt: observedAt, lastScanId: 'scan-1',
        device: {
          id: 'esp8266:324864', ipAddress: '192.168.1.211', networkZoneId: 'upstream-lan',
          networkZoneName: 'Upstream LAN', protocol: 'http', confidence: 1, status: 'online',
          discoveredAt: observedAt, reason: 'verified',
          observations: [
            { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
            { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
          ],
        },
      }]),
      recordIdentityObservation: jest.fn().mockResolvedValue(undefined),
    }
    const observations = {
      sourceSampleEvidenceId: jest.fn().mockResolvedValue('energrid-http-status:sample-6-10000'),
      ingestHttpObservation: jest.fn().mockResolvedValue({
        outcome: 'processed', accepted: true, stage: 'observation', reason: 'accepted',
        updatedKeys: ['temperature', 'humidity'], rejectedFields: [], state: null,
      }),
    }
    const registry = {
      getDevices: jest.fn().mockReturnValue([device]),
      ingestDeviceStatus: jest.fn(),
    }
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, headers: { get: () => '120' }, json: async () => verifiedIdentity() })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        schemaVersion: 1, deviceId: 'esp8266:324864', uptimeMs: 12000, sampleIntervalMs: 2000,
        sensor: { state: 'ok', sampleCount: 6, lastSampleUptimeMs: 10000, readingAgeMs: 2000, temperatureC: 22.5, humidityPct: 48 },
      }) }) as unknown as typeof fetch

    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService,
      observations as never,
      discovery as never,
      {
        // A recent Lab scan may be the last selected scope, but must not hide
        // the independently configured Home network from its scheduled poll.
        getZones: () => [virtualLabZone],
        getConfiguredZone: (scopeId: string) => scopeId === 'upstream-lan' ? upstreamZone : virtualLabZone,
      } as never,
    )
    await poller.pollOnce()

    expect(global.fetch).toHaveBeenNthCalledWith(1, 'http://192.168.1.211/api/v1/identity', expect.objectContaining({ redirect: 'manual' }))
    expect(global.fetch).toHaveBeenNthCalledWith(2, 'http://192.168.1.211/api/v1/status', expect.objectContaining({ redirect: 'error' }))
    expect(observations.sourceSampleEvidenceId).toHaveBeenCalledWith(
      { tenantId: 'valentin', siteId: 'boyana-home' }, device.id, 'energrid-esp8266-sample',
      { uptimeMs: 12000, sampleCount: 6, lastSampleUptimeMs: 10000 },
    )
    expect(observations.ingestHttpObservation).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 'valentin', siteId: 'boyana-home' }, deviceId: device.id,
      sourceId: 'energrid-http-status', selector: '/api/v1/status',
      payload: { temperatureC: 22.5, humidityPct: 48 },
      evidenceId: 'energrid-http-status:sample-6-10000',
    }))
    expect(discovery.recordIdentityObservation).not.toHaveBeenCalled()
  })

  it('revalidates an enrolled endpoint when scoped Discovery Memory is empty, then survives poller recreation', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'tenant-demo', siteId: 'site-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Garage',
    } as unknown as RegisteredDevice
    let records: KnownNetworkDevice[] = []
    const discovery = {
      listIdentityEvidence: jest.fn().mockImplementation(async (scope) => {
        expect(scope).toEqual({ tenantId: 'tenant-demo', siteId: 'site-home' })
        return records
      }),
      recordIdentityObservation: jest.fn().mockImplementation(async (observedAt, observedDevice, ownership) => {
        records = [{
          schemaVersion: 2, ownership, identity: 'device:upstream-lan:esp8266:324864',
          firstSeenAt: observedAt, lastSeenAt: observedAt, lastScanId: `identity:${observedAt}`,
          device: observedDevice,
        }]
      }),
    }
    const observations = {
      sourceSampleEvidenceId: jest.fn().mockResolvedValue('http-sample'),
      ingestHttpObservation: jest.fn().mockResolvedValue({
        outcome: 'processed', accepted: true, stage: 'observation', reason: 'accepted',
        updatedKeys: ['temperature', 'humidity'], rejectedFields: [], state: null,
      }),
    }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    const statusPayload = (sampleCount: number) => ({
      schemaVersion: 1, deviceId: 'esp8266:324864', uptimeMs: sampleCount * 2_000,
      sampleIntervalMs: 2_000,
      sensor: { state: 'ok', sampleCount, lastSampleUptimeMs: sampleCount * 2_000,
        readingAgeMs: 100, temperatureC: 22.5, humidityPct: 48 },
    })
    const response = (body: unknown) => ({ ok: true, headers: { get: () => '300' }, json: async () => body })
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(verifiedIdentity()))
      .mockResolvedValueOnce(response(statusPayload(10)))
      .mockResolvedValueOnce(response(verifiedIdentity()))
      .mockResolvedValueOnce(response(statusPayload(11))) as unknown as typeof fetch
    const makePoller = () => new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone], getConfiguredZone: () => upstreamZone } as never,
    )

    await makePoller().pollOnce()

    expect(global.fetch).toHaveBeenNthCalledWith(1, 'http://192.168.1.198/api/v1/identity', expect.objectContaining({ redirect: 'manual' }))
    expect(discovery.recordIdentityObservation).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({
        id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan',
        observations: expect.arrayContaining([
          expect.objectContaining({ attribute: 'identity.device_id', value: 'esp8266:324864', scopeId: 'upstream-lan' }),
        ]),
      }),
      { tenantId: 'tenant-demo', siteId: 'site-home' },
    )
    expect(observations.ingestHttpObservation).toHaveBeenCalledTimes(1)

    // A new poller represents an API restart; it must use the durably scoped
    // identity evidence produced by the first exact-identity verification.
    await makePoller().pollOnce()
    expect(global.fetch).toHaveBeenCalledTimes(4)
    expect(observations.ingestHttpObservation).toHaveBeenCalledTimes(2)
    expect(discovery.recordIdentityObservation).toHaveBeenCalledTimes(1)
    expect(discovery.listIdentityEvidence).toHaveBeenNthCalledWith(2, { tenantId: 'tenant-demo', siteId: 'site-home' })
  })

  it('does not treat a reused last-known IP as the enrolled device when firmware identity differs', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'tenant-demo', siteId: 'site-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Garage',
    } as unknown as RegisteredDevice
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([]), recordIdentityObservation: jest.fn() }
    const observations = { sourceSampleEvidenceId: jest.fn(), ingestHttpObservation: jest.fn() }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, headers: { get: () => '100' }, json: async () => verifiedIdentity('esp8266:ffffff'),
    }) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone] } as never,
    )

    await poller.pollOnce()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(discovery.recordIdentityObservation).not.toHaveBeenCalled()
    expect(observations.ingestHttpObservation).not.toHaveBeenCalled()
    expect(registry.ingestDeviceStatus).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'unknown' }))
  })

  it('keeps a missing-memory endpoint untrusted without marking the enrolled device offline when unreachable', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'tenant-demo', siteId: 'site-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Garage',
    } as unknown as RegisteredDevice
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([]), recordIdentityObservation: jest.fn() }
    const observations = { sourceSampleEvidenceId: jest.fn(), ingestHttpObservation: jest.fn() }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn(), recordObserverReachability: jest.fn() }
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(timeoutError) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone] } as never,
    )

    await poller.pollOnce()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(discovery.recordIdentityObservation).not.toHaveBeenCalled()
    expect(observations.ingestHttpObservation).not.toHaveBeenCalled()
    expect(registry.ingestDeviceStatus).not.toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'offline' }))
    expect(registry.recordObserverReachability).toHaveBeenCalledWith(device.id, expect.objectContaining({
      status: 'unreachable', targetIpAddress: '192.168.1.198', networkScopeId: 'upstream-lan', reason: 'request_timeout',
      observer: expect.objectContaining({ host: expect.any(String), localScopes: expect.any(Array) }),
    }), expect.objectContaining({ tenantId: 'tenant-demo', siteId: 'site-home' }))
  })

  it('records only same-identity firmware diagnostics without blocking accepted observations when diagnostics fail', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'tenant-demo', siteId: 'site-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Kitchen',
    } as unknown as RegisteredDevice
    const observedAt = new Date().toISOString()
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([{
      schemaVersion: 1, identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: observedAt,
      lastSeenAt: observedAt, lastScanId: 'scan-1', device: {
        id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan',
        networkZoneName: 'Upstream LAN', protocol: 'http', confidence: 1, status: 'online', discoveredAt: observedAt,
        observations: [
          { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
          { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
        ],
      },
    }]) }
    const observations = {
      sourceSampleEvidenceId: jest.fn().mockResolvedValue('evidence'),
      ingestHttpObservation: jest.fn().mockResolvedValue({ outcome: 'processed', accepted: true, stage: 'observation', reason: 'accepted', updatedKeys: ['temperature', 'humidity'], rejectedFields: [], state: null }),
    }
    const diagnostics = {
      record: jest.fn().mockResolvedValue({ restartCount10m: 0 }),
      recordFailure: jest.fn().mockResolvedValue({}),
    }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    const diagnosticsSample = {
      schemaVersion: 1, deviceId: 'esp8266:324864', firmwareVersion: '0.3.0',
      bootSessionId: 'esp8266-324864-1234abcd', uptimeMs: 20_000,
      reset: { reason: 'External System', reasonCode: 6, exception: null },
      memory: { freeHeapBytes: 20_000, heapFragmentationPct: 12, largestFreeBlockBytes: 15_000 },
      wifi: { connected: true, rssiDbm: -55, disconnectCount: 0, reconnectCount: 0 },
      sensor: { sampleCount: 10, readFailureCount: 0 },
    }
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, headers: { get: () => '120' }, json: async () => verifiedIdentity() })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => '400' }, json: async () => diagnosticsSample })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        schemaVersion: 1, deviceId: 'esp8266:324864', uptimeMs: 20_000, sampleIntervalMs: 2000,
        sensor: { state: 'ok', sampleCount: 10, lastSampleUptimeMs: 18_000, readingAgeMs: 2000, temperatureC: 22.5, humidityPct: 48 },
      }) }) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone] } as never, diagnostics as never,
    )
    await poller.pollOnce()
    expect(diagnostics.record).toHaveBeenCalledWith(
      { tenantId: 'tenant-demo', siteId: 'site-home' }, device.id, 'esp8266:324864', expect.objectContaining({ bootSessionId: 'esp8266-324864-1234abcd' }),
    )
    expect(observations.ingestHttpObservation).toHaveBeenCalledWith(expect.objectContaining({ payload: { temperatureC: 22.5, humidityPct: 48 } }))

    const nextPoller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone] } as never, diagnostics as never,
    )
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, headers: { get: () => '120' }, json: async () => verifiedIdentity() })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        schemaVersion: 1, deviceId: 'esp8266:324864', uptimeMs: 22_000, sampleIntervalMs: 2000,
        sensor: { state: 'ok', sampleCount: 11, lastSampleUptimeMs: 20_000, readingAgeMs: 2000, temperatureC: 22.6, humidityPct: 48.1 },
      }) }) as unknown as typeof fetch
    await nextPoller.pollOnce()
    expect(diagnostics.record).toHaveBeenCalledTimes(1)
    expect(diagnostics.recordFailure).toHaveBeenCalledWith(
      { tenantId: 'tenant-demo', siteId: 'site-home' }, device.id, 'esp8266:324864', 'diagnostics_http_error',
      expect.any(String), expect.objectContaining({
        observer: expect.objectContaining({ host: expect.any(String), localScopes: expect.any(Array) }),
        target: expect.objectContaining({ endpoint: 'http://192.168.1.198/api/v1/diagnostics', ipAddress: '192.168.1.198', networkScopeId: 'upstream-lan' }),
      }),
    )
    expect(observations.ingestHttpObservation).toHaveBeenCalledTimes(2)
  })

  it('renews expired identity evidence with a single verified device GET before ingesting observations', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'tenant-demo', siteId: 'site-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Kitchen',
    } as unknown as RegisteredDevice
    const expiredAt = new Date(Date.now() - 11 * 60_000).toISOString()
    const record: KnownNetworkDevice = {
      schemaVersion: 1, identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: expiredAt,
      lastSeenAt: expiredAt, lastScanId: 'scan-before-expiry',
      device: {
        id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan',
        networkZoneName: 'Upstream LAN', vendor: 'Energrid', protocol: 'http', confidence: 0.95,
        status: 'online', discoveredAt: expiredAt, reason: 'previously verified endpoint',
        observations: [
          { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: expiredAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
          { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt: expiredAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
        ],
      },
    }
    const discovery = {
      listIdentityEvidence: jest.fn().mockResolvedValue([record]),
      recordIdentityObservation: jest.fn().mockResolvedValue(undefined),
    }
    const observations = {
      sourceSampleEvidenceId: jest.fn().mockResolvedValue('energrid-http-status:boot-0:sample-7-12000'),
      ingestHttpObservation: jest.fn().mockResolvedValue({
        outcome: 'processed', accepted: true, stage: 'observation', reason: 'accepted',
        updatedKeys: ['temperature', 'humidity'], rejectedFields: [], state: null,
      }),
    }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, headers: { get: () => '150' }, json: async () => verifiedIdentity() })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        schemaVersion: 1, deviceId: 'esp8266:324864', uptimeMs: 14000, sampleIntervalMs: 2000,
        sensor: { state: 'ok', sampleCount: 7, lastSampleUptimeMs: 12000, readingAgeMs: 1000, temperatureC: 21.8, humidityPct: 49.2 },
      }) }) as unknown as typeof fetch

    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone] } as never,
    )
    await poller.pollOnce()

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch).toHaveBeenNthCalledWith(1, 'http://192.168.1.198/api/v1/identity', expect.objectContaining({ redirect: 'manual' }))
    expect(discovery.recordIdentityObservation).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({
        id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan',
        observations: expect.arrayContaining([
          expect.objectContaining({ attribute: 'identity.verified', value: true, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' }),
        ]),
      }),
      { tenantId: 'tenant-demo', siteId: 'site-home' },
    )
    expect(observations.ingestHttpObservation).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 'tenant-demo', siteId: 'site-home' },
      deviceId: device.id, payload: { temperatureC: 21.8, humidityPct: 49.2 },
    }))
  })

  it('fails closed when the previously verified endpoint is unreachable after evidence expiry', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'tenant-demo', siteId: 'site-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Kitchen',
    } as unknown as RegisteredDevice
    const expiredAt = new Date(Date.now() - 11 * 60_000).toISOString()
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([{
      schemaVersion: 1, identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: expiredAt,
      lastSeenAt: expiredAt, lastScanId: 'old-scan', device: {
        id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan',
        networkZoneName: 'Upstream LAN', protocol: 'http', confidence: 1, status: 'online', discoveredAt: expiredAt,
        observations: [
          { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: expiredAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
          { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt: expiredAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
        ],
      },
    }]), recordIdentityObservation: jest.fn() }
    const observations = { sourceSampleEvidenceId: jest.fn(), ingestHttpObservation: jest.fn() }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn(), recordObserverReachability: jest.fn() }
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone] } as never,
    )

    await poller.pollOnce()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(discovery.recordIdentityObservation).not.toHaveBeenCalled()
    expect(observations.ingestHttpObservation).not.toHaveBeenCalled()
    expect(registry.ingestDeviceStatus).not.toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'offline' }))
    expect(registry.recordObserverReachability).toHaveBeenCalledWith(device.id, expect.objectContaining({
      status: 'unreachable', targetIpAddress: '192.168.1.198', networkScopeId: 'upstream-lan',
    }), expect.objectContaining({ tenantId: 'tenant-demo', siteId: 'site-home' }))
  })

  it('does not ingest status data when the endpoint firmware identity differs', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'valentin', siteId: 'boyana-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: true, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Kitchen',
    } as unknown as RegisteredDevice
    const observedAt = new Date().toISOString()
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([{
      schemaVersion: 1, identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: observedAt,
      lastSeenAt: observedAt, lastScanId: 'scan-1', device: {
        id: 'esp8266:324864', ipAddress: '192.168.1.211', networkZoneId: 'upstream-lan',
        networkZoneName: 'Upstream LAN', protocol: 'http', confidence: 1, status: 'online',
        discoveredAt: observedAt, reason: 'verified', observations: [
          { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
          { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
        ],
      },
    }] ), recordIdentityObservation: jest.fn() }
    const observations = { sourceSampleEvidenceId: jest.fn(), ingestHttpObservation: jest.fn() }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => '120' }, json: async () => verifiedIdentity('esp8266:ffffff') }) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(registry as unknown as DeviceRegistryService, observations as never, discovery as never, { getZones: () => [upstreamZone] } as never)
    await poller.pollOnce()
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(discovery.recordIdentityObservation).not.toHaveBeenCalled()
    expect(observations.ingestHttpObservation).not.toHaveBeenCalled()
    expect(registry.ingestDeviceStatus).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'unknown' }))
  })

  it('rejects redirects without following them or persisting identity evidence', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'tenant-demo', siteId: 'site-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: false, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Kitchen',
    } as unknown as RegisteredDevice
    const observedAt = new Date().toISOString()
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([{
      schemaVersion: 1, identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: observedAt,
      lastSeenAt: observedAt, lastScanId: 'scan-1', device: {
        id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan',
        networkZoneName: 'Upstream LAN', protocol: 'http', confidence: 1, status: 'online', discoveredAt: observedAt,
        observations: [
          { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
          { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
        ],
      },
    }]), recordIdentityObservation: jest.fn() }
    const observations = { sourceSampleEvidenceId: jest.fn(), ingestHttpObservation: jest.fn() }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 302, headers: { get: () => '0' } }) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone] } as never,
    )

    await poller.pollOnce()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual' }))
    expect(discovery.recordIdentityObservation).not.toHaveBeenCalled()
    expect(observations.ingestHttpObservation).not.toHaveBeenCalled()
  })

  it('keeps observer reachability distinct when identity responds but the status endpoint fails', async () => {
    const device = {
      id: 'device:upstream-lan:esp8266:324864', tenantId: 'valentin', siteId: 'boyana-home',
      trustStatus: 'approved', kind: 'physical',
      adapter: { configured: true, protocol: 'http', driver: 'energrid-esp8266', target: 'http://192.168.1.198/api/v1/status' },
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan' }, capabilities: [], zoneName: 'Kitchen',
    } as unknown as RegisteredDevice
    const observedAt = new Date().toISOString()
    const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([{
      schemaVersion: 1, identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: observedAt,
      lastSeenAt: observedAt, lastScanId: 'scan-1', device: {
        id: 'esp8266:324864', ipAddress: '192.168.1.211', networkZoneId: 'upstream-lan',
        networkZoneName: 'Upstream LAN', protocol: 'http', confidence: 1, status: 'online',
        discoveredAt: observedAt, reason: 'verified', observations: [
          { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
          { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt, scopeId: 'upstream-lan', method: 'GET /api/v1/identity' },
        ],
      },
    }] ) }
    const observations = { sourceSampleEvidenceId: jest.fn(), ingestHttpObservation: jest.fn() }
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, headers: { get: () => '120' }, json: async () => verifiedIdentity() })
      .mockResolvedValueOnce({ ok: false, status: 503 }) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(registry as unknown as DeviceRegistryService, observations as never, discovery as never, { getZones: () => [upstreamZone] } as never)
    await poller.pollOnce()
    expect(observations.ingestHttpObservation).not.toHaveBeenCalled()
    expect(registry.ingestDeviceStatus).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'online' }))
    expect(registry.ingestDeviceStatus).not.toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'offline' }))
  })

  it('keeps a saved Eero endpoint distinct from the Mac observer scope when the observer moves to HouseNet', () => {
    const eeroZone: NetworkDiscoveryZone = { id: 'eero-lan', name: 'Eero LAN', cidr: '192.168.7.0/24', seedIps: [] }
    const interfaces = (address: string) => ({ en0: [{
      address, netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '00:00:00:00:00:01', cidr: `${address}/24` as `${string}/${number}`, scopeid: 0,
    }] })
    const before = buildFirmwareDiagnosticCollectionContext(
      'http://192.168.7.48/api/v1/identity', '192.168.7.48', eeroZone, interfaces('192.168.7.25'), 'Mac-LAB', 'darwin',
    )
    const after = buildFirmwareDiagnosticCollectionContext(
      'http://192.168.7.48/api/v1/identity', '192.168.7.48', eeroZone, interfaces('192.168.1.25'), 'Mac-LAB', 'darwin',
    )

    expect(before.target).toMatchObject({ ipAddress: '192.168.7.48', networkScopeId: 'eero-lan' })
    expect(before.target.endpoint).toBe('http://192.168.7.48/api/v1/identity')
    expect(after.target).toEqual(before.target)
    expect(before.observer.localScopes).toContainEqual(expect.objectContaining({ cidr: '192.168.7.25/24' }))
    expect(after.observer.localScopes).toContainEqual(expect.objectContaining({ cidr: '192.168.1.25/24' }))
    expect(after.observer.localScopes).not.toContainEqual(expect.objectContaining({ cidr: '192.168.7.25/24' }))
  })
})
