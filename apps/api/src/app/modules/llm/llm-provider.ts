export interface LlmRequest {
  correlationId?: string
  systemPrompt: string
  userPrompt: string
  maxOutputTokens?: number
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
