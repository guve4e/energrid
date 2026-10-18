import { Injectable } from '@nestjs/common'
import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import type {
  SpeechSynthesisProvider,
  SpeechSynthesisRequest,
  SpeechToTextProvider,
  SpeechToTextRequest,
} from '@energrid/domain-voice'
import { pcm16MonoToWav } from './speech-audio.util'

@Injectable()
export class OpenAiBatchSttProvider implements SpeechToTextProvider {
  readonly id = 'openai'
  private client: OpenAI | null = null

  async transcribe(request: SpeechToTextRequest): Promise<string> {
    const wav = pcm16MonoToWav(request.audio, request.sampleRateHz)
    const file = await toFile(wav, 'turn.wav', { type: 'audio/wav' })
    const response = await this.getClient().audio.transcriptions.create(
      {
        file,
        model: process.env.BATCH_STT_MODEL || 'gpt-4o-transcribe',
        language: request.language,
      },
      { timeout: providerTimeoutMs('VOICE_STT_TIMEOUT_MS'), maxRetries: 0 },
    )
    return (response.text || '').trim()
  }

  private getClient(): OpenAI {
    if (!this.client) this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    return this.client
  }
}

@Injectable()
export class OpenAiSpeechSynthesisProvider implements SpeechSynthesisProvider {
  readonly id = 'openai'
  private client: OpenAI | null = null

  async synthesize(request: SpeechSynthesisRequest) {
    const response = await this.getClient().audio.speech.create(
      {
        model: process.env.VOICE_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: process.env.VOICE_TTS_VOICE || 'alloy',
        response_format: 'wav',
        input: request.text,
        instructions: `Speak naturally in ${languageName(request.language)}.`,
      },
      { timeout: providerTimeoutMs('VOICE_TTS_TIMEOUT_MS'), maxRetries: 0 },
    )
    return { format: 'wav' as const, audio: new Uint8Array(await response.arrayBuffer()) }
  }

  private getClient(): OpenAI {
    if (!this.client) this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    return this.client
  }
}

export function providerTimeoutMs(envName: string): number {
  const configured = Number(process.env[envName])
  if (!Number.isFinite(configured)) return 30_000
  return Math.max(1_000, Math.min(120_000, Math.floor(configured)))
}

function languageName(language: string): string {
  if (language.toLowerCase().startsWith('bg')) return 'Bulgarian'
  if (language.toLowerCase().startsWith('en')) return 'English'
  return language
}
