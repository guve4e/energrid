import { Injectable } from '@nestjs/common'
import OpenAI from 'openai'
import type {
  ConversationModelProvider,
  ConversationModelRequest,
} from '@energrid/domain-voice'
import { providerTimeoutMs } from './openai-speech.providers'

@Injectable()
export class OpenAiConversationModelProvider implements ConversationModelProvider {
  readonly id = 'openai'
  private client: OpenAI | null = null

  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY)
  }

  async *streamResponse(request: ConversationModelRequest) {
    const input = request.messages.map(({ role, text }) => ({ role, content: text }))
    const stream = await this.getClient().responses.create(
      {
        model: process.env.VOICE_CHAT_MODEL || 'gpt-4o-mini',
        input,
        stream: true,
      },
      { timeout: providerTimeoutMs('VOICE_CHAT_TIMEOUT_MS'), maxRetries: 0 },
    )

    let completed = false
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'response.output_text.delta' && event.delta) {
        yield { type: 'text_delta' as const, text: event.delta }
      } else if (event.type === 'response.completed') {
        completed = true
        yield { type: 'completed' as const }
        break
      } else if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error('Conversation model request failed')
      }
    }
    if (!completed) throw new Error('Conversation model stream ended before completion')
  }

  private getClient(): OpenAI {
    if (!this.client) this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    return this.client
  }
}
