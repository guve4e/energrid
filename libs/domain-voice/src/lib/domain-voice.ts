export function domainVoice(): string {
  return 'domain-voice';
}

export interface SpeechToTextRequest {
  audio: Uint8Array
  encoding: 'pcm_s16le'
  sampleRateHz: number
  channels: 1
  language: string
}

export interface SpeechToTextProvider {
  readonly id: string
  transcribe(request: SpeechToTextRequest): Promise<string>
}

export interface SpeechSynthesisRequest {
  text: string
  language: string
}

export interface SpeechAudio {
  audio: Uint8Array
  format: 'wav'
}

export interface SpeechSynthesisProvider {
  readonly id: string
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechAudio>
}

export type ConversationMessage = {
  role: 'system' | 'user' | 'assistant'
  text: string
}

export interface ConversationModelRequest {
  messages: ConversationMessage[]
}

export type ConversationModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'completed' }

export interface ConversationModelProvider {
  readonly id: string
  isConfigured(): boolean
  streamResponse(
    request: ConversationModelRequest,
  ): AsyncIterable<ConversationModelEvent>
}
