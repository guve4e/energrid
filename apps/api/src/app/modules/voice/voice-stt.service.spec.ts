import { VoiceSttService } from './voice-stt.service'

function makeProviders() {
  return [
    { id: 'openai', transcribe: jest.fn().mockResolvedValue('openai text') },
    { id: 'local-whisper', transcribe: jest.fn().mockResolvedValue('local text') },
  ]
}

describe('VoiceSttService provider selection', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.VOICE_STT_PROVIDER
    delete process.env.STT_PROVIDER
    delete process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI
    delete process.env.VOICE_STT_MODE
    delete process.env.VOICE_STT_STREAM_PROVIDER
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('uses OpenAI transcription by default', async () => {
    const providers = makeProviders()
    const service = new VoiceSttService(providers as any)

    await expect(
      service.transcribeBufferedAudio(Buffer.from([1, 2, 3])),
    ).resolves.toBe('openai text')

    expect(providers[0].transcribe).toHaveBeenCalledTimes(1)
    expect(providers[1].transcribe).not.toHaveBeenCalled()
    expect(providers[0].transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        encoding: 'pcm_s16le',
        sampleRateHz: 16000,
        channels: 1,
        language: 'bg',
      }),
    )
  })

  it('uses local Whisper when explicitly selected', async () => {
    process.env.VOICE_STT_PROVIDER = 'local-whisper'

    const providers = makeProviders()
    const service = new VoiceSttService(providers as any)

    await expect(
      service.transcribeBufferedAudio(Buffer.from([1, 2, 3])),
    ).resolves.toBe('local text')

    expect(providers[1].transcribe).toHaveBeenCalledTimes(1)
    expect(providers[0].transcribe).not.toHaveBeenCalled()
  })

  it('can fall back to OpenAI when local Whisper returns no text', async () => {
    process.env.VOICE_STT_PROVIDER = 'local-whisper'
    process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI = 'true'

    const providers = makeProviders()
    providers[1].transcribe.mockResolvedValue('')
    const service = new VoiceSttService(providers as any)

    await expect(
      service.transcribeBufferedAudio(Buffer.from([1, 2, 3])),
    ).resolves.toBe('openai text')

    expect(providers[1].transcribe).toHaveBeenCalledTimes(1)
    expect(providers[0].transcribe).toHaveBeenCalledTimes(1)
  })

  it('returns no text when local Whisper fails and fallback is disabled', async () => {
    process.env.VOICE_STT_PROVIDER = 'local-whisper'

    const providers = makeProviders()
    providers[1].transcribe.mockResolvedValue('')
    const service = new VoiceSttService(providers as any)

    await expect(
      service.transcribeBufferedAudio(Buffer.from([1, 2, 3])),
    ).resolves.toBe('')

    expect(providers[1].transcribe).toHaveBeenCalledTimes(1)
    expect(providers[0].transcribe).not.toHaveBeenCalled()
  })

  it('falls back to OpenAI after a local provider failure only when configured', async () => {
    process.env.VOICE_STT_PROVIDER = 'local-whisper'
    process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI = 'true'
    const providers = makeProviders()
    providers[1].transcribe.mockRejectedValue(new Error('worker unavailable'))
    const service = new VoiceSttService(providers as any)

    await expect(service.transcribeBufferedAudio(Buffer.from([1, 2]))).resolves.toBe('openai text')
    expect(providers[0].transcribe).toHaveBeenCalledTimes(1)
  })

  it('does not retry the OpenAI fallback twice when the local provider returned no speech', async () => {
    process.env.VOICE_STT_PROVIDER = 'local-whisper'
    process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI = 'true'
    const providers = makeProviders()
    providers[1].transcribe.mockResolvedValue('')
    providers[0].transcribe.mockRejectedValue(new Error('network failure'))
    const service = new VoiceSttService(providers as any)

    await expect(service.transcribeBufferedAudio(Buffer.from([1]))).rejects.toThrow(
      'Speech recognition providers are unavailable.',
    )
    expect(providers[0].transcribe).toHaveBeenCalledTimes(1)
  })

  it('returns a controlled failure instead of disguising OpenAI errors as an empty transcript', async () => {
    const providers = makeProviders()
    providers[0].transcribe.mockRejectedValue(new Error('provider timeout'))
    const service = new VoiceSttService(providers as any)

    await expect(service.transcribeBufferedAudio(Buffer.from([1, 2]))).rejects.toThrow(
      'Speech recognition provider failed.',
    )
  })

  it('rejects unknown provider names instead of silently selecting OpenAI', async () => {
    process.env.VOICE_STT_PROVIDER = 'unconfigured-provider'
    const service = new VoiceSttService(makeProviders() as any)

    await expect(service.transcribeBufferedAudio(Buffer.from([1, 2]))).rejects.toThrow(
      'Unsupported speech recognition provider: unconfigured-provider',
    )
  })

  it('emits a provider error event from its buffered STT session on failure', async () => {
    const providers = makeProviders()
    providers[0].transcribe.mockRejectedValue(new Error('provider timeout'))
    const service = new VoiceSttService(providers as any)
    const events: Array<{ type: string; message?: string }> = []
    const session = await service.createSession(async (event) => {
      events.push(event as { type: string; message?: string })
    })

    await session.pushAudio(Buffer.from([1, 2]))
    await session.endInput()

    expect(events).toEqual([
      { type: 'stt_error', message: 'Speech recognition provider failed.' },
    ])
  })

  it('creates a provider-neutral streaming session and forwards its events', async () => {
    process.env.VOICE_STT_MODE = 'streaming'
    const streamEvents = new Set<(event: unknown) => void>()
    const session = {
      pushAudio: jest.fn(),
      endInput: jest.fn(),
      close: jest.fn(),
      onEvent: jest.fn((listener) => streamEvents.add(listener)),
    }
    const streamProvider = {
      id: 'openai',
      createSession: jest.fn().mockResolvedValue(session),
    }
    const service = new VoiceSttService(makeProviders() as any, [streamProvider] as any)
    const onEvent = jest.fn()

    await expect(service.createSession(onEvent)).resolves.toBe(session)
    expect(service.isStreamingMode()).toBe(true)
    expect(streamProvider.createSession).toHaveBeenCalledWith({
      mimeType: 'audio/pcm', sampleRate: 16000, language: 'bg',
    })
    for (const listener of streamEvents) listener({ type: 'stt_partial', text: 'hello' })
    expect(onEvent).toHaveBeenCalledWith({ type: 'stt_partial', text: 'hello' })
  })

  it('fails closed when streaming mode names an unavailable provider', async () => {
    process.env.VOICE_STT_MODE = 'streaming'
    process.env.VOICE_STT_STREAM_PROVIDER = 'missing'
    const service = new VoiceSttService(makeProviders() as any, [])

    await expect(service.createSession(jest.fn())).rejects.toThrow(
      'Streaming speech provider is unavailable: missing',
    )
  })

  it('logs only safe provider diagnostics when streaming setup is rejected', async () => {
    process.env.VOICE_STT_MODE = 'streaming'
    const streamProvider = {
      id: 'openai',
      createSession: jest.fn().mockRejectedValue(Object.assign(
        new Error('private provider response'),
        {
          diagnostic: {
            providerEvent: 'error',
            providerCode: 'invalid_value',
            providerParam: 'session.audio.input.transcription.model',
            providerType: 'invalid_request_error',
            private: 'must-not-be-logged',
          },
        },
      )),
    }
    const service = new VoiceSttService(makeProviders() as any, [streamProvider] as any)
    const log = jest.spyOn((service as any).logger, 'error')

    await expect(service.createSession(jest.fn())).rejects.toThrow(
      'Could not start streaming speech recognition.',
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('providerCode=invalid_value'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('providerParam=session.audio.input.transcription.model'))
    expect(log.mock.calls.flat().join(' ')).not.toContain('private provider response')
    expect(log.mock.calls.flat().join(' ')).not.toContain('must-not-be-logged')
  })
})
