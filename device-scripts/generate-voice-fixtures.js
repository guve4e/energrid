#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

function usage() {
  console.log(
    [
      'Usage: node device-scripts/generate-voice-fixtures.js <source.wav> [output-dir]',
      '',
      'Creates deterministic 16kHz mono PCM16 edge-case fixtures from a good recording.',
    ].join('\n'),
  )
}

function readWav(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not a RIFF file')
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAVE file')

  let offset = 12
  let fmt = null
  let pcm = null

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkSize

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      }
    }

    if (chunkId === 'data') {
      pcm = buffer.subarray(chunkStart, chunkEnd)
    }

    offset = chunkEnd + (chunkSize % 2)
  }

  if (!fmt || !pcm) throw new Error('Invalid WAV: missing fmt or data chunk')
  if (
    fmt.audioFormat !== 1 ||
    fmt.channels !== 1 ||
    fmt.sampleRate !== 16000 ||
    fmt.bitsPerSample !== 16
  ) {
    throw new Error(
      `Expected 16kHz mono PCM16 WAV, got format=${fmt.audioFormat} channels=${fmt.channels} sampleRate=${fmt.sampleRate} bits=${fmt.bitsPerSample}`,
    )
  }

  return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
}

function writeWav(filePath, samples) {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(clamp16(samples[i]), 44 + i * 2)
  }

  fs.writeFileSync(filePath, buffer)
}

function clamp16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)))
}

function scale(samples, factor) {
  return Int16Array.from(samples, (sample) => clamp16(sample * factor))
}

function addSilence(samples, beforeSeconds, afterSeconds) {
  const before = new Int16Array(Math.round(beforeSeconds * 16000))
  const after = new Int16Array(Math.round(afterSeconds * 16000))
  const out = new Int16Array(before.length + samples.length + after.length)
  out.set(before, 0)
  out.set(samples, before.length)
  out.set(after, before.length + samples.length)
  return out
}

function clip(samples, factor) {
  return scale(samples, factor)
}

function addNoise(samples, amplitude) {
  let seed = 123456789
  const out = new Int16Array(samples.length)

  for (let i = 0; i < samples.length; i += 1) {
    seed = (1103515245 * seed + 12345) & 0x7fffffff
    const noise = ((seed / 0x7fffffff) * 2 - 1) * amplitude
    out[i] = clamp16(samples[i] + noise)
  }

  return out
}

function silence(seconds) {
  return new Int16Array(Math.round(seconds * 16000))
}

function main() {
  const source = process.argv[2]
  const outputDir = process.argv[3] || 'samples/voice/fixtures'

  if (!source) {
    usage()
    process.exit(1)
  }

  const samples = readWav(path.resolve(source))
  fs.mkdirSync(outputDir, { recursive: true })

  const fixtures = {
    'close-command-reference.wav': samples,
    'close-command-quiet.wav': scale(samples, 0.25),
    'close-command-loud.wav': scale(samples, 1.8),
    'close-command-leading-trailing-silence.wav': addSilence(samples, 1.5, 1.5),
    'close-command-noisy.wav': addNoise(samples, 2200),
    'close-command-clipped.wav': clip(samples, 5),
    'silence-5s.wav': silence(5),
  }

  for (const [name, fixtureSamples] of Object.entries(fixtures)) {
    const filePath = path.join(outputDir, name)
    writeWav(filePath, fixtureSamples)
    console.log(`[fixture] ${filePath}`)
  }
}

main()
