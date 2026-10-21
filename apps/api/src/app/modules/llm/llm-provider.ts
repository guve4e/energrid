export interface LlmRequest {
  correlationId?: string
  systemPrompt: string
  userPrompt: string
  maxOutputTokens?: number
  outputSchema?: LlmJsonSchema
}

export interface LlmJsonSchema {
  name: string
  schema: Record<string, unknown>
}

export interface LlmResponse {
  text: string
  provider: string
  model: string
}

export interface LlmProvider {
  readonly id: string
  generate(request: LlmRequest): Promise<LlmResponse>
  isAvailable?(): boolean
}
