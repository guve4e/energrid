const mockResponsesCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ responses: { create: mockResponsesCreate } })),
}));

import { OpenAiDocumentUnderstandingAdapter } from './openai-document-understanding.adapter';

const field = (value: unknown) => ({ value, confidence: value === null ? null : 0.9, uncertainty: null, sourceText: value === null ? null : String(value) });
const extraction = {
  schemaVersion: 'receipt-extraction-v1', documentType: field('receipt'), merchant: field('Shop'), date: field('2026-10-27'), time: field(null), currency: field('EUR'),
  subtotal: field('70.54'), taxTotal: field(null), discountTotal: field(null), depositTotal: field(null), total: field('70.54'),
  reportedArticleCount: field(13), adjustments: [], sourceText: '[sanitized]', items: [], warnings: [],
};

describe('OpenAiDocumentUnderstandingAdapter', () => {
  const original = { mode: process.env.ENERGRID_LLM_MODE, provider: process.env.ENERGRID_LLM_PROVIDER, key: process.env.OPENAI_API_KEY, model: process.env.ENERGRID_LLM_MODEL };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENERGRID_LLM_MODE = 'cloud-enabled';
    process.env.ENERGRID_LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-only';
    process.env.ENERGRID_LLM_MODEL = 'test-model';
  });
  afterAll(() => {
    for (const [key, value] of Object.entries({ ENERGRID_LLM_MODE: original.mode, ENERGRID_LLM_PROVIDER: original.provider, OPENAI_API_KEY: original.key, ENERGRID_LLM_MODEL: original.model })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('requests full-document itemization and returns safe completion metadata', async () => {
    mockResponsesCreate.mockResolvedValue({ status: 'completed', output_text: JSON.stringify(extraction), usage: { output_tokens: 512 } });
    const adapter = new OpenAiDocumentUnderstandingAdapter();
    const result = await adapter.extract({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }, { cloudDataConsent: true });
    const request = mockResponsesCreate.mock.calls[0][0];
    expect(request.max_output_tokens).toBe(12000);
    expect(request.instructions).toMatch(/every visible purchased-product line/i);
    expect(request.instructions).toMatch(/actual transaction date/i);
    expect(request.text.format.schema.properties.items.maxItems).toBe(1000);
    expect(result).toMatchObject({ extraction, provider: 'openai', model: 'test-model', diagnostics: { responseStatus: 'completed', outputTokens: 512 } });
  });

  it('rejects an incomplete or truncated provider response before any draft can be created', async () => {
    mockResponsesCreate.mockResolvedValue({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '' });
    await expect(new OpenAiDocumentUnderstandingAdapter().extract({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }, { cloudDataConsent: true }))
      .rejects.toThrow(/stopped before it finished/i);
  });

  it('retains the explicit cloud-consent boundary', async () => {
    await expect(new OpenAiDocumentUnderstandingAdapter().extract({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }, { cloudDataConsent: false }))
      .rejects.toThrow(/consent/i);
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });
});
