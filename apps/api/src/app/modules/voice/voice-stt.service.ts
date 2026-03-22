import { Injectable, Logger } from '@nestjs/common'
import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import type {
  StreamingSttEvent,
  StreamingSttSession,
} from '@energrid/stt-stream-core'

@Injectable()
export class VoiceSttService {
  private readonly logger = new Logger(VoiceSttService.name)

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  async createSession(
    onEvent: (event: StreamingSttEvent) => Promise<void>,
  ): Promise<StreamingSttSession> {
    this.logger.log('VoiceSttService.createSession called')

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

  async transcribeBufferedAudio(audio: Buffer): Promise<string> {
    if (!audio.length) return ''

    try {
      const wav = this.pcm16ToWav(audio, 16000, 1)

      const file = await toFile(wav, 'turn.wav', {
        type: 'audio/wav',
      })

      const result = await this.openai.audio.transcriptions.create({
        file,
        model: process.env.BATCH_STT_MODEL || 'gpt-4o-transcribe',
        language: 'bg',
      })

      const text = (result.text || '').trim()

      this.logger.log(`[BATCH STT] ${text}`)

      return text
    } catch (err: any) {
      this.logger.error(
        `Batch STT failed: message=${err?.message || 'unknown'} code=${err?.code || '-'} cause=${err?.cause?.message || '-'}`,
      )
      return ''
    }
  }

  private pcm16ToWav(
    pcm16: Buffer,
    sampleRate = 16000,
    channels = 1,
  ): Buffer {
    const bitsPerSample = 16
    const byteRate = sampleRate * channels * (bitsPerSample / 8)
    const blockAlign = channels * (bitsPerSample / 8)
    const dataSize = pcm16.length
    const buffer = Buffer.alloc(44 + dataSize)

    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)

    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(channels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(byteRate, 28)
    buffer.writeUInt16LE(blockAlign, 32)
    buffer.writeUInt16LE(bitsPerSample, 34)

    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    pcm16.copy(buffer, 44)

    return buffer
  }
}
