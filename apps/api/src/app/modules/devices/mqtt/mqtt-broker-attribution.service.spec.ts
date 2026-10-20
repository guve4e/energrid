import { payloadSha256, signBrokerPublisherEvidence, type BrokerPublisherEvidenceV1 } from './broker-publisher-evidence'
import { brokerAttributionOptions, MqttBrokerAttributionService } from './mqtt-broker-attribution.service'

const brokerId = 'house-broker-pi'
const clientId = 'wall-switch-client-17'
const protocolId = 'shellyplus1-78ee4ccf4b54'
const key = 'test-only-key-which-is-at-least-32-bytes-long'
const timestamp = '2026-10-20T16:00:00.000Z'
const payloadText = JSON.stringify({
  src: protocolId,
  params: { 'switch:0': { output: false } },
})
const topic = `${protocolId}/events/rpc`

function signedEvent(overrides: Partial<Omit<BrokerPublisherEvidenceV1, 'signature'>> = {}) {
  const unsigned = {
    version: 1 as const,
    eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a1',
    brokerId,
    kind: 'publish' as const,
    clientId,
    peerIp: '192.168.1.44',
    topic,
    payloadSha256: payloadSha256(payloadText),
    observedAt: timestamp,
    ...overrides,
  }
  return { ...unsigned, signature: signBrokerPublisherEvidence(unsigned, key) }
}

