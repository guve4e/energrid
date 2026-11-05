import { ShellyRouteResolver } from '../../shelly-route.resolver'
import type { RegisteredDevice } from '../../device-registry.types'

jest.mock('node:os', () => ({
  ...jest.requireActual('node:os'),
  hostname: () => 'test-host',
  networkInterfaces: () => ({ en0: [{ family: 'IPv4', internal: false,
    address: '192.168.7.25', netmask: '255.255.255.0' }] }),
}))

const scope = { tenantId: 'tenant-demo', siteId: 'site-home' }
const physicalId = 'shellyproem50-001122334455'
const deviceId = `${physicalId}:em1:0`
const device = {
  id: deviceId, ...scope, kind: 'physical', trustStatus: 'approved',
  adapter: { driver: 'shelly-lan', protocol: 'http', configured: true },
  metadata: { physicalId, component: 'em1:0', channel: 0, networkScope: 'eero-lan' },
} as unknown as RegisteredDevice

function fixture(method = 'EM1.GetStatus?id=0') {
  const observedAt = '2026-11-04T12:00:00.000Z'
  const registry = { ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
    getDevices: jest.fn().mockReturnValue([device]) }
  const discovery = { listIdentityEvidence: jest.fn().mockResolvedValue([{
    ownership: scope, device: { vendor: 'Shelly', id: physicalId, protocol: 'http',
      networkZoneId: 'eero-lan', ipAddress: '192.168.7.54', observations: [
        { source: 'http_identity', attribute: 'identity.device_id', value: physicalId,
          observedAt, scopeId: 'eero-lan', method: 'GET /rpc/Shelly.GetDeviceInfo' },
        { source: 'http_identity', attribute: 'identity.verified', value: true,
          observedAt, scopeId: 'eero-lan' },
        { source: 'site_local_http_rpc', attribute: 'observer.identity', value: 'local-observer',
          scopeId: 'eero-lan', interfaceName: 'en0' },
        { source: 'site_local_http_rpc', attribute: 'shelly.component_status', value: 'em1:0',
          scopeId: 'eero-lan', interfaceName: 'en0', method },
      ],
    },
  }]) }
  const lan = { getConfiguredZone: jest.fn().mockReturnValue({
    id: 'eero-lan', cidr: '192.168.7.0/24', collectionSource: 'local',
  }) }
  const inventory = { forLogicalDevice: jest.fn().mockResolvedValue({
    physicalDeviceId: 'inv-one', scope,
    identities: [{ namespace: 'mqtt:shelly-protocol-id', value: physicalId }],
    components: [{ key: 'em1:0' }],
    assignments: [{ deviceId, physicalDeviceId: 'inv-one', componentKey: 'em1:0' }],
  }) }
  const resolver = new ShellyRouteResolver(registry as never, discovery as never, lan as never, inventory as never)
  return { resolver, lan }
}

describe('EM1 route is read-only and distinct from control', () => {
  const previous = process.env.HOME_SITE_LOCAL_OBSERVERS_JSON
  beforeEach(() => {
    process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = JSON.stringify([{
      id: 'local-observer', host: 'test-host', tenantId: scope.tenantId, siteId: scope.siteId,
      scopeId: 'eero-lan', cidr: '192.168.7.0/24', interfaceName: 'en0',
      expectedDeviceIds: [physicalId], expectedComponentKeys: ['em1:0'],
    }])
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.HOME_SITE_LOCAL_OBSERVERS_JSON
    else process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = previous
  })

  it('selects an identity- and component-verified local EM1 endpoint', async () => {
    const { resolver } = fixture()
    await expect(resolver.resolveAuthorizedLocalShellyEm1Target(device)).resolves.toMatchObject({
      physicalId, component: 'em1:0', channel: 0, ipAddress: '192.168.7.54',
      observer: { id: 'local-observer' },
    })
    await expect(resolver.resolveAuthorizedLocalShellyStatusTarget(device)).resolves.toBeNull()
    await expect(resolver.resolveShellyControlTarget(deviceId, scope)).rejects.toThrow(
      'Only an approved, configured Shelly switch installation is supported.',
    )
  })

  it('rejects switch RPC evidence for EM1, even with approved identity', async () => {
    const { resolver } = fixture('Switch.GetStatus?id=0')
    await expect(resolver.resolveAuthorizedLocalShellyEm1Target(device)).resolves.toBeNull()
  })

  it('rejects status evidence for another EM1 channel', async () => {
    const { resolver } = fixture('EM1.GetStatus?id=1')
    const onRejected = jest.fn()
    await expect(resolver.resolveAuthorizedLocalShellyEm1Target(device, undefined, onRejected)).resolves.toBeNull()
    expect(onRejected).toHaveBeenCalledWith('saved_identity_or_component_evidence_missing')
  })

  it('rejects a missing observer authorization without network reads', async () => {
    process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = '[]'
    const { resolver, lan } = fixture()
    await expect(resolver.resolveAuthorizedLocalShellyEm1Target(device)).resolves.toBeNull()
    expect(lan.getConfiguredZone).not.toHaveBeenCalled()
  })

  it('distinguishes an observer identity allowlist miss from an authorized scope', async () => {
    process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = JSON.stringify([{
      id: 'local-observer', host: 'test-host', tenantId: scope.tenantId, siteId: scope.siteId,
      scopeId: 'eero-lan', cidr: '192.168.7.0/24', interfaceName: 'en0',
      expectedDeviceIds: ['shellyproem50-ffffffffffff'], expectedComponentKeys: ['em1:0'],
    }])
    const { resolver } = fixture()
    const onRejected = jest.fn()
    await expect(resolver.resolveAuthorizedLocalShellyEm1Target(device, '192.168.7.54', onRejected)).resolves.toBeNull()
    expect(onRejected).toHaveBeenCalledWith('observer_identity_not_authorized')
  })

  it('rejects an observer configured for the wrong site with a scope authorization reason', async () => {
    process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = JSON.stringify([{
      id: 'other-site-observer', host: 'test-host', tenantId: scope.tenantId, siteId: 'site-other',
      scopeId: 'eero-lan', cidr: '192.168.7.0/24', interfaceName: 'en0',
      expectedDeviceIds: [physicalId], expectedComponentKeys: ['em1:0'],
    }])
    const { resolver } = fixture()
    const onRejected = jest.fn()
    await expect(resolver.resolveAuthorizedLocalShellyEm1Target(device, undefined, onRejected)).resolves.toBeNull()
    expect(onRejected).toHaveBeenCalledWith('site_scope_authorization_missing')
  })

  it('rejects a component outside the observer assignment before resolving endpoints', async () => {
    const { resolver } = fixture()
    const onRejected = jest.fn()
    await expect(resolver.resolveAuthorizedLocalShellyEm1Target({
      ...device, id: `${physicalId}:em1:1`, metadata: { ...device.metadata, component: 'em1:1', channel: 1 },
    } as RegisteredDevice, undefined, onRejected)).resolves.toBeNull()
    expect(onRejected).toHaveBeenCalledWith('observer_component_not_authorized')
  })
})
