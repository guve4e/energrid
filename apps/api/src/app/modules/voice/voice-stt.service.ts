import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import type { SpeechToTextProvider } from '@energrid/domain-voice'
import type { IStreamingSttProvider } from '@energrid/stt-stream-core'
import type {
  StreamingSttEvent,
  StreamingSttSession,
} from '@energrid/stt-stream-core'
import { SPEECH_TO_TEXT_PROVIDERS, STREAMING_STT_PROVIDERS } from './speech-provider.tokens'

@Injectable()
export class VoiceSttService {
  private readonly logger = new Logger(VoiceSttService.name)

  constructor(
    @Inject(SPEECH_TO_TEXT_PROVIDERS)
    private readonly providers: SpeechToTextProvider[],
    @Optional()
    @Inject(STREAMING_STT_PROVIDERS)
    private readonly streamingProviders: IStreamingSttProvider[] = [],
  ) {}

  async createSession(
    onEvent: (event: StreamingSttEvent) => Promise<void>,
  ): Promise<StreamingSttSession> {
    this.logger.log('VoiceSttService.createSession called')

    if (process.env.VOICE_STT_MODE === 'streaming') {
      const configuredProvider = process.env.VOICE_STT_STREAM_PROVIDER || 'openai'
      const provider = this.streamingProviders.find(
        (candidate) => candidate.id === configuredProvider,
      )
      if (!provider) {
        throw new Error(`Streaming speech provider is unavailable: ${configuredProvider}`)
      }

      let session: StreamingSttSession
      try {
        session = await provider.createSession({
          mimeType: 'audio/pcm',
          sampleRate: Number(process.env.VOICE_AUDIO_SAMPLE_RATE_HZ) || 16_000,
          language: process.env.VOICE_STT_LANGUAGE || 'bg',
        })
      } catch (error) {
        const diagnostic = formatStartupDiagnostic(error)
        this.logger.error(
          `[STT STARTUP ERROR] provider=${provider.id} reason=${errorName(error)}${diagnostic ? ` ${diagnostic}` : ''}`,
        )
        throw new Error('Could not start streaming speech recognition.')
      }
      session.onEvent((event) => { void onEvent(event) })
      return session
    }

    const audioChunks: Buffer[] = []
    let ended = false
    let closed = false

    const emit = async (event: StreamingSttEvent): Promise<void> => {
      if (closed) return
      await onEvent(event)
    }

    const session: StreamingSttSession = {
      onEvent: () => {
        // no-op in this local buffered implementation
      },

      pushAudio: async (buf: Buffer): Promise<void> => {
        if (closed || ended) return
        if (!buf?.length) return
        audioChunks.push(Buffer.from(buf))
      },

      endInput: async (): Promise<void> => {
        if (closed || ended) return
        ended = true

        try {
          const audio = Buffer.concat(audioChunks)

          if (!audio.length) {
            await emit({
              type: 'stt_error',
              message:
                'Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has 0.00ms of audio.',
            })
            return
          }

          const text = await this.transcribeBufferedAudio(audio)

          await emit({
            type: 'stt_final',
            text,
          })
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Unknown streaming STT error'

          await emit({
            type: 'stt_error',
            message,
          })
        }
      },

      close: async (): Promise<void> => {
        closed = true
      },
    }

    this.logger.log('VoiceSttService session created')
    return session
  }

  isStreamingMode(): boolean {
    return process.env.VOICE_STT_MODE === 'streaming'
  }

  async transcribeBufferedAudio(audio: Buffer): Promise<string> {
    if (!audio.length) return ''
    const startedAt = Date.now()
    const selected = this.selectProvider()
    let text: string
    try {
      text = await selected.transcribe(this.request(audio))
    } catch (error) {
      this.logger.warn(`Speech provider failed id=${selected.id} reason=${errorName(error)}`)
      if (selected.id === 'local-whisper' && this.fallbackEnabled()) {
        return this.transcribeFallback(audio, startedAt)
      }
      throw new Error('Speech recognition provider failed.')
    }

    if (!text.trim() && selected.id === 'local-whisper' && this.fallbackEnabled()) {
      this.logger.warn('Local speech provider returned no text; trying configured fallback.')
      return this.transcribeFallback(audio, startedAt)
    }

    this.logResult(selected.id, audio.length, text.length, startedAt)
    return text.trim()
  }

  private selectProvider(): SpeechToTextProvider {
    const configured = process.env.VOICE_STT_PROVIDER || process.env.STT_PROVIDER || 'openai'
    const providerId = configured === 'faster-whisper' ? 'local-whisper' : configured
    const provider = this.providers.find((candidate) => candidate.id === providerId)
    if (!provider) throw new Error(`Unsupported speech recognition provider: ${configured}`)
    return provider
  }

  private async transcribeFallback(audio: Buffer, startedAt: number): Promise<string> {
    const provider = this.providers.find((candidate) => candidate.id === 'openai')
    if (!provider) throw new Error('Configured speech recognition fallback is unavailable.')
    try {
      const text = await provider.transcribe(this.request(audio))
      this.logResult('openai_fallback', audio.length, text.length, startedAt)
      return text.trim()
    } catch (error) {
      this.logger.error(`Speech fallback failed id=openai reason=${errorName(error)}`)
      throw new Error('Speech recognition providers are unavailable.')
    }
  }

  private request(audio: Buffer) {
    return {
      audio,
      encoding: 'pcm_s16le' as const,
      sampleRateHz: 16000,
      channels: 1 as const,
      language: process.env.VOICE_STT_LANGUAGE || 'bg',
    }
  }

  private fallbackEnabled(): boolean {
    return process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI === 'true'
  }

  private logResult(provider: string, bytes: number, textChars: number, startedAt: number): void {
    this.logger.log(
      `[STT PROVIDER] provider=${provider} bytes=${bytes} durationMs=${Date.now() - startedAt} textChars=${textChars}`,
    )
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}

function formatStartupDiagnostic(error: unknown): string {
  if (!error || typeof error !== 'object' || !('diagnostic' in error)) return ''
  const diagnostic = error.diagnostic
  if (!diagnostic || typeof diagnostic !== 'object') return ''

  return Object.entries(diagnostic)
    .filter(([key, value]) =>
      ['providerEvent', 'providerCode', 'providerType', 'providerParam'].includes(key)
        ? typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
        : key === 'closeCode' && typeof value === 'number' && Number.isInteger(value),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}
