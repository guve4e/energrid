import { describe, it, expect } from 'vitest';
import { floatToPcm16, resampleToPcm16 } from './voice-pcm';

describe('PCM16 voice capture wire format', () => {
  it('clamps audio to signed 16-bit samples', () => {
    expect([...floatToPcm16(new Float32Array([-2, -1, 0, 1, 2]))])
      .toEqual([-32768, -32768, 0, 32767, 32767]);
  });
  it('retains existing 16kHz rate and downsamples 48kHz frames', () => {
    expect([...resampleToPcm16(new Float32Array([1, 0, 0, .5, 0, 0]), 48000)])
      .toEqual([32767, 16383]);
  });
});
