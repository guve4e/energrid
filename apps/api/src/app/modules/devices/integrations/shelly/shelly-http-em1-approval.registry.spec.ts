import { DeviceRegistryService } from '../../device-registry.service'
import { shellyHttpEm1Approval } from './shelly-http-em1-observation-approval'

const tenantId = 'tenant-demo'
const siteId = 'site-home'
const deviceId = 'shellyproem50-8c4f00dbd258:em1:0'

function fixture(authority?: unknown) {
  const device = {
    id: deviceId, tenantId, siteId, kind: 'physical', trustStatus: 'approved',
    displayName: 'Energy meter', zoneId: 'kitchen', zoneName: 'Kitchen',
    adapter: { id: 'shelly-lan', driver: 'shelly-lan', protocol: 'http', configured: true },
    capabilities: [{ kind: 'power', actions: ['read'], unit: 'W' }],
    state: { values: {}, observedAt: null, source: 'device-store', status: 'unknown' },
    metadata: { physicalId: 'shellyproem50-8c4f00dbd258', component: 'em1:0', channel: 0 },
  }
  const installation = {
    schemaVersion: 1, device,
    ...(authority ? { observationAuthority: authority } : {}),
    physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
    updatedAt: '2026-11-04T18:00:00.000Z',
  }
  const store = { listAll: jest.fn().mockResolvedValue([installation]),
    save: jest.fn().mockResolvedValue(undefined), append: jest.fn().mockResolvedValue(undefined) }
  const enrollment = { list: jest.fn().mockResolvedValue([{ deviceId, status: 'enrolled' }]),
    find: jest.fn().mockResolvedValue({ deviceId, status: 'enrolled' }) }
  const previous = process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON
  process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON = '{}'
  const registry = new DeviceRegistryService(undefined, store as never, enrollment as never)
  return { registry, store, enrollment, installation, restore: () => {
    if (previous === undefined) delete process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON
    else process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON = previous
  } }
}

describe('generic site-scoped installation authority storage', () => {
  it('accepts an adapter-built EM1 binding without adding control', async () => {
    const h = fixture()
    try {
      const current = await h.registry.getApprovedInstallation(tenantId, siteId, deviceId)
      expect(current?.installation.observationAuthority).toBeUndefined()
      const saved = await h.registry.approveInstallationObservationAuthority({
        tenantId, siteId, deviceId, actor: 'admin@example.test',
        expectedUpdatedAt: h.installation.updatedAt, authority: shellyHttpEm1Approval(deviceId),
        evidence: { sourceId: 'shelly-http-em1', selector: 'EM1.GetStatus?id=0', fields: 'power' },
      })
      expect(saved).toBe(true)
      expect(h.store.save).toHaveBeenCalledWith(expect.objectContaining({
        observationAuthority: shellyHttpEm1Approval(deviceId),
      }))
      expect(h.store.append).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'observation_authority_approved', actor: 'admin@example.test',
      }))
      const after = await h.registry.getApprovedInstallation(tenantId, siteId, deviceId)
      expect(after?.installation.device).not.toHaveProperty('control', expect.objectContaining({ status: 'ready' }))
    } finally { h.restore() }
  })

  it('refuses another site, stale installation snapshot and conflicting MQTT authority', async () => {
    const h = fixture()
    try {
      const request = { tenantId, siteId, deviceId, actor: 'operator', expectedUpdatedAt: h.installation.updatedAt,
        authority: shellyHttpEm1Approval(deviceId), evidence: { sourceId: 'shelly-http-em1' } }
      expect(await h.registry.approveInstallationObservationAuthority({ ...request, siteId: 'other-site' })).toBe(false)
      await expect(h.registry.approveInstallationObservationAuthority({ ...request, expectedUpdatedAt: 'old' }))
        .rejects.toThrow('Installation changed')
      expect(h.store.save).not.toHaveBeenCalled()
    } finally { h.restore() }
    const conflicting = fixture({ bindings: [{ deviceId, sourceId: 'shelly-mqtt', selector: 'topic',
      fields: { power: { rawKey: 'power', type: 'number' } } }],
      policy: { deviceId, allowedSourcesByField: { power: ['shelly-mqtt'] } } })
    try {
      await expect(conflicting.registry.approveInstallationObservationAuthority({
        tenantId, siteId, deviceId, actor: 'operator', expectedUpdatedAt: conflicting.installation.updatedAt,
        authority: shellyHttpEm1Approval(deviceId), evidence: { sourceId: 'shelly-http-em1' },
      })).rejects.toThrow('different observation authority')
      expect(conflicting.store.save).not.toHaveBeenCalled()
    } finally { conflicting.restore() }
  })
})
