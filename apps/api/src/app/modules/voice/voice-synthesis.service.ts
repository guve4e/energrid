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
    this.logger.log(`Synthesizing assistant audio for text length=${text.length}`)

    const response = await this.openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      response_format: 'wav',
      input: text,
    })

    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = Buffer.from(arrayBuffer)

    return {
      format: 'wav',
      audioBuffer,
    }
  }
}
