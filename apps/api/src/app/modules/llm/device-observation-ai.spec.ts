import { DeviceAiInvestigationService } from './device-ai-investigation.service'
import type { LlmGatewayService } from './llm-gateway.service'
import {
  snapshotId,
  type DeviceEvidenceSnapshot,
} from './device-evidence'
import type {
  CapturedMqttSample,
} from './observation-profile-proposal'

describe('AI observation profile integration', () => {
  const snapshot: DeviceEvidenceSnapshot = {
    schemaVersion: 1,
    deviceId: 'temp-kitchen',
    createdAt: '2026-10-18T12:00:00.000Z',
    evidence: [{
      id: 'mqtt-observation-1',
      source: 'mqtt',
      attribute: 'captured-message',
      value: 'devices/temp-kitchen/data',
      observedAt: '2026-10-18T12:00:00.000Z',
      confidence: 'observed',
    }],
  }

  const samples: CapturedMqttSample[] = [{
    topic: 'devices/temp-kitchen/data',
    evidenceId: 'mqtt-observation-1',
    payload: {
      temperature: 25.3,
      humidity: 40.4,
      timestamp: 92671135,
    },
  }]

  function candidate() {
    return {
      schemaVersion: 1,
      deviceId: snapshot.deviceId,
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
      supportingEvidenceIds: ['mqtt-observation-1'],
    }
  }

  function setup(output: unknown) {
    const generate = jest.fn(async () => ({
      text: typeof output === 'string'
        ? output
        : JSON.stringify(output),
      provider: 'mock-local-llm',
      model: 'virtual-investigator',
    }))

    const investigator = new DeviceAiInvestigationService(
      { generate } as unknown as LlmGatewayService,
    )

    return { investigator, generate }
  }

  it('generates and validates a proposed MQTT profile', async () => {
    const { investigator, generate } = setup(candidate())

    const result =
      await investigator.proposeObservationProfileFromCapturedEvidence(
        snapshot,
        samples,
      )

    expect(result.provider).toBe('mock-local-llm')
    expect(result.proposal.status).toBe('proposed')
    expect(result.proposal.requiresApproval).toBe(true)
    expect(result.proposal.fields.temperature.rawKey)
      .toBe('temperature')

    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('rejects hallucinated field mappings', async () => {
    const invalid = candidate()
    invalid.fields.temperature.rawKey = 'imaginary_sensor'

    const { investigator } = setup(invalid)

    await expect(
      investigator.proposeObservationProfileFromCapturedEvidence(
        snapshot,
        samples,
      ),
    ).rejects.toThrow('evidence validation')
  })

  it('rejects attempted AI preapproval', async () => {
    const { investigator } = setup({
      ...candidate(),
      status: 'approved',
      requiresApproval: false,
    })

    await expect(
      investigator.proposeObservationProfileFromCapturedEvidence(
        snapshot,
        samples,
      ),
    ).rejects.toThrow('evidence validation')
  })

  it('rejects non-JSON model responses', async () => {
    const { investigator } = setup('I think this is a temperature sensor.')

    await expect(
      investigator.proposeObservationProfileFromCapturedEvidence(
        snapshot,
        samples,
      ),
    ).rejects.toThrow('invalid observation profile JSON')
  })

  it('rejects samples without matching observed MQTT evidence', async () => {
    const { investigator, generate } = setup(candidate())

    await expect(
      investigator.proposeObservationProfileFromCapturedEvidence(
        snapshot,
        [{
          ...samples[0],
          evidenceId: 'fabricated-evidence',
        }],
      ),
    ).rejects.toThrow('matching observed evidence')

    expect(generate).not.toHaveBeenCalled()
  })
})
