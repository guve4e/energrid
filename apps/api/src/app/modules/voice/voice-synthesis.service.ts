import { Injectable, Logger } from '@nestjs/common'
import OpenAI from 'openai'

export interface SynthesizedVoiceAudio {
  format: 'wav'
  audioBuffer: Buffer
}

@Injectable()
export class VoiceSynthesisService {
  private readonly logger = new Logger(VoiceSynthesisService.name)

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  async synthesize(text: string): Promise<SynthesizedVoiceAudio> {
    const normalizedText = this.normalizeText(text)

    this.logger.log(
      `Synthesizing assistant audio for text length=${normalizedText.length}`,
    )

    const response = await this.openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      response_format: 'wav',
      input: normalizedText,
    })

    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = Buffer.from(arrayBuffer)

    return {
      format: 'wav',
      audioBuffer,
    }
  }

  private normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }
}
