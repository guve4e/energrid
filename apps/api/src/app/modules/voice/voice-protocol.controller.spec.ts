import { VoiceProtocolController } from './voice-protocol.controller'

describe('VoiceProtocolController', () => {
  const original = process.env

  beforeEach(() => {
    process.env = { ...original, NODE_ENV: 'production', PORTAL_CONTROL_TOKEN: 'voice-api-token' }
  })

  afterAll(() => {
    process.env = original
  })

  it('requires portal authorization before returning persisted voice runs', () => {
    const store = {
      getInfo: jest.fn(() => ({ enabled: true, file: 'private-runs.jsonl' })),
      listRecent: jest.fn(() => []),
    }
    const controller = new VoiceProtocolController(store as never)

    expect(() => controller.getRuns(undefined, { headers: {} })).toThrow(
      'Voice access requires portal authorization.',
    )
    expect(
      controller.getRuns(undefined, {
        headers: { authorization: 'Bearer voice-api-token' },
      }),
    ).toEqual({ storage: { enabled: true, file: 'private-runs.jsonl' }, runs: [] })
  })

  it('reports buffered defaults and the selected streaming configuration', () => {
    const controller = new VoiceProtocolController({} as never)

    expect(controller.getConfig()).toMatchObject({
      sttMode: 'buffered',
      streamingSttProvider: 'openai',
      streamingSttModel: 'gpt-4o-mini-transcribe',
      voiceAudioSampleRateHz: 16_000,
      streamingSttConnectTimeoutMs: 10_000,
    })

    process.env.VOICE_STT_MODE = 'streaming'
    process.env.VOICE_STT_STREAM_PROVIDER = 'openai'
    process.env.OPENAI_STT_STREAM_MODEL = 'test-model'
    process.env.VOICE_AUDIO_SAMPLE_RATE_HZ = '24000'
    process.env.OPENAI_STT_STREAM_CONNECT_TIMEOUT_MS = '5000'

    expect(controller.getConfig()).toMatchObject({
      sttMode: 'streaming',
      streamingSttProvider: 'openai',
      streamingSttModel: 'test-model',
      voiceAudioSampleRateHz: 24_000,
      streamingSttConnectTimeoutMs: 5_000,
    })
  })
})
