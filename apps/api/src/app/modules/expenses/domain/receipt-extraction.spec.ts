import { reconcileReceiptExtraction, validateReceiptExtraction } from './receipt-extraction';
import type { ReceiptExtractionV1 } from './receipt-extraction.types';

const field = <T>(value: T | null) => ({ value, confidence: value === null ? null : 0.98, uncertainty: null, sourceText: value === null ? null : String(value) });

function receipt(overrides: Partial<ReceiptExtractionV1> = {}): ReceiptExtractionV1 {
  return {
    schemaVersion: 'receipt-extraction-v1', documentType: field('receipt'), merchant: field('Лидл'), date: field('2026-10-28'), time: field('12:31'), currency: field('EUR'),
    subtotal: field('2.5'), taxTotal: field('0.5'), discountTotal: field('0'), depositTotal: field(null), total: field('2.5'), adjustments: [], sourceText: 'Кисело мляко 2,50 €',
    items: [{ originalDescription: field('Кисело мляко'), normalizedDescription: field('Yogurt'), quantity: field('0.5'), unit: field('kg'), packaging: field('500 g'), unitPrice: field('5'), lineTotal: field('2.5'), discount: field('0'), tax: field('0.5'), taxIncluded: field(true), suggestedCategory: field('Groceries') }],
    warnings: [], ...overrides,
  };
}

describe('receipt extraction domain', () => {
  it('accepts Bulgarian receipt data and preserves exact decimal strings', () => {
    const result = validateReceiptExtraction(receipt());
    expect(result.items[0].quantity.value).toBe('0.5');
    expect(result.items[0].originalDescription.value).toBe('Кисело мляко');
    expect(reconcileReceiptExtraction(result)).toMatchObject({ matched: true, itemTotal: '2.5', total: '2.5', difference: '0' });
  });

  it('applies receipt-level discount and deposit exactly once', () => {
    const result = validateReceiptExtraction(receipt({
      total: field('3.25'),
      adjustments: [
        { label: 'Discount', amount: '0.50', kind: 'discount', includedInTotal: true },
        { label: 'Bottle deposit', amount: '1.25', kind: 'deposit', includedInTotal: true },
      ],
    }));
    expect(reconcileReceiptExtraction(result)).toMatchObject({ matched: true, itemTotal: '3.25', total: '3.25' });
  });

  it('keeps missing and ambiguous fields unknown and reports a material mismatch', () => {
    const result = validateReceiptExtraction(receipt({ total: field('4'), currency: field(null), items: [
      { ...receipt().items[0], lineTotal: field(null), taxIncluded: field(null) },
    ] }));
    const reconciliation = reconcileReceiptExtraction(result);
    expect(result.currency.value).toBeNull();
    expect(reconciliation.matched).toBeNull();
    expect(reconciliation.warnings.some((warning) => warning.includes('unknown'))).toBe(true);
    expect(reconciliation.warnings.some((warning) => warning.includes('Receipt currency'))).toBe(true);
  });

  it('rejects malformed and non-decimal model output', () => {
    expect(() => validateReceiptExtraction({ schemaVersion: 'v2' })).toThrow();
    expect(() => validateReceiptExtraction(receipt({ total: field('€3.00') }))).toThrow();
  });

  it('rejects unexpected fields from an untrusted extraction provider', () => {
    expect(() => validateReceiptExtraction({ ...receipt(), accountId: 'attacker-controlled' })).toThrow(/unexpected fields/);
    expect(() => validateReceiptExtraction(receipt({ items: [{ ...receipt().items[0], sku: 'unmodeled' }] }))).toThrow(/unexpected fields/);
  });
});
