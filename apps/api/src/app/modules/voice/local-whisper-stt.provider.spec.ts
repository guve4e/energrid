import { localWhisperTimeoutMs } from './local-whisper-stt.provider'

describe('LocalWhisperSttProvider configuration', () => {
  const original = process.env.LOCAL_WHISPER_TIMEOUT_MS

  afterAll(() => {
    if (original === undefined) delete process.env.LOCAL_WHISPER_TIMEOUT_MS
    else process.env.LOCAL_WHISPER_TIMEOUT_MS = original
  })

  it('uses a bounded timeout for the worker and one-shot adapters', () => {
    process.env.LOCAL_WHISPER_TIMEOUT_MS = '-1'
    expect(localWhisperTimeoutMs()).toBe(1000)
    process.env.LOCAL_WHISPER_TIMEOUT_MS = '999999'
    expect(localWhisperTimeoutMs()).toBe(120000)
    process.env.LOCAL_WHISPER_TIMEOUT_MS = 'invalid'
    expect(localWhisperTimeoutMs()).toBe(30000)
  })
})
