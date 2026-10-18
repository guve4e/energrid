import { pcm16MonoToWav } from './speech-audio.util'

describe('pcm16MonoToWav', () => {
  it('writes a canonical PCM mono WAV header and preserves the samples', () => {
    const samples = Buffer.from([1, 2, 3, 4])
    const wav = pcm16MonoToWav(samples, 16000)

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(samples.length)
    expect(wav.subarray(44)).toEqual(samples)
  })
})
