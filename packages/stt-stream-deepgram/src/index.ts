import { createClient } from '@deepgram/sdk'
import type {
  IStreamingSttProvider,
  StreamingSttEvent,
  StreamingSttSession,
} from '../../stt-stream-core/src/index'

class DeepgramStreamingSession implements StreamingSttSession {
  private listeners: Array<(event: StreamingSttEvent) => void> = []

  constructor(private connection: any) {
    connection.on('Transcript', (msg: any) => {
      const text =
        msg?.channel?.alternatives?.[0]?.transcript?.trim?.() || ''

      if (!text) return

      if (msg.is_final) {
        this.emit({ type: 'stt_final', text })
      } else {
        this.emit({ type: 'stt_partial', text })
      }
    })

    connection.on('Error', (err: any) => {
      this.emit({
        type: 'stt_error',
        message: err?.message || 'Deepgram error',
      })
    })
  }

  async pushAudio(chunk: Buffer): Promise<void> {
    this.connection.send(chunk)
  }

  async endInput(): Promise<void> {
    this.connection.requestClose()
  }

  async close(): Promise<void> {
    this.connection.finish()
  }

  onEvent(cb: (event: StreamingSttEvent) => void): void {
    this.listeners.push(cb)
  }

  private emit(event: StreamingSttEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

export function createDeepgramStreamingSttProvider(): IStreamingSttProvider {
  const dg = createClient(process.env.DEEPGRAM_API_KEY)

  return {
    async createSession(input): Promise<StreamingSttSession> {
      const connection = dg.listen.live({
        model: 'nova-3',
        language: input.language || 'en',
        interim_results: true,
        smart_format: true,
        encoding: 'opus',
        sample_rate: input.sampleRate || 16000,
      })

      return new DeepgramStreamingSession(connection)
    },
  }
}
