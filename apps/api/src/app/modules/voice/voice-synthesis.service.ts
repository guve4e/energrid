import { Inject, Injectable, Logger } from '@nestjs/common'
import type { SpeechSynthesisProvider } from '@energrid/domain-voice'
import { SPEECH_SYNTHESIS_PROVIDER } from './speech-provider.tokens'

export interface SynthesizedVoiceAudio {
  format: 'wav'
  audioBuffer: Buffer
}

@Injectable()
export class VoiceSynthesisService {
  private readonly logger = new Logger(VoiceSynthesisService.name)

  constructor(
    @Inject(SPEECH_SYNTHESIS_PROVIDER)
    private readonly provider: SpeechSynthesisProvider,
  ) {}

  async synthesize(text: string): Promise<SynthesizedVoiceAudio> {
    const normalizedText = this.normalizeText(text)

    if (!normalizedText) {
      throw new Error('Cannot synthesize empty text')
    }

    this.logger.log(
      `Synthesizing assistant audio for text length=${normalizedText.length}`,
    )

    const response = await this.provider.synthesize({
      text: normalizedText,
      language: process.env.VOICE_TTS_LANGUAGE || 'bg',
    })

    return {
      format: response.format,
      audioBuffer: Buffer.from(response.audio),
    }
  }

  private normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }
}
