import type { ReceiptDocumentEntryV1_1, ReceiptExtractionV1 } from './receipt-extraction.types';
import { previewFinancialDocument } from './financial-document-preview';

const field = <T>(value: T | null, sourceLineIds: number[] = []) => ({
  value, confidence: value === null ? null : 0.99, uncertainty: null,
  sourceText: sourceLineIds.length ? `evidence-${sourceLineIds.join('-')}` : null, sourceLineIds,
});

function entry(kind: ReceiptDocumentEntryV1_1['kind']['value'], id: number, values: Partial<ReceiptDocumentEntryV1_1> = {}): ReceiptDocumentEntryV1_1 {
  return {
    kind: field(kind, [id]), description: field(kind, [id]), amount: field(null), signedAmount: field(null),
    quantity: field(null), unit: field(null), unitPrice: field(null), discount: field(null), tax: field(null), taxIncluded: field(null),
    adjustmentKind: field(null), includedInTotal: field(null), includedInLineTotal: field(null), relatedPurchaseIndex: field(null), suggestedCategory: field(null),
    ...values,
  };
}

function input(): any {
  const p1 = entry('purchase', 3, { description: field('Purchase A', [3]), amount: field('5.11', [3]) });
  const p2 = entry('purchase', 4, { description: field('Purchase B', [4]), amount: field('67.99', [4]) });
  const discount = entry('discount', 5, {
    description: field('Discount', [5]), amount: field('2.56', [5]), signedAmount: field('-2.56', [5]),
    adjustmentKind: field('discount', [5]), includedInTotal: field(true, [5]), includedInLineTotal: field(false, [5]), relatedPurchaseIndex: field(0, [5]),
  });
  const subtotal = entry('subtotal', 6, { description: field('Subtotal', [6]), amount: field('70.54', [6]) });
  const total = entry('final_total', 7, { description: field('Total', [7]), amount: field('70.54', [7]) });
  const payment = entry('payment', 8, { description: field('Payment', [8]), amount: field('70.54', [8]) });
  const extraction: ReceiptExtractionV1 = {
    schemaVersion: 'receipt-extraction-v1.1', documentType: field('receipt', [0]), merchant: field('Merchant', [0]),
    date: field('2026-10-27', [1]), time: field(null), currency: field('EUR', [2]), subtotal: field('70.54', [6]),
    taxTotal: field(null), discountTotal: field('2.56', [5]), depositTotal: field(null), total: field('70.54', [7]),
    reportedArticleCount: field(2, [9]), adjustments: [], sourceText: 'Synthetic financial document evidence.',
    items: [], documentEntries: [p1, p2, discount, subtotal, total, payment], warnings: [],
  };
  return { schemaVersion: 'financial-document-interpretation-v1', evidence: Array.from({ length: 10 }, (_, id) => ({ id, order: id, text: `line ${id}` })), extraction };
}

describe('previewFinancialDocument', () => {
  it('reconciles evidence-backed purchases without requiring optional quantities, units, prices, or tax', () => {
    const preview = previewFinancialDocument(input());
    expect(preview).toMatchObject({
      status: 'reconciled', confirmationEligibility: { eligible: true },
      reconciliation: { status: 'reconciled', purchaseTotal: '73.1', appliedAdjustments: '-2.56', calculatedFinalTotal: '70.54', difference: '0' },
    });
    expect(preview.purchases).toHaveLength(2);
    expect(preview.purchases[0]).toMatchObject({ quantity: { value: null }, unit: { value: null }, unitPrice: { value: null } });
    expect(preview.otherEntries.map(({ kind }) => kind)).toEqual(['subtotal', 'final_total', 'payment']);
    expect(preview.findings.map(({ code }) => code)).toContain('optional_item_detail_unknown');
    expect(preview.findings.some(({ severity }) => severity === 'review')).toBe(false);
  });

  it('preserves an allocated discount and requires review for an unallocated transaction discount', () => {
    const allocated = previewFinancialDocument(input());
    expect(allocated.adjustments[0].relatedPurchaseIndex.value).toBe(0);
    const unallocatedInput = input();
    unallocatedInput.extraction.documentEntries[2].relatedPurchaseIndex = field(null);
    const unallocated = previewFinancialDocument(unallocatedInput);
    expect(unallocated.reconciliation).toMatchObject({ status: 'reconciled', difference: '0' });
    expect(unallocated.status).toBe('needs_review');
    expect(unallocated.confirmationEligibility.eligible).toBe(false);
    expect(unallocated.findings.map(({ code }) => code)).toContain('adjustment_unallocated');
  });

  it('rejects duplicate adjustments and avoids counting subtotal or payment as purchases', () => {
    const duplicateInput = input();
    duplicateInput.extraction.documentEntries.splice(3, 0, { ...duplicateInput.extraction.documentEntries[2] });
    const duplicate = previewFinancialDocument(duplicateInput);
    expect(duplicate.status).toBe('invalid');
    expect(duplicate.findings.map(({ code }) => code)).toContain('duplicate_adjustment');
    expect(duplicate.purchases).toHaveLength(2);
    expect(duplicate.reconciliation.purchaseTotal).toBe('73.1');
  });

  it('flags a missing purchased line and missing purchase money evidence', () => {
    const missingLineInput = input();
    missingLineInput.extraction.documentEntries.splice(1, 1);
    const missingLine = previewFinancialDocument(missingLineInput);
    expect(missingLine.status).toBe('invalid');
    expect(missingLine.findings.map(({ code }) => code)).toContain('purchase_count_mismatch');

    const missingAmountInput = input();
    missingAmountInput.extraction.documentEntries[0].amount = field(null);
    const missingAmount = previewFinancialDocument(missingAmountInput);
    expect(missingAmount.status).toBe('invalid');
    expect(missingAmount.findings.map(({ code }) => code)).toContain('purchase_amount_missing');
    expect(missingAmount.reconciliation).toMatchObject({ status: 'undetermined', purchaseTotal: null, calculatedFinalTotal: null });
  });

  it('rejects invalid evidence references, mixed currencies, and conflicting totals', () => {
    const badRef = input();
    badRef.extraction.merchant = field('Merchant', [999]);
    expect(previewFinancialDocument(badRef)).toMatchObject({ status: 'invalid', confirmationEligibility: { eligible: false } });

    const mixedCurrency = input();
    mixedCurrency.extraction.documentEntries[0].currency = field('USD', [3]);
    expect(previewFinancialDocument(mixedCurrency).findings.map(({ code }) => code)).toContain('entry_currency_mismatch');

    const conflicting = input();
    conflicting.extraction.documentEntries[4].amount = field('70.53', [7]);
    expect(previewFinancialDocument(conflicting).findings.map(({ code }) => code)).toContain('summary_total_conflict');
  });

  it('flags inconsistent line arithmetic and discount double counting', () => {
    const arithmetic = input();
    const purchase = arithmetic.extraction.documentEntries[0];
    purchase.quantity = field('2', [3]); purchase.unit = field('each', [3]); purchase.unitPrice = field('3', [3]);
    purchase.discount = field('0', [3]); purchase.tax = field('0', [3]); purchase.taxIncluded = field(true, [3]);
    expect(previewFinancialDocument(arithmetic).findings.map(({ code }) => code)).toContain('purchase_line_arithmetic_conflict');

    const double = input();
    double.extraction.documentEntries[0].discount = field('2.56', [3]);
    expect(previewFinancialDocument(double).findings.map(({ code }) => code)).toContain('discount_double_count_risk');
  });
});
