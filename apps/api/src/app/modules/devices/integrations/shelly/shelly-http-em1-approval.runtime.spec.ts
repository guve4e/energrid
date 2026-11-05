import { ShellyOperationalCollectionService } from './shelly-operational-collection.service'

const tenantId = 'tenant-demo'
const siteId = 'site-home'
const deviceId = 'shellyproem50-8c4f00dbd258:em1:0'
const physicalId = 'shellyproem50-8c4f00dbd258'
const device = {
  id: deviceId, tenantId, siteId, trustStatus: 'approved', kind: 'physical',
  adapter: { id: 'shelly-lan', protocol: 'http', driver: 'shelly-lan', configured: true },
  metadata: { physicalId, component: 'em1:0', channel: 0,
    identityEvidenceSource: 'verified_shelly_http_rpc',
    componentEvidenceSource: 'verified_shelly_component_status_rpc',
    identityVerificationMethod: 'GET /rpc/Shelly.GetDeviceInfo',
    componentVerificationMethod: 'EM1.GetStatus?id=0',
    verifiedMeasurementFields: 'power', ipAddress: '192.0.2.20', networkScope: 'eero-lan' },
}

function fixture(authorized = true, conflict = false, routeFailure = 'observer_identity_not_authorized') {
  const installation = { updatedAt: '2026-11-04T18:00:00.000Z',
    ...(conflict ? { observationAuthority: { bindings: [{ deviceId, sourceId: 'shelly-mqtt' }] } } : {}) }
  const registry = {
    getApprovedInstallation: jest.fn().mockResolvedValue({ device, installation }),
    getDevices: jest.fn().mockReturnValue([device]),
    approveInstallationObservationAuthority: jest.fn().mockResolvedValue(true),
  }
  const routes = { resolveAuthorizedLocalShellyEm1Target: jest.fn().mockImplementation(async (_device, _endpoint, onRejected) => {
    if (!authorized) { onRejected?.(routeFailure); return null }
    return { device, physicalId, component: 'em1:0', channel: 0, ipAddress: '192.0.2.20',
      observer: { id: 'local-observer' }, zone: { id: 'eero-lan' }, interfaceAddress: '192.0.2.5' }
  }) }
  const service = new ShellyOperationalCollectionService(
    registry as never, undefined, undefined, undefined, routes as never,
  )
  return { service, registry, routes }
}

describe('EM1 HTTP administrator approval', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('performs exact identity and channel RPC before persisting power authority', async () => {
    const h = fixture()
    global.fetch = jest.fn().mockResolvedValueOnce({ status: 200, json: async () => ({ id: physicalId, gen: 2 }) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ id: 0, act_power: 1483.3 }) }) as never
    await h.service.approveHttpEm1Power({ tenantId, siteId, deviceId, actor: 'admin', confirmedEndpoint: '192.0.2.20' })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(h.registry.approveInstallationObservationAuthority).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, siteId, deviceId, actor: 'admin',
      authority: expect.objectContaining({ bindings: [expect.objectContaining({
        sourceId: 'shelly-http-em1', selector: 'EM1.GetStatus?id=0',
      })] }),
      evidence: expect.objectContaining({ sourceId: 'shelly-http-em1', fields: 'power' }),
    }))
  })

  it('never writes authority on a missing site-owned route', async () => {
    const h = fixture(false, false, 'observer_identity_not_authorized')
    global.fetch = jest.fn() as never
    await expect(h.service.approveHttpEm1Power({ tenantId, siteId, deviceId, actor: 'admin', confirmedEndpoint: '192.0.2.20' }))
      .rejects.toMatchObject({ response: {
        code: 'observer_identity_not_authorized',
        message: expect.stringContaining('verified physical Shelly identity'),
      } })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(h.registry.approveInstallationObservationAuthority).not.toHaveBeenCalled()
  })

  it.each([
    ['site_scope_authorization_missing', 'already authorized scope'],
    ['observer_component_not_authorized', 'exact EM1 component'],
    ['physical_inventory_assignment_mismatch', 'Physical Inventory record'],
    ['saved_identity_or_component_evidence_missing', 'fresh, authorized Shelly identity'],
  ])('returns safe remediation for route rejection %s', async (reasonCode, action) => {
    const h = fixture(false, false, reasonCode)
    global.fetch = jest.fn() as never
    await expect(h.service.approveHttpEm1Power({ tenantId, siteId, deviceId, actor: 'admin', confirmedEndpoint: '192.0.2.20' }))
      .rejects.toMatchObject({ response: { code: reasonCode, action: expect.stringContaining(action) } })
    expect(h.registry.approveInstallationObservationAuthority).not.toHaveBeenCalled()
  })

  it('never writes authority for a wrong identity or endpoint', async () => {
    const h = fixture()
    global.fetch = jest.fn().mockResolvedValueOnce({ status: 200, json: async () => ({ id: 'other', gen: 2 }) }) as never
    await expect(h.service.approveHttpEm1Power({ tenantId, siteId, deviceId, actor: 'admin', confirmedEndpoint: '192.0.2.20' }))
      .rejects.toThrow('Fresh Shelly identity')
    expect(h.registry.approveInstallationObservationAuthority).not.toHaveBeenCalled()
    await expect(h.service.approveHttpEm1Power({ tenantId, siteId, deviceId, actor: 'admin', confirmedEndpoint: '192.0.2.99' }))
      .rejects.toThrow('endpoint differs')
  })

  it('does not replace an existing MQTT authority', async () => {
    const h = fixture(true, true)
    global.fetch = jest.fn() as never
    await expect(h.service.approveHttpEm1Power({ tenantId, siteId, deviceId, actor: 'admin', confirmedEndpoint: '192.0.2.20' }))
      .rejects.toThrow('different observation authority')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(h.registry.approveInstallationObservationAuthority).not.toHaveBeenCalled()
  })

  it('requires a fresh successful RPC even when the saved identity timestamps are stale', async () => {
    const h = fixture()
    device.metadata.identityVerifiedAt = '2026-10-28T19:08:09.000Z'
    device.metadata.componentVerifiedAt = '2026-10-28T19:08:09.000Z'
    global.fetch = jest.fn().mockResolvedValueOnce({ status: 200, json: async () => ({ id: 'different-device', gen: 2 }) }) as never
    await expect(h.service.approveHttpEm1Power({ tenantId, siteId, deviceId, actor: 'admin', confirmedEndpoint: '192.0.2.20' }))
      .rejects.toThrow('Fresh Shelly identity')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(h.registry.approveInstallationObservationAuthority).not.toHaveBeenCalled()
  })
})
