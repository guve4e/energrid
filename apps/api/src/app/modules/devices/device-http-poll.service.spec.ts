import { DeviceHttpPollService } from './device-http-poll.service'
import { DeviceRegistryService } from './device-registry.service'
import type { NetworkDiscoveryZone, RegisteredDevice } from './device-registry.types'
import type { KnownNetworkDevice } from './device-discovery-memory.store'

const upstreamZone: NetworkDiscoveryZone = {
  id: 'upstream-lan', name: 'Upstream LAN', cidr: '192.168.1.0/24', seedIps: [],
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

  it('polls approved HTTP devices into live registry state', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        values: {
          temperature: 23.2,
          humidity: 47.4,
        },
      }),
    } as Response) as unknown as typeof fetch

    const registry = new DeviceRegistryService()
    const poller = new DeviceHttpPollService(registry)

    await poller.pollOnce()

    const device = registry
      .getSnapshot()
      .devices.find((item) => item.id === 'kitchen.temperature.http')

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8088/status',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    )
    expect(device?.state).toEqual(
      expect.objectContaining({
        values: { temperature: 23.2, humidity: 47.4 },
        source: 'http-poll',
        status: 'online',
      }),
    )
  })

  it('marks HTTP devices offline when polling fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    } as Response) as unknown as typeof fetch

    const registry = new DeviceRegistryService()
    const poller = new DeviceHttpPollService(registry)

    await poller.pollOnce()

    const device = registry
      .getSnapshot()
      .devices.find((item) => item.id === 'kitchen.temperature.http')

    expect(device?.state.status).toBe('offline')
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
      { getZones: () => [upstreamZone] } as never,
    )
    await poller.pollOnce()

    expect(global.fetch).toHaveBeenNthCalledWith(1, 'http://192.168.1.211/api/v1/identity', expect.objectContaining({ redirect: 'manual' }))
    expect(global.fetch).toHaveBeenNthCalledWith(2, 'http://192.168.1.211/api/v1/status', expect.objectContaining({ redirect: 'error' }))
    expect(observations.sourceSampleEvidenceId).toHaveBeenCalledWith(
      { tenantId: 'valentin', siteId: 'boyana-home' }, device.id, 'energrid-http-status',
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
    const registry = { getDevices: jest.fn().mockReturnValue([device]), ingestDeviceStatus: jest.fn() }
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof fetch
    const poller = new DeviceHttpPollService(
      registry as unknown as DeviceRegistryService, observations as never, discovery as never,
      { getZones: () => [upstreamZone] } as never,
    )

    await poller.pollOnce()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(discovery.recordIdentityObservation).not.toHaveBeenCalled()
    expect(observations.ingestHttpObservation).not.toHaveBeenCalled()
    expect(registry.ingestDeviceStatus).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'offline' }))
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
    expect(registry.ingestDeviceStatus).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'offline' }))
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

  it('marks the physical sensor offline and rejects ingestion when its status endpoint fails', async () => {
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
    expect(registry.ingestDeviceStatus).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id, status: 'offline' }))
  })
})
