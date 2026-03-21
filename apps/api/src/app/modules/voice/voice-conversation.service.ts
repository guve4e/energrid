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
    appendVoiceTrace({
      type: 'conversation_service_input',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      transcript: input.transcript,
    })

    const turns = this.history.get(input.conversationId) ?? []

    turns.push({
      role: 'user',
      text: input.transcript,
    })

    const trimmedTurns = turns.slice(-this.maxTurnsPerConversation)
    this.history.set(input.conversationId, trimmedTurns)

    if (this.verbose) {
      this.logger.log(
        `[CONVERSATION] session=${input.sessionId} conversation=${input.conversationId} user="${input.transcript}"`,
      )
    }

    if (!process.env.OPENAI_API_KEY) {
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

      return { replyText: fallback }
    }

    const inputMessages = [
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
      ...trimmedTurns.map((turn) => ({
        role: turn.role,
        content: [
          {
            type: 'input_text' as const,
            text: turn.text,
          },
        ],
      })),
    ]

    appendVoiceTrace({
      type: 'conversation_service_request',
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      transcript: input.transcript,
      historyCount: trimmedTurns.length,
      history: trimmedTurns,
    })

    const response = await this.openai.responses.create({
      model: 'gpt-4o-mini',
      input: inputMessages,
    })

    const replyText =
      response.output_text?.trim() || 'Съжалявам, не успях да отговоря.'

    this.appendAssistantTurn(input.conversationId, replyText)

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

    return {
      replyText,
    }
  }

  private appendAssistantTurn(conversationId: string, text: string) {
    const turns = this.history.get(conversationId) ?? []
    turns.push({ role: 'assistant', text })
    this.history.set(conversationId, turns.slice(-this.maxTurnsPerConversation))
  }
}
