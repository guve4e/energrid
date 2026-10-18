import {
  BadGatewayException,
  NotFoundException,
} from '@nestjs/common'
import { DeviceAiInvestigationService } from './device-ai-investigation.service'
import { LlmGatewayService } from './llm-gateway.service'

describe('DeviceAiInvestigationService', () => {
  const generate = jest.fn()

  const service = new DeviceAiInvestigationService({
    generate,
  } as unknown as LlmGatewayService)

  beforeEach(() => {
    generate.mockReset()
  })

  const devices = [
    {
      id: 'host-1',
      hostname: 'exo',
      ipAddress: '192.168.1.92',
      secret: 'DO_NOT_SEND',
      observations: [
        { source: 'tcp', attribute: 'port.22.open', value: true },
      ],
    },
  ]

  it('rejects unknown devices without calling the LLM', async () => {
    await expect(
      service.investigate('missing', devices),
    ).rejects.toBeInstanceOf(NotFoundException)

    expect(generate).not.toHaveBeenCalled()
  })

  it('sends only allowlisted evidence and validates the report', async () => {
    generate.mockResolvedValue({
      provider: 'openai',
      model: 'test-model',
      text: JSON.stringify({
        summary: 'SSH is reachable.',
        findings: ['TCP port 22 is open.'],
        unknowns: ['The operating system is unknown.'],
        nextSteps: ['Ask the installer to identify the host.'],
        hypotheses: [],
        proposals: [],
      }),
    })

    const result = await service.investigate('host-1', devices)

    expect(result.report.findings).toEqual([
      'TCP port 22 is open.',
    ])

    const request = generate.mock.calls[0][0]

    expect(request.userPrompt).toContain('port.22.open')
    expect(request.userPrompt).not.toContain('DO_NOT_SEND')
    expect(request.systemPrompt).toContain('untrusted data')
  })

  it('rejects invented evidence references', async () => {
    generate.mockResolvedValue({
      provider: 'openai',
      model: 'test-model',
      text: JSON.stringify({
        summary: 'Possible SSH host',
        findings: [],
        unknowns: [],
        nextSteps: [],
        hypotheses: [
          {
            id: 'hyp_1',
            claim: 'This is a Raspberry Pi',
            confidence: 0.9,
            supportingEvidenceIds: ['invented-evidence'],
            contradictingEvidenceIds: [],
            missingEvidence: [],
          },
        ],
        proposals: [],
      }),
    })

    await expect(
      service.investigate('host-1', devices),
    ).rejects.toBeInstanceOf(BadGatewayException)
  })

  it('rejects malformed model output', async () => {
    generate.mockResolvedValue({
      provider: 'openai',
      model: 'test-model',
      text: 'This is probably a Raspberry Pi',
    })

    await expect(
      service.investigate('host-1', devices),
    ).rejects.toBeInstanceOf(BadGatewayException)
  })
})
