import { VoiceSttService } from './voice-stt.service'

describe('VoiceSttService provider selection', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.VOICE_STT_PROVIDER
    delete process.env.STT_PROVIDER
    delete process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('uses OpenAI transcription by default', async () => {
    const service = new VoiceSttService() as any
    service.transcribeWithOpenAI = jest.fn().mockResolvedValue('openai text')
    service.transcribeWithLocalWhisper = jest.fn().mockResolvedValue('local text')

    await expect(
      service.transcribeBufferedAudio(Buffer.from([1, 2, 3])),
    ).resolves.toBe('openai text')

    expect(service.transcribeWithOpenAI).toHaveBeenCalledTimes(1)
    expect(service.transcribeWithLocalWhisper).not.toHaveBeenCalled()
  })

  it('uses local Whisper when explicitly selected', async () => {
    process.env.VOICE_STT_PROVIDER = 'local-whisper'

    const service = new VoiceSttService() as any
    service.transcribeWithOpenAI = jest.fn().mockResolvedValue('openai text')
    service.transcribeWithLocalWhisper = jest.fn().mockResolvedValue('local text')

    await expect(
      service.transcribeBufferedAudio(Buffer.from([1, 2, 3])),
    ).resolves.toBe('local text')

    expect(service.transcribeWithLocalWhisper).toHaveBeenCalledTimes(1)
    expect(service.transcribeWithOpenAI).not.toHaveBeenCalled()
  })

  it('can fall back to OpenAI when local Whisper returns no text', async () => {
    process.env.VOICE_STT_PROVIDER = 'local-whisper'
    process.env.LOCAL_WHISPER_FALLBACK_TO_OPENAI = 'true'

    const service = new VoiceSttService() as any
    service.transcribeWithOpenAI = jest.fn().mockResolvedValue('openai text')
    service.transcribeWithLocalWhisper = jest.fn().mockResolvedValue('')

    await expect(
      service.transcribeBufferedAudio(Buffer.from([1, 2, 3])),
    ).resolves.toBe('openai text')

    expect(service.transcribeWithLocalWhisper).toHaveBeenCalledTimes(1)
    expect(service.transcribeWithOpenAI).toHaveBeenCalledTimes(1)
  })

  it('returns no text when local Whisper fails and fallback is disabled', async () => {
    process.env.VOICE_STT_PROVIDER = 'local-whisper'

    const service = new VoiceSttService() as any
    service.transcribeWithOpenAI = jest.fn().mockResolvedValue('openai text')
    service.transcribeWithLocalWhisper = jest.fn().mockResolvedValue('')

    await expect(
      service.transcribeBufferedAudio(Buffer.from([1, 2, 3])),
    ).resolves.toBe('')

    expect(service.transcribeWithLocalWhisper).toHaveBeenCalledTimes(1)
    expect(service.transcribeWithOpenAI).not.toHaveBeenCalled()
  })
})
