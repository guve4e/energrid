/** Preserve the existing PCM16 wire format used by the voice gateway. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export function resampleToPcm16(input: Float32Array, inputRate: number, outputRate = 16000): Int16Array {
  if (inputRate === outputRate) return floatToPcm16(input);
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    output[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))];
  }
  return floatToPcm16(output);
}
