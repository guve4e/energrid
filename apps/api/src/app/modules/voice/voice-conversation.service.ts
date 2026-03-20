import { Injectable, Logger } from '@nestjs/common'
import OpenAI from 'openai'
import {
  VoiceConversationInput,
  VoiceConversationResult,
} from './voice-conversation.types'

@Injectable()
export class VoiceConversationService {
  private readonly logger = new Logger(VoiceConversationService.name)

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  async handleFinalTranscript(
    input: VoiceConversationInput,
  ): Promise<VoiceConversationResult> {
    this.logger.log(
      `Handling final transcript for session ${input.sessionId}: ${input.transcript}`,
    )

    if (!process.env.OPENAI_API_KEY) {
      this.logger.warn('OPENAI_API_KEY missing, using fallback reply')
      return {
        replyText: `Чух: ${input.transcript}`,
      }
    }

    const response = await this.openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                'You are a Bulgarian voice assistant. ' +
                'Always answer in natural Bulgarian. ' +
                'Keep answers concise, helpful, and conversational. ' +
                'Do not mention being an AI unless directly asked. ' +
                'No markdown, no bullet points, no labels.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: input.transcript,
            },
          ],
        },
      ],
    })

    const replyText =
      response.output_text?.trim() || 'Съжалявам, не успях да отговоря.'

    this.logger.log(
      `Conversation reply for session ${input.sessionId}: ${replyText}`,
    )

    return {
      replyText,
    }
  }
}
