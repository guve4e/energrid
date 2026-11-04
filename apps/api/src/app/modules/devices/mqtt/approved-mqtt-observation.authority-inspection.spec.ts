import { ApprovedMqttObservationRuntime } from './approved-mqtt-observation.runtime'

const scope = { tenantId: 'tenant-a', siteId: 'site-a' }
const deviceId = 'device:site-a:meter-1'

function makeInspection(options: {
  registryApproved?: boolean
  enrolled?: boolean
  installationApproved?: boolean
  duplicateBindings?: boolean
} = {}) {
  const device = {
    id: deviceId, tenantId: scope.tenantId, siteId: scope.siteId,
    kind: 'physical', trustStatus: 'approved',
  }
  const http = {
    deviceId, sourceId: 'source-http', selector: '/read',
    fields: { power: { rawKey: 'watts', type: 'number' } },
  }
  const mqtt = {
    deviceId, sourceId: 'source-mqtt', selector: 'home/meter/telemetry',
    fields: { power: { rawKey: 'power', type: 'number' } },
  }
  const installation = {
    schemaVersion: 1,
    device: { ...device, trustStatus: options.installationApproved === false ? 'discovered' : 'approved' },
    observationAuthority: {
      bindings: options.duplicateBindings ? [http, http, mqtt] : [http, mqtt],
      policy: {
        deviceId,
        allowedSourcesByField: { power: ['source-http', 'source-mqtt'] },
      },
    },
  }
  const registry = {
    ensureInstallationsLoaded: jest.fn(async () => undefined),
    getDevices: jest.fn(() => options.registryApproved === false ? [] : [device]),
  }
  const enrollment = {
    find: jest.fn(async () => options.enrolled === false ? null : { status: 'enrolled' }),
  }
  const installations = { get: jest.fn(async () => installation) }
  const runtime = new ApprovedMqttObservationRuntime(
    registry as never, installations as never, enrollment as never,
  )
  return { runtime, registry, enrollment, installations }
}

describe('read-only persisted observation authority inspection', () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.HOME_OBSERVATION_BINDINGS_JSON
    delete process.env.LAB_MQTT_OBSERVATION_BINDINGS_JSON
    process.env.HOME_HTTP_POLL_ENABLED = 'false'
    process.env.HOME_MQTT_INGEST_ENABLED = 'false'
  })

  afterAll(() => {
    process.env = oldEnv
  })

  it('shows multiple approved sources for a field without choosing a winner', async () => {
    const { runtime, registry, installations } = makeInspection()
    await expect(runtime.inspectPersistedObservationAuthority(scope, deviceId)).resolves.toEqual({
      status: 'installation_approved',
      sources: [
        { sourceId: 'source-http', selector: '/read', fields: ['power'] },
        { sourceId: 'source-mqtt', selector: 'home/meter/telemetry', fields: ['power'] },
      ],
    })
    expect(registry.ensureInstallationsLoaded).toHaveBeenCalledTimes(1)
    expect(installations.get).toHaveBeenCalledWith(scope, deviceId)
  })

  it('fails closed on duplicate source/selector bindings', async () => {
    const { runtime } = makeInspection({ duplicateBindings: true })
    const report = await runtime.inspectPersistedObservationAuthority(scope, deviceId)
    expect(report.sources).toEqual([
      { sourceId: 'source-mqtt', selector: 'home/meter/telemetry', fields: ['power'] },
    ])
  })

  it('does not expose bindings without exact approved enrollment and installation', async () => {
    await expect(makeInspection({ registryApproved: false }).runtime.inspectPersistedObservationAuthority(scope, deviceId))
      .resolves.toEqual({ status: 'device_not_approved', sources: [] })
    await expect(makeInspection({ enrolled: false }).runtime.inspectPersistedObservationAuthority(scope, deviceId))
      .resolves.toEqual({ status: 'device_not_enrolled', sources: [] })
    await expect(makeInspection({ installationApproved: false }).runtime.inspectPersistedObservationAuthority(scope, deviceId))
      .resolves.toEqual({ status: 'installation_not_approved', sources: [] })
    await expect(makeInspection().runtime.inspectPersistedObservationAuthority({ tenantId: 'tenant-other', siteId: scope.siteId }, deviceId))
      .resolves.toEqual({ status: 'device_not_approved', sources: [] })
  })
})
