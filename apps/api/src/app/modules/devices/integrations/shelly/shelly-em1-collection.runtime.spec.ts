import { ShellyOperationalCollectionService } from './shelly-operational-collection.service'
import type { RegisteredDevice } from '../../device-registry.types'

const deviceId = 'shellyproem50-08f9e0e84910:em1:0'
const scope = { tenantId: 'tenant-demo', siteId: 'site-home' }
const device = {
  id: deviceId, ...scope, kind: 'physical', trustStatus: 'approved',
  adapter: { driver: 'shelly-lan', protocol: 'http', configured: true },
  metadata: { physicalId: 'shellyproem50-08f9e0e84910', component: 'em1:0', channel: 0 },
} as unknown as RegisteredDevice
const response = (body: unknown) => ({ status: 200, json: async () => body }) as Response

function fixture(approved = true) {
  const registry = { recordObserverReachability: jest.fn() }
  const routes = { resolveAuthorizedLocalShellyEm1Target: jest.fn().mockResolvedValue({
    device, physicalId: device.metadata!.physicalId, component: 'em1:0', channel: 0,
    ipAddress: '192.0.2.20', interfaceAddress: '192.0.2.5', zone: { id: 'eero-lan', cidr: '192.0.2.0/24' },
    observer: { id: 'local-observer', host: 'test-host', interfaceName: 'en0' },
  }) }
  const observations = {
    inspectPersistedObservationAuthority: jest.fn().mockResolvedValue({
      status: 'installation_approved', sources: approved
        ? [{ sourceId: 'shelly-http-em1', selector: 'EM1.GetStatus?id=0', fields: ['power'] }]
        : [{ sourceId: 'shelly-mqtt', selector: 'devices/em1', fields: ['power'] }],
    }),
    ingestHttpObservation: jest.fn().mockResolvedValue({ outcome: 'processed', accepted: true, reason: 'accepted' }),
  }
  const service = new ShellyOperationalCollectionService(
    registry as never, undefined, undefined, undefined, routes as never, observations as never,
  )
  return { service, registry, routes, observations }
}

describe('Shelly EM1 scoped, read-only HTTP collection', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('skips MQTT-only approvals without resolving a route or issuing HTTP requests', async () => {
    const h = fixture(false)
    global.fetch = jest.fn() as never
    await h.service.pollApprovedEm1Measurements([device])
    expect(h.routes.resolveAuthorizedLocalShellyEm1Target).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(h.observations.ingestHttpObservation).not.toHaveBeenCalled()
  })

  it('submits verified EM1 power to existing approved ingress, never generic telemetry', async () => {
    const h = fixture()
    const fetch = jest.fn()
      .mockResolvedValueOnce(response({ id: device.metadata!.physicalId, gen: 2 }))
      .mockResolvedValueOnce(response({ id: 0, act_power: -43.2 }))
    global.fetch = fetch as never
    await h.service.pollApprovedEm1Measurements([device])
    expect(h.routes.resolveAuthorizedLocalShellyEm1Target).toHaveBeenCalledWith(device)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(h.observations.ingestHttpObservation).toHaveBeenCalledWith(expect.objectContaining({
      scope, deviceId, sourceId: 'shelly-http-em1', selector: 'EM1.GetStatus?id=0',
      payload: { power: -43.2 }, evidenceId: expect.stringMatching(/^shelly-em1-http:[a-f0-9]{64}$/),
    }))
    expect(h.registry.recordObserverReachability).toHaveBeenCalledWith(deviceId,
      expect.objectContaining({ status: 'reachable' }), scope)
  })

  it('does not write an observation on identity mismatch, wrong channel, or missing route', async () => {
    for (const mode of ['identity', 'channel', 'route'] as const) {
      const h = fixture()
      if (mode === 'route') h.routes.resolveAuthorizedLocalShellyEm1Target.mockResolvedValue(null)
      global.fetch = jest.fn().mockResolvedValueOnce(response({ id: mode === 'identity' ? 'other' : device.metadata!.physicalId, gen: 2 }))
        .mockResolvedValueOnce(response({ id: 1, act_power: 200 })) as never
      await h.service.pollApprovedEm1Measurements([device])
      expect(h.observations.ingestHttpObservation).not.toHaveBeenCalled()
    }
  })
})
