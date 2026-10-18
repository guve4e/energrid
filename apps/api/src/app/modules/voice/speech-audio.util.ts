export function pcm16MonoToWav(pcm16: Uint8Array, sampleRateHz: number): Buffer {
  const bitsPerSample = 16
  const channels = 1
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = pcm16.byteLength
  const wav = Buffer.alloc(44 + dataSize)

  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataSize, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRateHz, 24)
  wav.writeUInt32LE(sampleRateHz * blockAlign, 28)
  wav.writeUInt16LE(blockAlign, 32)
  wav.writeUInt16LE(bitsPerSample, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataSize, 40)
  Buffer.from(pcm16).copy(wav, 44)

  return wav
}
