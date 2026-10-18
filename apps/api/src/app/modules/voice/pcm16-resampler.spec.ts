import { Pcm16LinearResampler } from '@energrid/stt-stream-core'

function pcm(...samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2))
  return buffer
}

function samples(buffer: Buffer): number[] {
  const result: number[] = []
  for (let offset = 0; offset < buffer.length; offset += 2) {
    result.push(buffer.readInt16LE(offset))
  }
  return result
}

describe('Pcm16LinearResampler', () => {
  it('upsamples 16 kHz mono PCM to 24 kHz with linear interpolation', () => {
    const resampler = new Pcm16LinearResampler(16_000, 24_000)

    const result = Buffer.concat([
      resampler.push(pcm(0, 1200, 2400)),
      resampler.finish(),
    ])

    expect(samples(result)).toEqual([0, 800, 1600, 2400, 2400])
    expect(result.length).toBe(10)
  })

  it('preserves continuity when input arrives in uneven chunks', () => {
    const oneChunk = new Pcm16LinearResampler(16_000, 24_000)
    const splitChunks = new Pcm16LinearResampler(16_000, 24_000)
    const source = [100, -200, 900, -1200, 1600]

    const expected = Buffer.concat([oneChunk.push(pcm(...source)), oneChunk.finish()])
    const actual = Buffer.concat([
      splitChunks.push(pcm(source[0])),
      splitChunks.push(pcm(source[1], source[2])),
      splitChunks.push(pcm(source[3], source[4])),
      splitChunks.finish(),
    ])

    expect(actual).toEqual(expected)
    expect(samples(actual)).toHaveLength(Math.round(source.length * 1.5))
  })

  it('keeps samples unchanged when source and target rates match', () => {
    const resampler = new Pcm16LinearResampler(24_000, 24_000)
    const input = pcm(-32768, -1, 0, 32767)
    expect(Buffer.concat([resampler.push(input), resampler.finish()])).toEqual(input)
  })

  it('handles empty chunks and a single-sample stream', () => {
    const resampler = new Pcm16LinearResampler(16_000, 24_000)
    const result = Buffer.concat([resampler.push(Buffer.alloc(0)), resampler.push(pcm(-1000)), resampler.finish()])
    expect(samples(result)).toEqual([-1000, -1000])
  })

  it('rejects malformed PCM and invalid rates', () => {
    expect(() => new Pcm16LinearResampler(0, 24_000)).toThrow('positive integer')
    const resampler = new Pcm16LinearResampler(16_000, 24_000)
    expect(() => resampler.push(Buffer.from([0]))).toThrow('whole samples')
  })

  it('does not accept more samples after finish', () => {
    const resampler = new Pcm16LinearResampler(16_000, 24_000)
    resampler.finish()
    expect(() => resampler.push(pcm(100))).toThrow('already finished')
    expect(resampler.finish()).toEqual(Buffer.alloc(0))
  })
})
