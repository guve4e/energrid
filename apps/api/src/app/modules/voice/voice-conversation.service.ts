import { Injectable, Logger } from '@nestjs/common'
import { appendVoiceTrace } from './utils/voice-trace.util'
import OpenAI from 'openai'
import {
  VoiceConversationInput,
  VoiceConversationResult,
} from './voice-conversation.types'

type ChatTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }

export interface VoiceConversationStreamCallbacks {
  onTextDelta?: (delta: string) => Promise<void> | void
  onCompletedText?: (fullText: string) => Promise<void> | void
}

@Injectable()
export class VoiceConversationService {
  private readonly logger = new Logger(VoiceConversationService.name)
  private readonly verbose = process.env.VOICE_VERBOSE_LOGS === 'true'

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  private readonly history = new Map<string, ChatTurn[]>()
  private readonly maxTurnsPerConversation = 12

  async handleFinalTranscript(
    input: VoiceConversationInput,
  ): Promise<VoiceConversationResult> {
    const result = await this.handleFinalTranscriptStream(input)
    return { replyText: result.replyText }
  }

  async handleFinalTranscriptStream(
    input: VoiceConversationInput,
    callbacks?: VoiceConversationStreamCallbacks,
  ): Promise<VoiceConversationResult> {
    this.traceConversationInput(input)

    const trimmedTurns = this.appendUserTurn(input.conversationId, input.transcript)

    if (!process.env.OPENAI_API_KEY) {
      return this.handleMissingApiKey(input, callbacks)
    }

    const inputMessages = this.buildInputMessages(trimmedTurns)

    appendVoiceTrace({
      type: 'conversation_service_request',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      transcript: input.transcript,
      historyCount: trimmedTurns.length,
      history: trimmedTurns,
    })

    let replyText = ''

    const stream = await this.openai.responses.create({
      model: 'gpt-4o-mini',
      input: inputMessages,
      stream: true,
    })

    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'response.output_text.delta') {
        const delta = event.delta || ''
        if (!delta) continue

        replyText += delta
        this.traceConversationDelta(input, delta, replyText.length)
        await callbacks?.onTextDelta?.(delta)
        continue
      }

      if (event.type === 'response.completed') {
        break
      }
    }

    replyText = replyText.trim() || 'Съжалявам, не успях да отговоря.'

    this.appendAssistantTurn(input.conversationId, replyText)
    this.traceConversationOutput(input, replyText)

    await callbacks?.onCompletedText?.(replyText)

    return { replyText }
  }

  private appendUserTurn(
    conversationId: string,
    transcript: string,
  ): ChatTurn[] {
    const turns = this.history.get(conversationId) ?? []

    turns.push({
      role: 'user',
      text: transcript,
    })

    const trimmedTurns = turns.slice(-this.maxTurnsPerConversation)
    this.history.set(conversationId, trimmedTurns)

    return trimmedTurns
  }

  private appendAssistantTurn(conversationId: string, text: string): void {
    const turns = this.history.get(conversationId) ?? []
    turns.push({ role: 'assistant', text })
    this.history.set(conversationId, turns.slice(-this.maxTurnsPerConversation))
  }

  private buildInputMessages(turns: ChatTurn[]) {
    return [
      {
        role: 'system' as const,
        content: [
          {
            type: 'input_text' as const,
            text:
              'You are a Bulgarian voice assistant. ' +
              'Always answer in natural Bulgarian. ' +
              'Be concise, helpful, and conversational. ' +
              'Do not use markdown, bullets, or labels. ' +
              'Keep continuity with the recent conversation context.',
          },
        ],
      },
      ...turns.map((turn) => ({
        role: turn.role,
        content: [
          {
            type: 'input_text' as const,
            text: turn.text,
          },
        ],
      })),
    ]
  }

  private async handleMissingApiKey(
    input: VoiceConversationInput,
    callbacks?: VoiceConversationStreamCallbacks,
  ): Promise<VoiceConversationResult> {
    const fallback = `Чух: ${input.transcript}`

    this.appendAssistantTurn(input.conversationId, fallback)

    appendVoiceTrace({
      type: 'conversation_service_output',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      transcript: input.transcript,
      replyText: fallback,
      mode: 'fallback_no_api_key',
    })

    await callbacks?.onCompletedText?.(fallback)

    return { replyText: fallback }
  }

  private traceConversationInput(input: VoiceConversationInput): void {
    appendVoiceTrace({
      type: 'conversation_service_input',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      transcript: input.transcript,
    })

    if (this.verbose) {
      this.logger.log(
        `[CONVERSATION] session=${input.sessionId} conversation=${input.conversationId} user="${input.transcript}"`,
      )
    }
  }

  private traceConversationDelta(
    input: VoiceConversationInput,
    delta: string,
    accumulatedLength: number,
  ): void {
    appendVoiceTrace({
      type: 'conversation_service_delta',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      delta,
      accumulatedLength,
    })
  }

  private traceConversationOutput(
    input: VoiceConversationInput,
    replyText: string,
  ): void {
    appendVoiceTrace({
      type: 'conversation_service_output',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      transcript: input.transcript,
      replyText,
    })

    if (this.verbose) {
      this.logger.log(
        `[CONVERSATION REPLY] session=${input.sessionId} conversation=${input.conversationId} assistant="${replyText}"`,
      )
    }
  }
}