describe('MqttBrokerAttributionService', () => {
  let originalEnv: NodeJS.ProcessEnv
  let inventory: {
    recordMqttPublisherEvidence: jest.Mock
    associateMqttPublisherEvidence: jest.Mock
    updateMqttPublisherIdentityVerification: jest.Mock
    pruneMqttPublisherEvidence: jest.Mock
    refreshNetworkObservations: jest.Mock
  }
  let memory: { recordIdentityObservation: jest.Mock }
  let service: MqttBrokerAttributionService
  let clock: number

  beforeEach(() => {
    originalEnv = { ...process.env }
    process.env.HOME_MQTT_ATTRIBUTION_ENABLED = 'true'
    process.env.HOME_MQTT_ATTRIBUTION_BROKER_ID = brokerId
    process.env.HOME_MQTT_ATTRIBUTION_CLIENT_ID = 'energrid-attribution-test'
    process.env.HOME_MQTT_ATTRIBUTION_HMAC_KEY = key
    process.env.HOME_MQTT_ATTRIBUTION_USERNAME = 'attribution-reader'
    process.env.HOME_MQTT_ATTRIBUTION_PASSWORD = 'attribution-password'
    process.env.HOME_MQTT_HOST = 'broker.test'
    process.env.HOME_MQTT_PORT = '1883'
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({
      zones: [
        {
          id: 'house',
          name: 'HouseNet',
          cidr: '192.168.1.0/24',
          seedIps: [],
          gatewayIps: ['192.168.1.1'],
        },
      ],
    })
    clock = Date.parse(timestamp)
    inventory = {
      recordMqttPublisherEvidence: jest.fn().mockResolvedValue(true),
      associateMqttPublisherEvidence: jest.fn().mockResolvedValue(undefined),
      updateMqttPublisherIdentityVerification: jest.fn().mockResolvedValue(undefined),
      pruneMqttPublisherEvidence: jest.fn().mockResolvedValue(undefined),
      refreshNetworkObservations: jest.fn().mockResolvedValue(undefined),
    }
    memory = {
      recordIdentityObservation: jest.fn().mockResolvedValue(undefined),
    }
    const registry = {
      getSnapshot: () => ({ tenant: { id: 'tenant' }, site: { id: 'site' } }),
    }
    service = new MqttBrokerAttributionService(registry as never, inventory as never, memory as never, () => clock)
  })

  afterEach(() => {
    process.env = originalEnv
    jest.restoreAllMocks()
  })

  it('correlates a client ID to the Shelly protocol ID by topic and payload hash, then promotes only exact RPC identity', async () => {
    const rpc = mockRpc({
      id: protocolId,
      model: 'SNSW-001X16EU',
      gen: 2,
      mac: '78:ee:4c:cf:4b:54',
    })
    await service.acceptEvidence(JSON.stringify(signedEvent()))
    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledTimes(1)
    expect(inventory.associateMqttPublisherEvidence).not.toHaveBeenCalled()
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
    await settleWork()

    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledWith(
      { tenantId: 'tenant', siteId: 'site' },
      expect.objectContaining({
        clientId,
        identityVerification: 'unmatched',
        peerIp: '192.168.1.44',
      }),
    )
    expect(inventory.associateMqttPublisherEvidence).toHaveBeenCalledWith(
      { tenantId: 'tenant', siteId: 'site' },
      brokerId,
      '72ab11cd-105e-4c22-a9bc-c59c09f809a1',
      'physical-1',
      protocolId,
    )
    expect(inventory.updateMqttPublisherIdentityVerification).toHaveBeenCalledWith(
      { tenantId: 'tenant', siteId: 'site' },
      brokerId,
      '72ab11cd-105e-4c22-a9bc-c59c09f809a1',
      'rpc_verified',
      '192.168.1.44',
    )
    expect(inventory.refreshNetworkObservations).toHaveBeenCalledWith({ tenantId: 'tenant', siteId: 'site' }, [
      expect.objectContaining({
        physicalDeviceId: 'physical-1',
        ipAddress: '192.168.1.44',
        networkScope: 'gateway-unknown:house',
        evidenceSource: 'mqtt_broker_publisher_attribution_exact_shelly_rpc',
      }),
    ])
    expect(memory.recordIdentityObservation).toHaveBeenCalledWith(
      timestamp,
      expect.objectContaining({
        id: protocolId,
        ipAddress: '192.168.1.44',
        deviceReportedMacAddress: '78:ee:4c:cf:4b:54',
      }),
    )
    expect(memory.recordIdentityObservation.mock.calls[0][1]).not.toHaveProperty('macAddress')
    expect(inventory.recordMqttPublisherEvidence.mock.calls[0][1].clientId).not.toBe(protocolId)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('uses dedicated attribution MQTT credentials without inheriting ordinary MQTT credentials', () => {
    process.env.HOME_MQTT_USERNAME = 'ordinary-ingest-user'
    process.env.HOME_MQTT_PASSWORD = 'ordinary-ingest-password'
    process.env.HOME_MQTT_ATTRIBUTION_USERNAME = 'attribution-reader'
    process.env.HOME_MQTT_ATTRIBUTION_PASSWORD = 'attribution-password'

    expect(brokerAttributionOptions(process.env)).toMatchObject({
      username: 'attribution-reader',
      password: 'attribution-password',
    })
    expect(brokerAttributionOptions(process.env)?.username).not.toBe(process.env.HOME_MQTT_USERNAME)
    expect(brokerAttributionOptions(process.env)?.password).not.toBe(process.env.HOME_MQTT_PASSWORD)
  })

  it.each([
    ['username', 'HOME_MQTT_ATTRIBUTION_USERNAME'],
    ['password', 'HOME_MQTT_ATTRIBUTION_PASSWORD'],
  ])('fails closed when dedicated attribution %s is missing', (_label, variable) => {
    process.env.HOME_MQTT_USERNAME = 'ordinary-ingest-user'
    process.env.HOME_MQTT_PASSWORD = 'ordinary-ingest-password'
    process.env.HOME_MQTT_ATTRIBUTION_USERNAME = 'attribution-reader'
    process.env.HOME_MQTT_ATTRIBUTION_PASSWORD = 'attribution-password'
    delete process.env[variable]

    expect(() => brokerAttributionOptions(process.env)).toThrow(
      'MQTT broker attribution requires HOME_MQTT_ATTRIBUTION_USERNAME and HOME_MQTT_ATTRIBUTION_PASSWORD',
    )
  })

  it('retains broker evidence but rejects a wrong Shelly RPC identity', async () => {
    mockRpc({ id: 'shellyplus1-other', gen: 2 })
    await pair()
    await settleWork()
    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledTimes(1)
    expect(inventory.recordMqttPublisherEvidence.mock.calls[0][1]).toMatchObject({
      identityVerification: 'unmatched',
    })
    expect(inventory.updateMqttPublisherIdentityVerification).toHaveBeenCalledWith(
      expect.anything(),
      brokerId,
      expect.any(String),
      'rpc_mismatch',
    )
    expect(inventory.refreshNetworkObservations).not.toHaveBeenCalled()
    expect(memory.recordIdentityObservation).not.toHaveBeenCalled()
  })

  it('keeps public NAT, gateway, and out-of-scope peer addresses as broker-only evidence', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
    await service.acceptEvidence(JSON.stringify(signedEvent({ peerIp: '89.106.117.205' })))
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
    await settleWork()
    expect(inventory.updateMqttPublisherIdentityVerification).toHaveBeenCalledWith(
      expect.anything(),
      brokerId,
      expect.any(String),
      'not_plausible',
    )
    expect(fetchSpy).not.toHaveBeenCalled()

    service = newService()
    await service.acceptEvidence(
      JSON.stringify(
        signedEvent({
          eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a2',
          peerIp: '192.168.1.1',
        }),
      ),
    )
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
    await settleWork()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not choose between multiple publishers for an identical topic and payload', async () => {
    await service.acceptEvidence(JSON.stringify(signedEvent()))
    await service.acceptEvidence(
      JSON.stringify(
        signedEvent({
          eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a2',
          clientId: 'other-publisher',
          peerIp: '192.168.1.45',
        }),
      ),
    )
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
    await settleWork()
    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledTimes(2)
    expect(inventory.associateMqttPublisherEvidence).not.toHaveBeenCalled()
    expect(inventory.refreshNetworkObservations).not.toHaveBeenCalled()
  })

  it('waits briefly for competing publisher evidence before correlating an identical payload', async () => {
    mockRpc({ id: protocolId, gen: 2 })
    await service.acceptEvidence(JSON.stringify(signedEvent()))
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    await service.acceptEvidence(JSON.stringify(signedEvent({
      eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a6',
      clientId: 'other-publisher',
      peerIp: '192.168.1.45',
      observedAt: new Date(clock + 10).toISOString(),
    })))
    await new Promise<void>(resolve => setTimeout(resolve, 120))
    await settleWork()

    expect(inventory.associateMqttPublisherEvidence).not.toHaveBeenCalled()
    expect(inventory.refreshNetworkObservations).not.toHaveBeenCalled()
    expect(memory.recordIdentityObservation).not.toHaveBeenCalled()
  })

  it('rejects forged and stale events, and deduplicates redelivered events', async () => {
    const forged = signedEvent()
    await service.acceptEvidence(JSON.stringify({ ...forged, clientId: 'attacker' }))
    await service.acceptEvidence(
      JSON.stringify(
        signedEvent({
          eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a3',
          observedAt: new Date(clock - 31_000).toISOString(),
        }),
      ),
    )
    const valid = signedEvent()
    await service.acceptEvidence(JSON.stringify(valid))
    await service.acceptEvidence(JSON.stringify(valid))
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
    await settleWork()
    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledTimes(1)
    expect(inventory.associateMqttPublisherEvidence).toHaveBeenCalledTimes(1)
  })

  it('ignores oversized and malformed envelopes without touching persistence', async () => {
    await expect(service.acceptEvidence('{malformed')).resolves.toBeUndefined()
    await expect(service.acceptEvidence('x'.repeat(9000))).resolves.toBeUndefined()
    expect(inventory.recordMqttPublisherEvidence).not.toHaveBeenCalled()
  })

  it('does not acknowledge a valid broker event until its raw evidence is persisted', async () => {
    inventory.recordMqttPublisherEvidence.mockRejectedValueOnce(new Error('database unavailable'))
    const event = JSON.stringify(signedEvent())
    await expect(service.acceptEvidence(event)).rejects.toThrow('database unavailable')

    inventory.recordMqttPublisherEvidence.mockResolvedValue(true)
    await expect(service.acceptEvidence(event)).resolves.toBeUndefined()
    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledTimes(2)
  })

  it('deduplicates a signed event while its first persistence is still pending', async () => {
    let finishPersistence!: () => void
    inventory.recordMqttPublisherEvidence.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPersistence = resolve
        }),
    )
    const event = JSON.stringify(signedEvent())
    const firstDelivery = service.acceptEvidence(event)
    const duplicateDelivery = service.acceptEvidence(event)

    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledTimes(1)
    finishPersistence()
    await Promise.all([firstDelivery, duplicateDelivery])
  })

  it('does not correlate an event that PostgreSQL has already recorded', async () => {
    inventory.recordMqttPublisherEvidence.mockResolvedValueOnce(false)
    await service.acceptEvidence(JSON.stringify(signedEvent()))
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
    await settleWork()

    expect(inventory.associateMqttPublisherEvidence).not.toHaveBeenCalled()
    expect(inventory.refreshNetworkObservations).not.toHaveBeenCalled()
    expect(memory.recordIdentityObservation).not.toHaveBeenCalled()
  })

  it('records a matched disconnect and accepts a fresh reconnect as a new broker event', async () => {
    mockRpc({ id: protocolId, gen: 2 })
    await service.acceptEvidence(JSON.stringify(signedEvent()))
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
    await settleWork()
    const disconnect = signedEvent({
      eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a4',
      kind: 'disconnect',
      topic: null,
      payloadSha256: null,
      observedAt: new Date(clock + 1000).toISOString(),
    })
    clock += 1000
    await service.acceptEvidence(JSON.stringify(disconnect))
    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledTimes(2)
    expect(inventory.recordMqttPublisherEvidence.mock.calls[1][1]).toMatchObject({
      connectionState: 'disconnected',
      clientId,
      peerIp: '192.168.1.44',
    })
  })

  it('retains a disconnect event even when its publisher was not correlated in this process', async () => {
    const disconnect = signedEvent({
      eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a5',
      kind: 'disconnect',
      topic: null,
      payloadSha256: null,
    })
    await service.acceptEvidence(JSON.stringify(disconnect))
    expect(inventory.recordMqttPublisherEvidence).toHaveBeenCalledTimes(1)
    expect(inventory.recordMqttPublisherEvidence.mock.calls[0][1]).toMatchObject({
      connectionState: 'disconnected',
      identityVerification: 'unmatched',
    })
    expect(inventory.recordMqttPublisherEvidence.mock.calls[0][1]).not.toHaveProperty('physicalDeviceId')
  })

  it('does not enroll devices or authorize control while promoting verified network evidence', async () => {
    mockRpc({ id: protocolId, gen: 2 })
    const registry = {
      getSnapshot: jest.fn(() => ({
        tenant: { id: 'tenant' },
        site: { id: 'site' },
      })),
      enroll: jest.fn(),
      approve: jest.fn(),
      execute: jest.fn(),
    }
    service = new MqttBrokerAttributionService(registry as never, inventory as never, memory as never, () => clock)
    await pair()
    await settleWork()
    expect(registry.enroll).not.toHaveBeenCalled()
    expect(registry.approve).not.toHaveBeenCalled()
    expect(registry.execute).not.toHaveBeenCalled()
  })

  it('retains persistent broker evidence for a bounded 90-day window', async () => {
    const serviceWithRetention = service as unknown as {
      pruneExpiredEvidence(): Promise<void>
    }
    await serviceWithRetention.pruneExpiredEvidence()
    expect(inventory.pruneMqttPublisherEvidence).toHaveBeenCalledWith(
      { tenantId: 'tenant', siteId: 'site' },
      new Date(clock - 90 * 24 * 60 * 60 * 1000).toISOString(),
    )
  })

  async function pair() {
    await service.acceptEvidence(JSON.stringify(signedEvent()))
    service.observeShellyMessage({
      topic,
      payloadText,
      protocolId,
      componentKeys: ['switch:0'],
      physicalDeviceId: 'physical-1',
      observedAt: timestamp,
    })
  }

  function newService() {
    const registry = {
      getSnapshot: () => ({ tenant: { id: 'tenant' }, site: { id: 'site' } }),
    }
    return new MqttBrokerAttributionService(registry as never, inventory as never, memory as never, () => clock)
  }

  function mockRpc(info: Record<string, unknown>) {
    return jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => info,
    } as Response)
  }

  async function settleWork() {
    await new Promise<void>((resolve) => setTimeout(resolve, 120))
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve))
  }
})
