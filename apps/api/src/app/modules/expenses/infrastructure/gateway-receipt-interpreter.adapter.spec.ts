import { GatewayReceiptInterpreterAdapter } from './gateway-receipt-interpreter.adapter';

describe('GatewayReceiptInterpreterAdapter', () => {
  it('sends only OCR text evidence through the configured provider gateway with structured output and consent', async () => {
    const generate = jest.fn().mockResolvedValue({ text: '{"schemaVersion":"local-financial-document-proposal-v1"}', provider: 'openai', model: 'gpt-5.5' });
    const adapter = new GatewayReceiptInterpreterAdapter({ generate } as any);
    const result = await adapter.interpret({
      lines: [{ id: 3, order: 3, text: 'ОБЩО 70.54', confidence: 0.98, box: [0, 1, 20, 8] }],
      categories: ['Groceries'], cloudDataConsent: true,
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      userPrompt: expect.stringContaining('ОБЩО 70.54'), maxOutputTokens: 12000, timeoutMs: 120000,
      outputSchema: expect.objectContaining({ name: 'local_financial_document_proposal_v1' }),
    }), { cloudDataConsent: true });
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-5.5', proposal: { schemaVersion: 'local-financial-document-proposal-v1' } });
    expect(result.inferenceMs).toEqual(expect.any(Number));
  });

  it('rejects invalid structured output instead of passing it into Finance', async () => {
    const adapter = new GatewayReceiptInterpreterAdapter({ generate: jest.fn().mockResolvedValue({ text: 'not json', provider: 'openai', model: 'test' }) } as any);
    await expect(adapter.interpret({ lines: [{ id: 0, order: 0, text: 'Shop', confidence: null, box: [0, 0, 1, 1] }], categories: [], cloudDataConsent: true })).rejects.toThrow(/invalid structured output/i);
  });
});
