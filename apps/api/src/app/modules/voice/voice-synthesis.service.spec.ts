import { VoiceSynthesisService } from './voice-synthesis.service'

describe('VoiceSynthesisService', () => {
  it('normalizes text and returns audio through the provider port', async () => {
    const provider = {
      synthesize: jest.fn().mockResolvedValue({
        format: 'wav',
        audio: new Uint8Array([1, 2]),
      }),
    }
    const service = new VoiceSynthesisService(provider as any)

    await expect(service.synthesize('  Здравей   свят  ')).resolves.toEqual({
      format: 'wav',
      audioBuffer: Buffer.from([1, 2]),
    })
    expect(provider.synthesize).toHaveBeenCalledWith({
      text: 'Здравей свят',
      language: 'bg',
    })
  })

  it('rejects empty text before calling the provider', async () => {
    const provider = { synthesize: jest.fn() }
    const service = new VoiceSynthesisService(provider as any)

    await expect(service.synthesize('  ')).rejects.toThrow('Cannot synthesize empty text')
    expect(provider.synthesize).not.toHaveBeenCalled()
  })

  it('preserves provider failures for the session boundary to report safely', async () => {
    const provider = { synthesize: jest.fn().mockRejectedValue(new Error('timeout')) }
    const service = new VoiceSynthesisService(provider as any)

    await expect(service.synthesize('hello')).rejects.toThrow('timeout')
  })
})
