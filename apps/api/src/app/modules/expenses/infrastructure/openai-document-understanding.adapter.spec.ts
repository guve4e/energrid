import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { OpenAiDocumentUnderstandingAdapter } from './openai-document-understanding.adapter';

describe('OpenAiDocumentUnderstandingAdapter privacy gates', () => {
  const keys = ['ENERGRID_LLM_MODE', 'ENERGRID_LLM_PROVIDER', 'OPENAI_API_KEY', 'ENERGRID_LLM_MODEL'] as const;
  let original: Record<string, string | undefined>;
  beforeEach(() => { original = Object.fromEntries(keys.map((key) => [key, process.env[key]])); });
  afterEach(() => { for (const key of keys) { const value = original[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  it('refuses cloud work without consent', async () => {
    process.env.ENERGRID_LLM_MODE = 'cloud-enabled';
    process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
    await expect(new OpenAiDocumentUnderstandingAdapter().extract({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }, { cloudDataConsent: false })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects cloud inference in local-only mode even when credentials exist', async () => {
    process.env.ENERGRID_LLM_MODE = 'local-only';
    process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
    await expect(new OpenAiDocumentUnderstandingAdapter().extract({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }, { cloudDataConsent: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
