import { describe, it, expect } from 'vitest';
import { confirmationOutcome, voiceActionLabel, formatEvent } from './voice-format';

describe('voice actions and diagnostic formatting', () => {
  it('describes actions but never executes them', () => {
    expect(voiceActionLabel({ type: 'light.turn_on', deviceId: 'kitchen', room: null, value: null, risk: 'low' }))
      .toContain('Turn on light: kitchen');
  });
  it('reports acknowledged, pending, failed and cancelled outcomes accurately', () => {
    expect(confirmationOutcome('completed', [{ status: 'success', message: 'ok' }])).toContain('confirmed');
    expect(confirmationOutcome('completed', [{ status: 'pending', message: 'pending' }])).toContain('waiting');
    expect(confirmationOutcome('completed', [{ status: 'failed', message: 'rejected' }])).toContain('rejected');
    expect(confirmationOutcome('cancelled')).toContain('cancelled');
  });
  it('redacts audio base64 content in logs', () => {
    const value = formatEvent({ type: 'assistant_audio_chunk', audioBase64: 'SECRET_DATA', chunkIndex: 1 });
    expect(value).not.toContain('SECRET_DATA');
    expect(value).toContain('audio chunk');
  });
});
