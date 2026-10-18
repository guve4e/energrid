export class Pcm16LinearResampler {
  private sourceSampleCount = 0
  private outputSampleIndex = 0
  private previousSample: number | null = null
  private finished = false

  constructor(
    private readonly sourceRateHz: number,
    private readonly targetRateHz: number,
  ) {
    if (!Number.isInteger(sourceRateHz) || sourceRateHz <= 0) {
      throw new Error('Source sample rate must be a positive integer.')
    }
    if (!Number.isInteger(targetRateHz) || targetRateHz <= 0) {
      throw new Error('Target sample rate must be a positive integer.')
    }
  }

  push(pcm: Buffer): Buffer {
    if (this.finished) throw new Error('Resampler is already finished.')
    if (pcm.length % 2 !== 0) throw new Error('PCM16 input must contain whole samples.')
    if (!pcm.length) return Buffer.alloc(0)

    const input = readSamples(pcm)
    const baseIndex = this.sourceSampleCount - (this.previousSample === null ? 0 : 1)
    const samples = this.previousSample === null
      ? input
      : [this.previousSample, ...input]
    this.sourceSampleCount += input.length

    const output: number[] = []
    const lastIndex = this.sourceSampleCount - 1
    while (true) {
      const position = this.outputSampleIndex * this.sourceRateHz / this.targetRateHz
      const lowerIndex = Math.floor(position)
      const upperIndex = Math.ceil(position)
      if (upperIndex > lastIndex) break

      const lower = samples[lowerIndex - baseIndex]
      const upper = samples[upperIndex - baseIndex]
      if (lower === undefined || upper === undefined) {
        throw new Error('Resampler lost its interpolation context.')
      }
      output.push(interpolate(lower, upper, position - lowerIndex))
      this.outputSampleIndex++
    }

    this.previousSample = input[input.length - 1]
    return writeSamples(output)
  }

  finish(): Buffer {
    if (this.finished) return Buffer.alloc(0)
    this.finished = true
    if (!this.sourceSampleCount || this.previousSample === null) return Buffer.alloc(0)

    const expectedOutputCount = Math.round(
      this.sourceSampleCount * this.targetRateHz / this.sourceRateHz,
    )
    const output: number[] = []
    while (this.outputSampleIndex < expectedOutputCount) {
      const position = this.outputSampleIndex * this.sourceRateHz / this.targetRateHz
      const lowerIndex = Math.min(Math.floor(position), this.sourceSampleCount - 1)
      const upperIndex = Math.min(Math.ceil(position), this.sourceSampleCount - 1)
      const lower = this.sampleAtEnd(lowerIndex)
      const upper = this.sampleAtEnd(upperIndex)
      output.push(interpolate(lower, upper, position - Math.floor(position)))
      this.outputSampleIndex++
    }
    return writeSamples(output)
  }

  private sampleAtEnd(index: number): number {
    if (index === this.sourceSampleCount - 1 && this.previousSample !== null) {
      return this.previousSample
    }
    throw new Error('Resampler cannot flush an unavailable sample.')
  }
}

function readSamples(pcm: Buffer): number[] {
  const samples: number[] = []
  for (let offset = 0; offset < pcm.length; offset += 2) {
    samples.push(pcm.readInt16LE(offset))
  }
  return samples
}

function writeSamples(samples: number[]): Buffer {
  const pcm = Buffer.allocUnsafe(samples.length * 2)
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2))
  return pcm
}

function interpolate(lower: number, upper: number, fraction: number): number {
  const value = Math.round(lower + (upper - lower) * fraction)
  return Math.max(-32768, Math.min(32767, value))
}
