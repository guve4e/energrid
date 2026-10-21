import { describe, expect, it } from 'vitest';
import { cloudEvidenceConsentMessage } from './network-endpoint-investigation';

describe('cloudEvidenceConsentMessage', () => {
  it('names the local network metadata sent to OpenAI and what is excluded', () => {
    const message = cloudEvidenceConsentMessage('openai');
    expect(message).toContain('to OpenAI');
    expect(message).toContain('IP address');
    expect(message).toContain('observed or device-reported MAC');
    expect(message).toContain('service details');
    expect(message).toContain('device/protocol identifiers');
    expect(message).toContain('observer host/interface');
    expect(message).toContain('payloads and credentials are excluded');
  });
});
