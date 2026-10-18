import type {
  IStreamingSttProvider,
  StreamingSttEvent,
  StreamingSttSession,
} from '../../stt-stream-core/src/index'
import { Pcm16LinearResampler } from '../../stt-stream-core/src/pcm16-resampler'
import WebSocket from 'ws'

type SessionInput = Parameters<IStreamingSttProvider['createSession']>[0]
type ProviderDiagnostic = NonNullable<Extract<StreamingSttEvent, { type: 'stt_error' }>['diagnostic']>

export class StreamingSttStartupError extends Error {
  constructor(readonly diagnostic?: ProviderDiagnostic) {
    super('Could not start streaming speech recognition.')
    this.name = 'StreamingSttStartupError'
  }
}

export class OpenAIStreamingSttSession implements StreamingSttSession {
  private readonly listeners = new Set<(event: StreamingSttEvent) => void>()
  private ended = false
  private closed = false
  private disconnected = false
  private readonly resampler: Pcm16LinearResampler

  constructor(private readonly ws: WebSocket, sourceRateHz: number) {
    this.resampler = new Pcm16LinearResampler(sourceRateHz, 24_000)
    ws.on('message', this.handleMessage)
    ws.on('error', this.handleSocketError)
    ws.on('close', this.handleSocketClose)
  }

  pushAudio(chunk: Buffer): Promise<void> {
    if (this.closed || this.ended || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Speech input session is not open.'))
    }
    if (chunk.length === 0) return Promise.resolve()

    const converted = this.resampler.push(chunk)
    if (!converted.length) return Promise.resolve()
    return this.send({
      type: 'input_audio_buffer.append',
      audio: converted.toString('base64'),
    })
  }

  async endInput(): Promise<void> {
    if (this.closed || this.ended) return
    this.ended = true
    const tail = this.resampler.finish()
    if (tail.length) {
      await this.send({ type: 'input_audio_buffer.append', audio: tail.toString('base64') })
    }
    await this.send({ type: 'input_audio_buffer.commit' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
    }
  }

  onEvent(cb: (event: StreamingSttEvent) => void): void {
    if (!this.closed) this.listeners.add(cb)
  }

  private readonly handleMessage = (raw: WebSocket.RawData): void => {
    let message: {
      type?: string
      delta?: string
      transcript?: string
      error?: { code?: unknown; type?: unknown; param?: unknown }
      response?: { status_details?: { error?: { code?: unknown; type?: unknown; param?: unknown } } }
    }
    try {
      message = JSON.parse(raw.toString())
    } catch {
      this.fail('Speech provider returned an invalid event.', { providerEvent: 'invalid_json' })
      return
    }

    if (message.type === 'conversation.item.input_audio_transcription.delta') {
      if (message.delta) this.emit({ type: 'stt_partial', text: message.delta })
      return
    }

    if (message.type === 'conversation.item.input_audio_transcription.completed') {
      this.ended = true
      this.emit({ type: 'stt_final', text: (message.transcript || '').trim() })
      return
    }

    if (message.type === 'error' || message.type === 'response.failed') {
      const error = message.error || message.response?.status_details?.error
      this.fail('Speech recognition provider failed.', {
        providerEvent: safeDiagnosticToken(message.type),
        providerCode: safeDiagnosticToken(error?.code),
        providerType: safeDiagnosticToken(error?.type),
        providerParam: safeDiagnosticToken(error?.param),
      })
    }
  }

  private readonly handleSocketError = (error: Error): void => {
    this.fail('Speech recognition connection failed.', {
      providerEvent: 'socket_error',
      providerType: safeDiagnosticToken(error.name),
    })
  }

  private readonly handleSocketClose = (code: number): void => {
    if (this.closed || this.disconnected) return
    this.fail('Speech recognition connection closed unexpectedly.', {
      providerEvent: 'socket_close',
      closeCode: Number.isInteger(code) ? code : undefined,
    })
  }

  private fail(
    message: string,
    diagnostic: NonNullable<Extract<StreamingSttEvent, { type: 'stt_error' }>['diagnostic']>,
  ): void {
    if (this.closed || this.disconnected) return
    this.disconnected = true
    this.ended = true
    this.emit({ type: 'stt_error', message, diagnostic })
  }

  private send(payload: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Speech input session is not open.'))
        return
      }
      this.ws.send(JSON.stringify(payload), (error) => {
        if (error) reject(new Error('Could not send audio to speech provider.'))
        else resolve()
      })
    })
  }

  private emit(event: StreamingSttEvent): void {
    if (this.closed) return
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A consumer callback must not disrupt delivery to other session listeners.
      }
    }
  }
}

function safeDiagnosticToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const token = value.trim()
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(token) ? token : undefined
}

export function createOpenAIStreamingSttProvider(): IStreamingSttProvider {
  return {
    id: 'openai',
    async createSession(input: SessionInput): Promise<StreamingSttSession> {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error('Streaming speech provider is not configured.')
      const ws = new WebSocket(streamingUrl(), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      })

      try {
        await waitForOpen(ws, connectionTimeoutMs())
        await configureSession(ws, input)
        return new OpenAIStreamingSttSession(ws, input.sampleRate || 24_000)
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close()
        }
        if (error instanceof StreamingSttStartupError) throw error
        throw new StreamingSttStartupError()
      }
    },
  }
}

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Connection timed out.')), timeoutMs)
    const onOpen = () => finish()
    const onError = () => finish(new Error('Connection failed.'))
    const onClose = () => finish(new Error('Connection closed.'))

    const finish = (error?: Error) => {
      clearTimeout(timeout)
      ws.off('open', onOpen)
      ws.off('error', onError)
      ws.off('close', onClose)
      if (error) reject(error)
      else resolve()
    }

    ws.once('open', onOpen)
    ws.once('error', onError)
    ws.once('close', onClose)
  })
}

function configureSession(ws: WebSocket, input: SessionInput): Promise<void> {
  const model = process.env.OPENAI_STT_STREAM_MODEL || 'gpt-live-transcribe'
  const transcription = {
    model,
    ...(model === 'gpt-live-transcribe'
      ? { languages: [input.language || 'bg'] }
      : { language: input.language || 'bg' }),
    prompt:
      'Transcribe spoken Bulgarian only. Do not translate. Keep Bulgarian words in Cyrillic.',
  }
  const sessionUpdate = {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription,
          turn_detection: null,
        },
      },
    },
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new StreamingSttStartupError({ providerEvent: 'session_update_timeout' })),
      connectionTimeoutMs(),
    )
    const onMessage = (raw: WebSocket.RawData) => {
      let message: {
        type?: string
        error?: { code?: unknown; type?: unknown; param?: unknown }
        response?: { status_details?: { error?: { code?: unknown; type?: unknown; param?: unknown } } }
      }
      try {
        message = JSON.parse(raw.toString())
      } catch {
        finish(new StreamingSttStartupError({ providerEvent: 'invalid_json' }))
        return
      }

      if (message.type === 'session.updated') {
        finish()
        return
      }
      if (message.type === 'error' || message.type === 'response.failed') {
        const error = message.error || message.response?.status_details?.error
        finish(new StreamingSttStartupError({
          providerEvent: safeDiagnosticToken(message.type),
          providerCode: safeDiagnosticToken(error?.code),
          providerType: safeDiagnosticToken(error?.type),
          providerParam: safeDiagnosticToken(error?.param),
        }))
      }
    }
    const onError = () => finish(new StreamingSttStartupError({ providerEvent: 'socket_error' }))
    const onClose = (code: number) => finish(new StreamingSttStartupError({
      providerEvent: 'socket_close',
      closeCode: Number.isInteger(code) ? code : undefined,
    }))

    const finish = (error?: Error) => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('error', onError)
      ws.off('close', onClose)
      if (error) reject(error)
      else resolve()
    }

    ws.on('message', onMessage)
    ws.once('error', onError)
    ws.once('close', onClose)
    ws.send(JSON.stringify(sessionUpdate), (error) => {
      if (error) finish(new StreamingSttStartupError({ providerEvent: 'session_update_send_error' }))
    })
  })
}

function streamingUrl(): string {
  const url = new URL(
    process.env.OPENAI_STT_STREAM_URL || 'wss://api.openai.com/v1/realtime',
  )
  url.searchParams.delete('model')
  url.searchParams.set('intent', 'transcription')
  return url.toString()
}

function connectionTimeoutMs(): number {
  const configured = Number(process.env.OPENAI_STT_STREAM_CONNECT_TIMEOUT_MS)
  if (!Number.isFinite(configured)) return 10_000
  return Math.max(1_000, Math.min(30_000, Math.floor(configured)))
}
