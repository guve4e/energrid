import { reconcileReceiptExtraction } from '../domain/receipt-extraction';
import { LocalDocumentUnderstandingAdapter, type LocalOcrLine } from './local-document-understanding.adapter';

const lines: LocalOcrLine[] = [
  { id: 0, order: 0, text: 'МАГАЗИН', confidence: 0.99, box: [0, 0, 10, 10] },
  { id: 1, order: 1, text: 'Продукт 73.10', confidence: 0.91, box: [0, 10, 10, 20] },
  { id: 2, order: 2, text: 'Отстъпка -2.56', confidence: 0.94, box: [0, 20, 10, 30] },
  { id: 3, order: 3, text: 'Общо 70.54', confidence: 0.99, box: [0, 30, 10, 40] },
];

function proposal() {
  const field = <T>(value: T | null, sourceLineIds: number[] = []) => ({ value, sourceLineIds, uncertainty: null });
  const entry = (kind: string, amount: string, sourceLineId: number, values: Record<string, unknown> = {}) => ({
    kind: field(kind, [sourceLineId]), description: field(kind, [sourceLineId]), amount: field(amount, [sourceLineId]),
    signedAmount: field(kind === 'discount' ? '-2.56' : null, [sourceLineId]), quantity: field(kind === 'purchase' ? '1' : null, [sourceLineId]),
    unit: field(kind === 'purchase' ? 'each' : null, [sourceLineId]), unitPrice: field(kind === 'purchase' ? '73.10' : null, [sourceLineId]),
    lineTotal: field(kind === 'purchase' ? '73.10' : null, [sourceLineId]), discount: field(null), tax: field(null), taxIncluded: field(null),
    includedInTotal: field(kind === 'discount' ? true : null, [sourceLineId]), includedInLineTotal: field(kind === 'discount' ? false : null, [sourceLineId]), sourceLineIds: [sourceLineId], uncertainty: null, ...values,
    relatedPurchaseIndex: field(null),
  });
  return {
    schemaVersion: 'local-financial-document-proposal-v1',
    documentType: field('receipt', [0]), merchant: field('МАГАЗИН', [0]), transactionDate: field('2026-10-27', [0]), currency: field('EUR', [3]),
    reportedArticleCount: field(1, [1]),
    entries: [entry('purchase', '73.10', 1, { discount: field('0', [1]), tax: field('0', [1]), taxIncluded: field(true, [1]) }), entry('discount', '2.56', 2), entry('final_total', '70.54', 3)], warnings: [],
  };
}

describe('LocalDocumentUnderstandingAdapter', () => {
  it('composes local OCR and interpretation, preserves OCR line references, and uses exact Finance reconciliation', async () => {
    const ocr = { recognize: jest.fn().mockResolvedValue({ provider: 'paddleocr', model: 'pp-ocrv5-bg', lines }) };
    const interpreter = { interpret: jest.fn().mockResolvedValue({ model: 'local-instruct-model', proposal: proposal(), inferenceMs: 1234 }) };
    const adapter = new LocalDocumentUnderstandingAdapter(ocr, interpreter);

    const result = await adapter.extract({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }, { cloudDataConsent: false, categories: ['Groceries'] });
    expect(result.provider).toBe('local:paddleocr');
    expect(result.model).toBe('local-instruct-model');
    expect(interpreter.interpret).toHaveBeenCalledWith(expect.objectContaining({ categories: ['Groceries'], lines, cloudDataConsent: false }));
    expect(result.extraction.total).toMatchObject({ value: '70.54', sourceLineIds: [3] });
    expect(result.extraction.ocrEvidence).toMatchObject({ provider: 'paddleocr', model: 'pp-ocrv5-bg', lines });
    expect(result.extraction.items).toHaveLength(1);
    expect(result.extraction.adjustments[0]).toMatchObject({ amount: '2.56', signedAmount: '-2.56', kind: 'discount', includedInTotal: true });
    expect(reconcileReceiptExtraction(result.extraction)).toMatchObject({ matched: true, itemTotal: '70.54', total: '70.54', difference: '0' });
  });

  it('rejects invented OCR evidence references before returning a financial extraction', async () => {
    const candidate = proposal() as any;
    candidate.merchant.sourceLineIds = [999];
    const adapter = new LocalDocumentUnderstandingAdapter(
      { recognize: async () => ({ provider: 'local-ocr', model: 'fixture', lines }) },
      { interpret: async () => ({ model: 'fixture', proposal: candidate, inferenceMs: 1 }) },
    );
    await expect(adapter.extract({ bytes: new Uint8Array([1]), mediaType: 'image/png' }, { cloudDataConsent: false })).rejects.toThrow(/evidence that does not exist/i);
  });

  it('rejects empty images and malformed local OCR evidence', async () => {
    const adapter = new LocalDocumentUnderstandingAdapter(
      { recognize: async () => ({ provider: 'local-ocr', model: 'fixture', lines: [{ ...lines[0], id: -1 }] }) },
      { interpret: jest.fn() },
    );
    await expect(adapter.extract({ bytes: new Uint8Array(), mediaType: 'image/jpeg' }, { cloudDataConsent: false })).rejects.toThrow(/empty/i);
    await expect(adapter.extract({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg' }, { cloudDataConsent: false })).rejects.toThrow(/malformed/i);
  });
});
