import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'
import OpenAI from 'openai'
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from './llm-provider'

export type LlmMode = 'disabled' | 'local-only' | 'cloud-enabled'

@Injectable()
export class LlmGatewayService {
  private readonly providers = new Map<string, LlmProvider>()

  registerProvider(provider: LlmProvider): void {
    this.providers.set(provider.id, provider)
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const mode = this.getMode()

    if (mode === 'disabled') {
      throw new ServiceUnavailableException('LLM inference is disabled')
    }

    const providerId = process.env.ENERGRID_LLM_PROVIDER?.trim()
      || (mode === 'cloud-enabled' ? 'openai' : 'local')

    if (mode === 'local-only' && providerId !== 'local') {
      throw new ServiceUnavailableException(
        'Cloud providers are prohibited in local-only mode',
      )
    }

    if (mode === 'cloud-enabled' && providerId === 'local') {
      throw new ServiceUnavailableException(
        'Local inference must use local-only mode',
      )
    }

    const provider = this.providers.get(providerId)

    if (!provider) {
      throw new ServiceUnavailableException(
        `LLM provider "${providerId}" is unavailable`,
      )
    }

    return provider.generate(request)
  }

  getMode(): LlmMode {
    const mode = process.env.ENERGRID_LLM_MODE || 'local-only'

    if (
      mode !== 'disabled' &&
      mode !== 'local-only' &&
      mode !== 'cloud-enabled'
    ) {
      throw new ServiceUnavailableException(
        'Invalid ENERGRID_LLM_MODE configuration',
      )
    }

    return mode
  }
}

@Injectable()
export class OpenAiDeviceLlmProvider implements LlmProvider {
  readonly id = 'openai'

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const apiKey = process.env.OPENAI_API_KEY

    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY is not configured',
      )
    }

    const model = process.env.ENERGRID_LLM_MODEL || 'gpt-4o-mini'

    const client = new OpenAI({
      apiKey,
      timeout: 15000,
      maxRetries: 0,
    })

    const response = await client.responses.create({
      model,
      instructions: request.systemPrompt,
      input: request.userPrompt,
      max_output_tokens: Math.min(
        Math.max(request.maxOutputTokens ?? 1200, 1),
        2000,
      ),
      text: {
        format: {
          type: 'json_schema',
          name: 'energrid_device_investigation',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              findings: {
                type: 'array',
                items: { type: 'string' },
              },
              unknowns: {
                type: 'array',
                items: { type: 'string' },
              },
              nextSteps: {
                type: 'array',
                items: { type: 'string' },
              },
              hypotheses: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    claim: { type: 'string' },
                    confidence: { type: 'number' },
                    supportingEvidenceIds: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    contradictingEvidenceIds: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    missingEvidence: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                  required: [
                    'id',
                    'claim',
                    'confidence',
                    'supportingEvidenceIds',
                    'contradictingEvidenceIds',
                    'missingEvidence',
                  ],
                  additionalProperties: false,
                },
              },
              proposals: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    action: {
                      type: 'string',
                      enum: [
                        'inspect_mdns',
                        'inspect_ssdp',
                        'inspect_http_headers',
                        'inspect_service_banner',
                        'review_registry',
                        'manual_identification',
                      ],
                    },
                    reason: { type: 'string' },
                    requiredEvidenceIds: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    requiresApproval: {
                      type: 'boolean',
                      enum: [true],
                    },
                    status: {
                      type: 'string',
                      enum: ['proposed'],
                    },
                  },
                  required: [
                    'id',
                    'action',
                    'reason',
                    'requiredEvidenceIds',
                    'requiresApproval',
                    'status',
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: [
              'summary',
              'findings',
              'unknowns',
              'nextSteps',
              'hypotheses',
              'proposals',
            ],
            additionalProperties: false,
          },
        },
      },
    })

    return {
      text: response.output_text,
      provider: this.id,
      model,
    }
  }
}
