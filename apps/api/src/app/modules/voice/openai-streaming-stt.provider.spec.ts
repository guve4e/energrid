import { EventEmitter } from 'node:events'

class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  static CONNECTING = 0
  static instances: FakeWebSocket[] = []
  static openNext = true
  static sessionUpdateResponse: Record<string, unknown> | null = { type: 'session.updated' }
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  close = jest.fn(() => {
    this.readyState = 3
    this.emit('close')
  })

  constructor(readonly url: string, readonly options: unknown) {
    super()
    FakeWebSocket.instances.push(this)
    if (FakeWebSocket.openNext) {
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN
        this.emit('open')
      })
    }
  }

  send(value: string, callback?: (error?: Error) => void) {
    this.sent.push(value)
    callback?.()
    const event = JSON.parse(value)
    if (event.type === 'session.update' && FakeWebSocket.sessionUpdateResponse) {
      queueMicrotask(() => {
        this.emit('message', Buffer.from(JSON.stringify(FakeWebSocket.sessionUpdateResponse)))
      })
    }
  }
}

jest.mock('ws', () => ({
  __esModule: true,
  default: FakeWebSocket,
}))

import { createOpenAIStreamingSttProvider } from '@energrid/stt-stream-openai'

describe('OpenAI streaming STT adapter', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' }
    delete process.env.OPENAI_STT_STREAM_CONNECT_TIMEOUT_MS
    delete process.env.OPENAI_STT_STREAM_MODEL
    delete process.env.OPENAI_STT_STREAM_URL
    FakeWebSocket.instances = []
    FakeWebSocket.openNext = true
    FakeWebSocket.sessionUpdateResponse = { type: 'session.updated' }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('opens a configured session and forwards PCM chunks in order', async () => {
    const provider = createOpenAIStreamingSttProvider()
    const session = await provider.createSession({
      mimeType: 'audio/pcm', sampleRate: 24_000, language: 'bg',
    })
    const ws = FakeWebSocket.instances[0]

    await session.pushAudio(Buffer.from([1, 2]))
    await session.pushAudio(Buffer.from([3, 4]))

    expect(ws.url).toBe('wss://api.openai.com/v1/realtime?intent=transcription')
    expect(ws.options).toEqual({ headers: { Authorization: 'Bearer test-key' } })
    expect(ws.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24_000 },
              transcription: expect.objectContaining({
                model: 'gpt-live-transcribe',
                languages: ['bg'],
              }),
              turn_detection: null,
            },
          },
        },
      },
      { type: 'input_audio_buffer.append', audio: 'AQI=' },
      { type: 'input_audio_buffer.append', audio: 'AwQ=' },
    ])
  })

  it('retains the singular language field for configured legacy model overrides', async () => {
    process.env.OPENAI_STT_STREAM_MODEL = 'gpt-4o-mini-transcribe'

    await createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm', language: 'bg' })

    const sessionUpdate = JSON.parse(FakeWebSocket.instances[0].sent[0])
    expect(FakeWebSocket.instances[0].url).toBe(
      'wss://api.openai.com/v1/realtime?intent=transcription',
    )
    expect(sessionUpdate.session.audio.input.transcription).toEqual(expect.objectContaining({
      model: 'gpt-4o-mini-transcribe',
      language: 'bg',
    }))
    expect(sessionUpdate.session.audio.input.transcription.languages).toBeUndefined()
  })

  it('uses a configured endpoint with the transcription intent and removes any model query', async () => {
    process.env.OPENAI_STT_STREAM_URL = 'wss://speech.example/realtime?intent=transcription'
    process.env.OPENAI_STT_STREAM_URL += '&model=legacy-model'

    await createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' })

    expect(FakeWebSocket.instances[0].url).toBe(
      'wss://speech.example/realtime?intent=transcription',
    )
  })

  it('translates partial and final events through the provider-neutral event contract', async () => {
    const session = await createOpenAIStreamingSttProvider().createSession({
      mimeType: 'audio/pcm', sampleRate: 16000, language: 'bg',
    })
    const ws = FakeWebSocket.instances[0]
    const events: unknown[] = []
    session.onEvent((event) => events.push(event))

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta', delta: 'Здра',
    })))
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed', transcript: 'Здравей',
    })))

    expect(events).toEqual([
      { type: 'stt_partial', text: 'Здра' },
      { type: 'stt_final', text: 'Здравей' },
    ])
  })

  it('resamples 16 kHz chunks to the configured 24 kHz input format', async () => {
    const session = await createOpenAIStreamingSttProvider().createSession({
      mimeType: 'audio/pcm', sampleRate: 16_000, language: 'bg',
    })
    const ws = FakeWebSocket.instances[0]
    const source = Buffer.alloc(6)
    ;[0, 1200, 2400].forEach((sample, index) => source.writeInt16LE(sample, index * 2))

    await session.pushAudio(source)
    await session.endInput()

    const audio = ws.sent
      .map((raw) => JSON.parse(raw) as { type: string; audio?: string })
      .filter((event) => event.type === 'input_audio_buffer.append')
      .map((event) => Buffer.from(event.audio || '', 'base64'))
    expect(Buffer.concat(audio)).toEqual(Buffer.from([0, 0, 32, 3, 64, 6, 96, 9, 96, 9]))
  })

  it('commits input once and rejects additional chunks after finish', async () => {
    const session = await createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' })
    const ws = FakeWebSocket.instances[0]

    await session.endInput()
    await session.endInput()
    await expect(session.pushAudio(Buffer.from([1]))).rejects.toThrow('not open')

    expect(ws.sent.map((raw) => JSON.parse(raw).type)).toEqual([
      'session.update', 'input_audio_buffer.commit',
    ])
  })

  it('closes idempotently and suppresses late provider events', async () => {
    const session = await createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' })
    const ws = FakeWebSocket.instances[0]
    const listener = jest.fn()
    session.onEvent(listener)

    await session.close()
    await session.close()
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta', delta: 'late',
    })))

    expect(ws.close).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('reports an unexpected socket disconnect once', async () => {
    const session = await createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' })
    const ws = FakeWebSocket.instances[0]
    const events: unknown[] = []
    session.onEvent((event) => events.push(event))

    ws.readyState = 3
    ws.emit('close')
    ws.emit('close')

    expect(events).toEqual([
      {
        type: 'stt_error',
        message: 'Speech recognition connection closed unexpectedly.',
        diagnostic: { providerEvent: 'socket_close' },
      },
    ])
  })

  it('fails session startup when the provider connection times out', async () => {
    jest.useFakeTimers()
    FakeWebSocket.openNext = false
    process.env.OPENAI_STT_STREAM_CONNECT_TIMEOUT_MS = '1000'

    const startup = createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' })
    const rejectedStartup = expect(startup).rejects.toThrow(
      'Could not start streaming speech recognition.',
    )
    await jest.advanceTimersByTimeAsync(1000)
    await rejectedStartup
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1)
  })

  it('fails before returning a session when OpenAI rejects its configuration', async () => {
    FakeWebSocket.sessionUpdateResponse = {
      type: 'error',
      error: {
        code: 'invalid_value',
        type: 'invalid_request_error',
        param: 'session.audio.input.transcription.model',
        message: 'private provider response',
      },
    }

    await expect(createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' }))
      .rejects.toMatchObject({
        message: 'Could not start streaming speech recognition.',
        diagnostic: {
          providerEvent: 'error',
          providerCode: 'invalid_value',
          providerParam: 'session.audio.input.transcription.model',
        },
      })
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1)
  })

  it('times out if OpenAI never acknowledges its session configuration', async () => {
    jest.useFakeTimers()
    FakeWebSocket.sessionUpdateResponse = null
    process.env.OPENAI_STT_STREAM_CONNECT_TIMEOUT_MS = '1000'

    const startup = createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' })
    const rejectedStartup = expect(startup).rejects.toMatchObject({
      diagnostic: { providerEvent: 'session_update_timeout' },
    })
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1000)
    await rejectedStartup
  })

  it('does not expose provider error details to the session consumer', async () => {
    const session = await createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' })
    const ws = FakeWebSocket.instances[0]
    const events: unknown[] = []
    session.onEvent((event) => events.push(event))
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        code: 'invalid_value',
        type: 'invalid_request_error',
        param: 'session.audio.input.transcription.model',
        message: 'sensitive upstream detail with secret material',
      },
    })))

    expect(events).toEqual([
      {
        type: 'stt_error',
        message: 'Speech recognition provider failed.',
        diagnostic: {
          providerEvent: 'error',
          providerCode: 'invalid_value',
          providerType: 'invalid_request_error',
          providerParam: 'session.audio.input.transcription.model',
        },
      },
    ])
    expect(JSON.stringify(events)).not.toContain('sensitive upstream detail')
    await expect(session.pushAudio(Buffer.from([1, 2]))).rejects.toThrow('not open')
  })

  it('rejects missing credentials without opening a socket', async () => {
    delete process.env.OPENAI_API_KEY
    await expect(createOpenAIStreamingSttProvider().createSession({ mimeType: 'audio/pcm' }))
      .rejects.toThrow('not configured')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})
