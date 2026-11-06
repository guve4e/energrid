import { DeviceIntelligenceObservationIngress } from '../../device-intelligence-observation-ingress'
import type { DeviceInstallationRecord } from '../../device-installation.store'

/**
 * Characterizes the existing protocol-independent ingress for a verified EM1
 * measurement. HTTP route authorization and polling are deliberately NOT
 * implemented here: that work must be done by the Shelly integration.
 */
const scope = { tenantId: 'tenant-demo', siteId: 'site-home' }
const deviceId = 'shellyproem50-08f9e0e84910:em1:0'
const sourceId = 'shelly-http-em1'
const selector = 'EM1.GetStatus?id=0'
const observedAt = '2026-11-04T18:00:00.000Z'
const evidenceId = 'verified-em1-http-reading-1'

function fixture() {
  const device = { id: deviceId, tenantId: scope.tenantId, siteId: scope.siteId,
    trustStatus: 'approved', kind: 'physical' }
  const installation = {
    schemaVersion: 1,
    device,
    observationAuthority: {
      bindings: [{ deviceId, sourceId, selector, fields: { power: { rawKey: 'power', type: 'number' } } }],
      policy: { deviceId, allowedSourcesByField: { power: [sourceId] } },
    },
  } as unknown as DeviceInstallationRecord
  const registry = {
    ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
    getDevices: jest.fn().mockReturnValue([device]),
  }
  const installations = { get: jest.fn().mockResolvedValue(installation) }
  const enrollment = { find: jest.fn().mockResolvedValue({ deviceId, status: 'enrolled' }) }
  const store = { process: jest.fn().mockResolvedValue({
    accepted: true, stage: 'observation', reason: 'accepted', updatedKeys: ['power'], rejectedFields: [],
    state: { fields: { power: { value: 121.4, sourceId, evidenceId, receivedAt: observedAt } } },
  }) }
  const history = { persistAccepted: jest.fn().mockResolvedValue([{ field: 'power', outcome: 'persisted' }]) }
  const ingress = new DeviceIntelligenceObservationIngress(
    registry as unknown as ConstructorParameters<typeof DeviceIntelligenceObservationIngress>[0],
    installations as unknown as ConstructorParameters<typeof DeviceIntelligenceObservationIngress>[1],
    enrollment as unknown as ConstructorParameters<typeof DeviceIntelligenceObservationIngress>[2],
    store as unknown as ConstructorParameters<typeof DeviceIntelligenceObservationIngress>[3],
    history as unknown as ConstructorParameters<typeof DeviceIntelligenceObservationIngress>[4],
  )
  const input = { scope, deviceId, sourceId, selector, payload: { power: 121.4 }, evidenceId }
  return { registry, installations, enrollment, store, history, ingress, input, installation }
}

describe('Shelly EM1 measurement through existing approved observation ingress', () => {
  it('accepts a separately approved HTTP EM1 source and writes measured power to history', async () => {
    const h = fixture()
    const result = await h.ingress.ingest(h.input)
    expect(result).toMatchObject({ outcome: 'processed', accepted: true, updatedKeys: ['power'] })
    expect(h.registry.getDevices).toHaveBeenCalledWith(true)
    expect(h.store.process).toHaveBeenCalledWith(scope, deviceId, expect.objectContaining({
      binding: expect.objectContaining({ deviceId, sourceId, selector,
        fields: { power: { rawKey: 'power', type: 'number' } } }),
      context: expect.objectContaining({ selector, evidenceId }),
      payload: { power: 121.4 },
    }))
    expect(h.history.persistAccepted).toHaveBeenCalledWith(expect.objectContaining({
      ...scope, deviceId, sourceId, selector, evidenceId,
      fields: [{ field: 'power', value: 121.4, observedAt, receivedAt: observedAt }],
    }))
  })

  it('does not treat an approved MQTT source as HTTP authority', async () => {
    const h = fixture()
    h.installation.observationAuthority!.bindings[0].sourceId = 'shelly-mqtt'
    h.installation.observationAuthority!.policy.allowedSourcesByField.power = ['shelly-mqtt']
    expect(await h.ingress.ingest(h.input)).toEqual({
      outcome: 'rejected', reasonCode: 'observation_authority_missing',
    })
    expect(h.store.process).not.toHaveBeenCalled()
    expect(h.history.persistAccepted).not.toHaveBeenCalled()
  })

  it('rejects a wrong channel selector rather than reusing another EM1 binding', async () => {
    const h = fixture()
    expect(await h.ingress.ingest({ ...h.input, selector: 'EM1.GetStatus?id=1' })).toEqual({
      outcome: 'rejected', reasonCode: 'observation_authority_missing',
    })
    expect(h.store.process).not.toHaveBeenCalled()
  })

  it('rejects missing and duplicate source bindings instead of guessing a winner', async () => {
    const h = fixture()
    h.installation.observationAuthority!.bindings.push({
      ...h.installation.observationAuthority!.bindings[0],
    })
    expect(await h.ingress.ingest(h.input)).toEqual({
      outcome: 'rejected', reasonCode: 'observation_authority_missing',
    })
    expect(h.store.process).not.toHaveBeenCalled()
    h.installation.observationAuthority = undefined
    expect(await h.ingress.ingest(h.input)).toEqual({
      outcome: 'rejected', reasonCode: 'observation_authority_missing',
    })
  })

  it('rejects a wrong site or a missing enrollment before observation/history writes', async () => {
    const h = fixture()
    expect(await h.ingress.ingest({ ...h.input, scope: { ...scope, siteId: 'other' } })).toEqual({
      outcome: 'rejected', reasonCode: 'device_not_approved',
    })
    h.enrollment.find.mockResolvedValue(null)
    expect(await h.ingress.ingest(h.input)).toEqual({
      outcome: 'rejected', reasonCode: 'device_not_enrolled',
    })
    expect(h.store.process).not.toHaveBeenCalled()
    expect(h.history.persistAccepted).not.toHaveBeenCalled()
  })
})
