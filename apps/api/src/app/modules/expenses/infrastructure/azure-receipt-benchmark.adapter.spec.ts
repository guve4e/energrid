import mockResponse from './fixtures/azure-prebuilt-receipt-v4.mock.json';
import { reconcileReceiptExtraction } from '../domain/receipt-extraction';
import { AzureReceiptBenchmarkAdapter } from './azure-receipt-benchmark.adapter';

const bytes = new Uint8Array([0x42, 0x47, 0x52]);
const operationUrl = 'https://example.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/operation-1?api-version=2024-11-30';

function response(status: number, body?: unknown, headers?: Record<string, string>) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

describe('AzureReceiptBenchmarkAdapter (mocked service responses only)', () => {
  it('maps Bulgarian receipt fields, keeps OCR/layout provenance, and separates negative adjustments and summaries from purchase items', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(response(202, undefined, { 'operation-location': operationUrl }))
      .mockResolvedValueOnce(response(200, mockResponse));
    let time = 100;
    const adapter = new AzureReceiptBenchmarkAdapter({
      endpoint: 'https://example.cognitiveservices.azure.com', key: 'test-key', fetcher,
      sleep: async () => undefined, now: () => (time += 25),
    });

    const result = await adapter.analyze({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: true });
    const reconciliation = reconcileReceiptExtraction(result.extraction);

    expect(result.provider).toBe('azure-document-intelligence');
    expect(result.model).toBe('prebuilt-receipt');
    expect(result.apiVersion).toBe('2024-11-30');
    expect(result.latencyMs).toBe(25);
    expect(result.extraction.merchant.value).toBe('ЛИДЛ БЪЛГАРИЯ');
    expect(result.extraction.date.value).toBe('2026-10-27');
    expect(result.extraction.currency.value).toBe('EUR');
    expect(result.extraction.items).toHaveLength(2);
    expect(result.extraction.items.map((item) => item.lineTotal.value)).toEqual(['43.1', '30']);
    expect(result.extraction.adjustments).toEqual([
      expect.objectContaining({ amount: '2.56', signedAmount: '-2.56', kind: 'other', includedInTotal: true, includedInLineTotal: false }),
    ]);
    expect(result.extraction.documentEntries?.map((entry) => entry.kind.value)).toEqual([
      'purchase', 'purchase', 'adjustment', 'subtotal', 'final_total', 'payment',
    ]);
    expect(reconciliation).toEqual(expect.objectContaining({ matched: null, itemTotal: '70.54', total: '70.54', difference: '0', incompleteLineCount: 2 }));
    expect(result.extraction.items[0].originalDescription).toEqual(expect.objectContaining({ value: 'ПРОДУКТ А', confidence: 0.96, sourceText: 'ПРОДУКТ А' }));
    expect(result.evidence.recognizedText).toContain('ОТСТЪПКА');
    expect(result.evidence.pages[0].lines[1]).toEqual(expect.objectContaining({ text: 'ПРОДУКТ А 1 x 43.10 43.10', spans: [{ offset: 25, length: 26 }] }));
    expect(result.evidence.pages[0].lines[1].boundingRegions[0].polygon).toHaveLength(8);
    expect(result.evidence.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'Items[0].Description', text: 'ПРОДУКТ А', confidence: 0.96 }),
      expect.objectContaining({ path: 'PaymentMethod', text: 'КАРТА' }),
    ]));

    const [requestUrl, requestInit] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.searchParams.get('api-version')).toBe('2024-11-30');
    expect(requestUrl.searchParams.get('locale')).toBe('bg');
    expect(requestUrl.pathname).toContain('/documentModels/prebuilt-receipt:analyze');
    expect(requestInit.headers).toEqual(expect.objectContaining({ 'Ocp-Apim-Subscription-Key': 'test-key' }));
    expect(JSON.parse(String(requestInit.body))).toEqual({ base64Source: Buffer.from(bytes).toString('base64') });
  });

  it('requires per-call consent and external endpoint/key configuration before making a request', async () => {
    const fetcher = jest.fn();
    const unconfigured = new AzureReceiptBenchmarkAdapter({ endpoint: '', key: '', fetcher });
    await expect(unconfigured.analyze({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: false })).rejects.toThrow(/explicit cloud consent/i);
    await expect(unconfigured.analyze({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: true })).rejects.toThrow(/AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT.*AZURE_DOCUMENT_INTELLIGENCE_KEY/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects operation URLs on another host before sending the key there', async () => {
    const fetcher = jest.fn().mockResolvedValue(response(202, undefined, { 'operation-location': 'https://other.example/result' }));
    const adapter = new AzureReceiptBenchmarkAdapter({ endpoint: 'https://example.cognitiveservices.azure.com', key: 'test-key', fetcher });
    await expect(adapter.analyze({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: true })).rejects.toThrow(/unexpected host/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects empty input and failed provider operations', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(response(202, undefined, { 'operation-location': operationUrl })).mockResolvedValueOnce(response(200, { status: 'failed' }));
    const adapter = new AzureReceiptBenchmarkAdapter({ endpoint: 'https://example.cognitiveservices.azure.com', key: 'test-key', fetcher });
    await expect(adapter.analyze({ bytes: new Uint8Array(), mediaType: 'image/jpeg' }, { cloudDataConsent: true })).rejects.toThrow(/empty/i);
    await expect(adapter.analyze({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: true })).rejects.toThrow(/analysis failed/i);
  });
});
