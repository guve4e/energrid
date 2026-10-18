import {
  OpenAiBatchSttProvider,
  OpenAiSpeechSynthesisProvider,
  providerTimeoutMs,
} from './openai-speech.providers'

describe('OpenAI speech providers', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.OPENAI_API_KEY
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('normalizes audio input to WAV and applies a bounded timeout without SDK retries', async () => {
    process.env.VOICE_STT_TIMEOUT_MS = '2'
    const create = jest.fn().mockResolvedValue({ text: '  recognized  ' })
    const provider = new OpenAiBatchSttProvider() as any
    provider.client = { audio: { transcriptions: { create } } }

    await expect(provider.transcribe({
      audio: Buffer.from([0, 0]),
      encoding: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
      language: 'bg',
    })).resolves.toBe('recognized')

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-transcribe', language: 'bg' }),
      { timeout: 1000, maxRetries: 0 },
    )
  })

  it('returns WAV synthesis bytes through the provider contract', async () => {
    const arrayBuffer = Uint8Array.from([1, 2, 3]).buffer
    const create = jest.fn().mockResolvedValue({ arrayBuffer: async () => arrayBuffer })
    const provider = new OpenAiSpeechSynthesisProvider() as any
    provider.client = { audio: { speech: { create } } }

    await expect(provider.synthesize({ text: 'Здравей', language: 'bg' })).resolves.toEqual({
      format: 'wav',
      audio: new Uint8Array([1, 2, 3]),
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'Здравей',
        response_format: 'wav',
        instructions: 'Speak naturally in Bulgarian.',
      }),
      expect.objectContaining({ maxRetries: 0 }),
    )
  })

  it('bounds provider timeout configuration', () => {
    process.env.TEST_SPEECH_TIMEOUT = '999999'
    expect(providerTimeoutMs('TEST_SPEECH_TIMEOUT')).toBe(120000)
    process.env.TEST_SPEECH_TIMEOUT = 'invalid'
    expect(providerTimeoutMs('TEST_SPEECH_TIMEOUT')).toBe(30000)
  })
})
