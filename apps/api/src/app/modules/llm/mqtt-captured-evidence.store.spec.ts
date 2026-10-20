import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MqttCapturedEvidenceStore } from './mqtt-captured-evidence.store'
import { DeviceAiInvestigationService } from './device-ai-investigation.service'
import { snapshotId } from './device-evidence'

describe('Durable MQTT evidence capture', () => {
  const scope = {
    tenantId: 'test-tenant',
    siteId: 'test-site',
  }

  const message = {
    scope,
    deviceId: 'temp-kitchen',
    topic: 'devices/temp-kitchen/data',
    payloadText: JSON.stringify({
      temperature: 25.3,
      humidity: 40.4,
      timestamp: 92671135,
    }),
  }

  let directory: string
  let store: MqttCapturedEvidenceStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'energrid-mqtt-evidence-'))
    store = new MqttCapturedEvidenceStore(directory)
  })

  afterEach(async () => {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('persists captured payloads across storage restart', async () => {
    const id = await store.capture(message)

    await store.close()
    store = new MqttCapturedEvidenceStore(directory)

    const { snapshot, samples } =
      await store.readInvestigationEvidence(
        scope,
        'temp-kitchen',
      )

    expect(snapshot.evidence).toHaveLength(1)
    expect(snapshot.evidence[0].id).toBe(id)
    expect(snapshot.evidence[0].source).toBe('mqtt')
    expect(snapshot.evidence[0].confidence).toBe('observed')

    expect(samples[0].payload).toEqual({
      temperature: 25.3,
      humidity: 40.4,
      timestamp: 92671135,
    })
  })

  it('isolates evidence by site and device', async () => {
    await store.capture(message)

    const otherSite = await store.readInvestigationEvidence(
      { tenantId: 'test-tenant', siteId: 'other-site' },
      'temp-kitchen',
    )

    const otherDevice = await store.readInvestigationEvidence(
      scope,
      'temp-garage',
    )

    expect(otherSite.samples).toHaveLength(0)
    expect(otherDevice.samples).toHaveLength(0)
  })

  it('refuses credential-like payload fields', async () => {
    await expect(store.capture({
      ...message,
      payloadText: JSON.stringify({
        temperature: 25.3,
        password: 'example-secret',
      }),
    })).rejects.toThrow('sensitive')
  })

  it('rejects MQTT wildcard topics', async () => {
    await expect(store.capture({
      ...message,
      topic: 'devices/+/data',
    })).rejects.toThrow('Invalid MQTT evidence')
  })

  it('produces evidence the existing investigator can consume', async () => {
    await store.capture(message)

    const { snapshot, samples } =
      await store.readInvestigationEvidence(
        scope,
        'temp-kitchen',
      )

    const evidenceId = snapshot.evidence[0].id

    const generate = jest.fn(async () => ({
      provider: 'mock-local',
      model: 'test-model',
      text: JSON.stringify({
        schemaVersion: 1,
        deviceId: 'temp-kitchen',
        snapshotId: snapshotId(snapshot),
        status: 'proposed',
        requiresApproval: true,
        protocol: 'mqtt',
        selector: 'devices/temp-kitchen/data',
        fields: {
          temperature: {
            rawKey: 'temperature',
            type: 'number',
          },
          humidity: {
            rawKey: 'humidity',
            type: 'number',
          },
        },
        supportingEvidenceIds: [evidenceId],
      }),
    }))

    const investigator = new DeviceAiInvestigationService(
      { generate } as any,
    )

    const result =
      await investigator.proposeObservationProfileFromCapturedEvidence(
        snapshot,
        samples,
      )

    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.proposal.status).toBe('proposed')
    expect(result.proposal.fields.temperature.rawKey)
      .toBe('temperature')
  })
})
