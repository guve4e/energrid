import type {
  IStreamingSttProvider,
  StreamingSttEvent,
  StreamingSttSession,
} from '../../stt-stream-core/src/index'
import WebSocket from 'ws'

class OpenAIStreamingSttSession implements StreamingSttSession {
  private listeners: Array<(event: StreamingSttEvent) => void> = []
  private ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        console.log('OPENAI EVENT', msg.type)

        // ONLY user input transcription
        if (msg.type === 'conversation.item.input_audio_transcription.delta') {
          this.emit({
            type: 'stt_partial',
            text: msg.delta || '',
          })
          return
        }

        if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          this.emit({
            type: 'stt_final',
            text: msg.transcript || '',
          })
          return
        }

        if (msg.type === 'error') {
          this.emit({
            type: 'stt_error',
            message: msg.error?.message || 'OpenAI realtime error',
          })
        }
      } catch (err: any) {
        this.emit({
          type: 'stt_error',
          message: err?.message || 'message parse error',
        })
      }
    })
  }

  async pushAudio(chunk: Buffer): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return

    this.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64'),
      }),
    )
  }

  async endInput(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close()
  }

  onEvent(cb: (event: StreamingSttEvent) => void): void {
    this.listeners.push(cb)
  }

  private emit(event: StreamingSttEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

export function createOpenAIStreamingSttProvider(): IStreamingSttProvider {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY missing')

  return {
    async createSession(input): Promise<StreamingSttSession> {
      const ws = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview',
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'OpenAI-Beta': 'realtime=v1',
          },
        },
      )

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                input_audio_format: 'pcm16',
                input_audio_transcription: {
                  model: 'gpt-4o-mini-transcribe',
                  language: input.language || 'bg',
                  prompt:
                    'Transcribe spoken Bulgarian only. Do not translate. Keep Bulgarian words in Cyrillic.',
                },
                turn_detection: { type: 'server_vad' },
              },
            }),
          )
          resolve()
        })

        ws.on('error', (err) => reject(err))
      })

      return new OpenAIStreamingSttSession(ws)
    },
  }
}
