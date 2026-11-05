import { describe, expect, it } from 'vitest';
import { assistantInlineSegments } from './assistant-inline-markup';

describe('assistant inline formatting', () => {
  it('supports bold evidence and tool names without replacing ordinary text', () => {
    expect(assistantInlineSegments('Валеж: **0 mm** · `weather_get_forecast`')).toEqual([
      { kind: 'text', text: 'Валеж: ' },
      { kind: 'bold', text: '0 mm' },
      { kind: 'text', text: ' · ' },
      { kind: 'code', text: 'weather_get_forecast' },
    ]);
  });

  it('leaves unrecognized markup, newlines, and HTML as text', () => {
    const text = 'A **unfinished\nB <img src=x onerror=alert(1)> [link](https://x.test)';
    expect(assistantInlineSegments(text)).toEqual([{ kind: 'text', text }]);
  });
});
