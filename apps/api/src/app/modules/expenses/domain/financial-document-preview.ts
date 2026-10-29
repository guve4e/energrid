import { currencyMinorUnits, expectedItemLineTotal, normalizeCurrency } from './expense-rules';
import { addDecimal, compareDecimal, financeDecimal, roundDecimal } from './decimal';
import { validateReceiptExtraction } from './receipt-extraction';
import type { ExtractedField, ReceiptDocumentEntryV1_1, ReceiptExtractionV1 } from './receipt-extraction.types';

export interface FinancialDocumentEvidence {
  id: number;
  order: number;
  text: string;
}

export interface FinancialDocumentPreviewInput {
  schemaVersion: 'financial-document-interpretation-v1';
  evidence: readonly FinancialDocumentEvidence[];
  extraction: ReceiptExtractionV1;
}

export type FinancialDocumentPreviewStatus = 'reconciled' | 'needs_review' | 'invalid';
export type FinancialDocumentFindingSeverity = 'info' | 'review' | 'error';

export interface FinancialDocumentFinding {
  code: string;
  severity: FinancialDocumentFindingSeverity;
  message: string;
  entryIndex?: number;
}

export interface FinancialDocumentPreview {
  schemaVersion: 'financial-document-preview-v1';
  status: FinancialDocumentPreviewStatus;
  documentType: string | null;
  merchant: PreviewFact<string>;
  documentDate: PreviewFact<string>;
  currency: PreviewFact<string>;
  reportedFinalTotal: PreviewFact<string>;
  purchases: Array<{
    description: PreviewFact<string>;
    amount: PreviewFact<string>;
    quantity: PreviewFact<string>;
    unit: PreviewFact<string>;
    unitPrice: PreviewFact<string>;
    category: PreviewFact<string>;
  }>;
  adjustments: Array<{
    kind: string;
    description: PreviewFact<string>;
    amount: PreviewFact<string>;
    signedAmount: PreviewFact<string>;
    includedInTotal: PreviewFact<boolean>;
    includedInLineTotal: PreviewFact<boolean>;
    relatedPurchaseIndex: PreviewFact<number>;
  }>;
  otherEntries: Array<{
    kind: string;
    description: PreviewFact<string>;
    amount: PreviewFact<string>;
  }>;
  reconciliation: {
    status: 'reconciled' | 'unreconciled' | 'undetermined';
    purchaseTotal: string | null;
    appliedAdjustments: string | null;
    calculatedFinalTotal: string | null;
    reportedFinalTotal: string | null;
    difference: string | null;
  };
  findings: FinancialDocumentFinding[];
  confirmationEligibility: { eligible: boolean; reasons: string[] };
}

interface PreviewFact<T> {
  value: T | null;
  evidenceLineIds: number[];
  uncertainty: string | null;
}

const EMPTY_FACT = <T>(): PreviewFact<T> => ({ value: null, evidenceLineIds: [], uncertainty: null });

/** Pure, provider-neutral Finance validation. This function has no persistence dependencies. */
export function previewFinancialDocument(input: unknown): FinancialDocumentPreview {
  let extraction: ReceiptExtractionV1;
  let evidence: FinancialDocumentEvidence[];
  try {
    ({ extraction, evidence } = validatePreviewInput(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document interpretation is invalid';
    return invalidPreview(message);
  }

  const findings: FinancialDocumentFinding[] = [];
  const add = (code: string, severity: FinancialDocumentFindingSeverity, message: string, entryIndex?: number) => {
    findings.push({ code, severity, message, ...(entryIndex === undefined ? {} : { entryIndex }) });
  };
  const entries = extraction.documentEntries!;
  const purchases = entries.filter((entry) => entry.kind.value === 'purchase');
  const adjustments = entries.filter((entry) => entry.kind.value === 'discount' || entry.kind.value === 'adjustment');
  const summaries = entries.filter((entry) => entry.kind.value === 'subtotal' || entry.kind.value === 'final_total' || entry.kind.value === 'payment');
  const currency = extraction.currency.value ? normalizeCurrency(extraction.currency.value) : null;
  const scale = currency ? currencyMinorUnits(currency) : 2;

  if (!currency) add('currency_missing', 'error', 'A transaction currency is required.');
  if (!extraction.total.value) add('final_total_missing', 'error', 'A final transaction amount is required.');
  if (!extraction.merchant.value) add('merchant_missing', 'review', 'Merchant information needs review.');
  if (!extraction.date.value) add('date_missing', 'review', 'Document date needs review.');
  for (const [key, fact] of [['currency', extraction.currency], ['total', extraction.total], ['merchant', extraction.merchant], ['date', extraction.date]] as const) {
    if (fact.uncertainty) add(`${key}_uncertain`, 'review', `${key} has unresolved extraction uncertainty.`);
  }
  if (currency) {
    for (const amount of [extraction.subtotal.value, extraction.taxTotal.value, extraction.discountTotal.value, extraction.depositTotal.value, extraction.total.value]) {
      if (amount !== null && !hasMinorUnitPrecision(amount, scale)) add('unsupported_currency_precision', 'error', 'A document summary amount exceeds the currency minor-unit precision.');
    }
  }

  const finalTotalEntries = entries.filter((entry) => entry.kind.value === 'final_total');
  if (!finalTotalEntries.length) add('final_total_evidence_missing', 'error', 'The final amount has no final-total document entry.');
  const finalEntryAmounts = finalTotalEntries.map((entry) => entry.amount.value).filter((value): value is string => value !== null);
  if (finalEntryAmounts.length !== finalTotalEntries.length) add('final_total_evidence_incomplete', 'error', 'A final-total entry is missing its amount.');
  if (finalEntryAmounts.some((amount) => compareDecimal(amount, finalEntryAmounts[0]) !== 0)) {
    add('conflicting_final_totals', 'error', 'The document contains conflicting final totals.');
  }
  if (extraction.total.value && finalEntryAmounts[0] && compareDecimal(extraction.total.value, finalEntryAmounts[0]) !== 0) {
    add('summary_total_conflict', 'error', 'The normalized final amount conflicts with the cited final-total entry.');
  }
  if (finalTotalEntries.length > 1) {
    const firstRefs = [...(finalTotalEntries[0].amount.sourceLineIds ?? [])].sort((a, b) => a - b).join(',');
    if (finalTotalEntries.slice(1).some((entry) => [...(entry.amount.sourceLineIds ?? [])].sort((a, b) => a - b).join(',') === firstRefs)) {
      add('duplicate_final_total_evidence', 'error', 'The same final-total evidence is represented more than once.');
    }
  }

  if (!purchases.length) {
    add('purchase_itemization_missing', 'review', 'No purchased lines were provided for review.');
  }
  if (extraction.reportedArticleCount.value !== null && extraction.reportedArticleCount.value !== purchases.length) {
    add('purchase_count_mismatch', 'review', 'The reported article count differs from the extracted purchase-line count.');
  }

  let purchaseTotal = '0';
  let purchaseCalculationComplete = purchases.length > 0;
  const normalizedPurchases = purchases.map((entry, index) => {
    const amount = resolvePurchaseAmount(entry, index, add);
    if (amount.value === null) purchaseCalculationComplete = false;
    if (amount.value !== null && compareDecimal(amount.value, '0') <= 0) add('purchase_amount_invalid', 'error', 'A purchase line amount must be greater than zero.', index);
    if (amount.value !== null) purchaseTotal = addDecimal(purchaseTotal, amount.value);
    if (amount.value !== null && currency && !hasMinorUnitPrecision(amount.value, scale)) {
      add('unsupported_currency_precision', 'error', 'A purchase amount exceeds the currency minor-unit precision.', index);
    }
    if (!entry.description.value) add('purchase_description_missing', 'review', 'A purchase description needs review.', index);
    if (entry.description.uncertainty) add('purchase_description_uncertain', 'review', 'A purchase description has unresolved uncertainty.', index);
    if (entry.amount.uncertainty) add('purchase_amount_uncertain', 'review', 'A purchase amount has unresolved uncertainty.', index);
    if (entry.quantity.value === null || entry.unit.value === null || entry.unitPrice.value === null) {
      add('optional_item_detail_unknown', 'info', 'Quantity, unit, or unit price is not fully specified; no value was inferred.', index);
    }
    if (entry.currency?.value && currency && normalizeCurrency(entry.currency.value) !== currency) {
      add('entry_currency_mismatch', 'error', 'A purchase-line currency differs from the document currency.', index);
    }
    validateOptionalPurchaseValues(entry, index, add);
    if (entry.quantity.value !== null && entry.unitPrice.value !== null && entry.discount.value !== null && entry.tax.value !== null && entry.taxIncluded.value !== null && amount.value !== null) {
      const expected = expectedItemLineTotal({ quantity: entry.quantity.value, unitPrice: entry.unitPrice.value, discount: entry.discount.value, tax: entry.tax.value, taxIncluded: entry.taxIncluded.value }, currency ?? 'EUR');
      if (compareDecimal(expected, amount.value) !== 0) add('purchase_line_arithmetic_conflict', 'error', 'The purchase quantity, price, discounts, tax, and line amount do not agree.', index);
    }
    return {
      description: fact(entry.description), amount,
      quantity: fact(entry.quantity), unit: fact(entry.unit), unitPrice: fact(entry.unitPrice), category: fact(entry.suggestedCategory),
    };
  });

  let appliedAdjustments = '0';
  let adjustmentCalculationComplete = true;
  const duplicateAdjustmentKeys = new Set<string>();
  const normalizedAdjustments = adjustments.map((entry, index) => {
    const kind = entry.adjustmentKind.value ?? (entry.kind.value === 'discount' ? 'discount' : 'other');
    const amount = entry.amount.value;
    const signedAmount = entry.signedAmount.value;
    const refs = entry.description.sourceLineIds ?? entry.kind.sourceLineIds ?? [];
    const duplicateKey = `${kind}:${amount}:${signedAmount}:${[...refs].sort((a, b) => a - b).join(',')}`;
    if (duplicateAdjustmentKeys.has(duplicateKey)) add('duplicate_adjustment', 'error', 'The same adjustment evidence appears more than once.', index);
    duplicateAdjustmentKeys.add(duplicateKey);

    if (amount === null) {
      add('adjustment_amount_missing', entry.includedInTotal.value === true ? 'error' : 'review', 'An adjustment amount is missing.', index);
      if (entry.includedInTotal.value === true || entry.includedInTotal.value === null) adjustmentCalculationComplete = false;
    } else if (signedAmount !== null && compareDecimal(abs(signedAmount), amount) !== 0) {
      add('adjustment_sign_mismatch', 'error', 'The adjustment amount and signed effect disagree.', index);
    } else if (compareDecimal(amount, '0') <= 0) {
      add('adjustment_amount_invalid', 'error', 'An adjustment amount must be greater than zero.', index);
    } else if (signedAmount === null && entry.includedInTotal.value === true) {
      add('adjustment_effect_missing', 'error', 'An included adjustment needs an explicit signed effect.', index);
      adjustmentCalculationComplete = false;
    }
    if (kind === 'discount' && signedAmount !== null && compareDecimal(signedAmount, '0') >= 0) {
      add('discount_sign_invalid', 'error', 'A discount must have a negative signed effect.', index);
    }
    if (entry.includedInTotal.value === null) {
      add('adjustment_total_inclusion_unknown', 'review', 'Whether an adjustment affects the final total needs review.', index);
      adjustmentCalculationComplete = false;
    }
    if (entry.includedInTotal.value === true && entry.includedInLineTotal.value === null) {
      add('adjustment_line_inclusion_unknown', 'review', 'Whether an adjustment is already reflected in a purchase line needs review.', index);
      adjustmentCalculationComplete = false;
    }
    const relatedIndex = entry.relatedPurchaseIndex.value;
    if (relatedIndex !== null && relatedIndex >= purchases.length) {
      add('adjustment_purchase_reference_invalid', 'error', 'An adjustment references a purchase line that does not exist.', index);
    }
    if (kind === 'discount' && relatedIndex === null && entry.includedInTotal.value !== false) {
      add('adjustment_unallocated', 'review', 'The discount is not linked to a specific purchase line.', index);
    }
    if (entry.includedInTotal.value === true && entry.includedInLineTotal.value === false && relatedIndex !== null) {
      const purchaseDiscount = purchases[relatedIndex]?.discount.value;
      if (purchaseDiscount && compareDecimal(purchaseDiscount, '0') > 0) {
        add('discount_double_count_risk', 'error', 'A discount is represented both on the purchase line and as a separate adjustment.', index);
      }
    }
    if (entry.currency?.value && currency && normalizeCurrency(entry.currency.value) !== currency) {
      add('entry_currency_mismatch', 'error', 'An adjustment currency differs from the document currency.', index);
    }
    if (entry.includedInTotal.value === true && entry.includedInLineTotal.value === false && signedAmount !== null) {
      appliedAdjustments = addDecimal(appliedAdjustments, signedAmount);
    }
    if (entry.amount.uncertainty || entry.signedAmount.uncertainty) {
      add('adjustment_uncertain', 'review', 'An adjustment has unresolved extraction uncertainty.', index);
    }
    if (amount !== null && currency && !hasMinorUnitPrecision(amount, scale)) {
      add('unsupported_currency_precision', 'error', 'An adjustment amount exceeds the currency minor-unit precision.', index);
    }
    return {
      kind, description: fact(entry.description), amount: fact(entry.amount), signedAmount: fact(entry.signedAmount),
      includedInTotal: fact(entry.includedInTotal), includedInLineTotal: fact(entry.includedInLineTotal), relatedPurchaseIndex: fact(entry.relatedPurchaseIndex),
    };
  });

  for (const [index, entry] of entries.entries()) {
    if (entry.kind.value === 'purchase' || entry.kind.value === 'discount' || entry.kind.value === 'adjustment') continue;
    if (entry.kind.value === 'final_total' && entry.amount.value === null) continue;
    if (entry.amount.value !== null && currency && !hasMinorUnitPrecision(entry.amount.value, scale)) {
      add('unsupported_currency_precision', 'error', 'A document amount exceeds the currency minor-unit precision.', index);
    }
  }

  const discountEntries = adjustments.filter((entry) => (entry.adjustmentKind.value ?? (entry.kind.value === 'discount' ? 'discount' : 'other')) === 'discount');
  if (extraction.discountTotal.value !== null && discountEntries.length) {
    const entryDiscountTotal = discountEntries.reduce((sum, entry) => entry.amount.value === null ? sum : addDecimal(sum, entry.amount.value), '0');
    if (discountEntries.some((entry) => entry.amount.value === null) || compareDecimal(entryDiscountTotal, extraction.discountTotal.value) !== 0) {
      add('discount_summary_conflict', 'error', 'The discount summary conflicts with the cited discount entries.');
    }
  }
  const subtotalEntries = entries.filter((entry) => entry.kind.value === 'subtotal');
  if (subtotalEntries.length === 1 && extraction.subtotal.value !== null && subtotalEntries[0].amount.value !== null && compareDecimal(extraction.subtotal.value, subtotalEntries[0].amount.value) !== 0) {
    add('subtotal_summary_conflict', 'error', 'The normalized subtotal conflicts with its cited subtotal entry.');
  }

  const reported = extraction.total.value;
  const calculated = reported !== null && purchaseCalculationComplete && adjustmentCalculationComplete ? addDecimal(purchaseTotal, appliedAdjustments) : null;
  const difference = calculated !== null && reported !== null ? addDecimal(calculated, `-${reported}`) : null;
  if (calculated !== null && reported !== null && compareDecimal(calculated, reported) !== 0) {
    add('total_mismatch', 'error', 'Purchase lines and included adjustments do not equal the reported final total.');
  }
  if (reported !== null && currency && !hasMinorUnitPrecision(reported, scale)) {
    add('unsupported_currency_precision', 'error', 'The final amount exceeds the currency minor-unit precision.');
  }

  const paymentEntries = entries.filter((entry) => entry.kind.value === 'payment' && entry.amount.value !== null);
  if (paymentEntries.length && reported !== null) {
    const paymentTotal = paymentEntries.reduce((sum, entry) => addDecimal(sum, entry.amount.value!), '0');
    if (compareDecimal(paymentTotal, reported) !== 0) add('payment_total_differs', 'review', 'Payment entries do not sum to the reported final total.');
  }

  const status = findings.some((item) => item.severity === 'error') ? 'invalid'
    : findings.some((item) => item.severity === 'review') ? 'needs_review' : 'reconciled';
  const reasons = [...new Set(findings.filter((item) => item.severity !== 'info').map((item) => item.code))];
  const otherEntries = summaries.map((entry) => ({ kind: entry.kind.value!, description: fact(entry.description), amount: fact(entry.amount) }));
  const preview: FinancialDocumentPreview = {
    schemaVersion: 'financial-document-preview-v1', status,
    documentType: extraction.documentType.value,
    merchant: fact(extraction.merchant), documentDate: fact(extraction.date), currency: fact(extraction.currency),
    reportedFinalTotal: fact(extraction.total), purchases: normalizedPurchases, adjustments: normalizedAdjustments, otherEntries,
    reconciliation: {
      status: calculated === null ? 'undetermined' : difference === '0' ? 'reconciled' : 'unreconciled',
      purchaseTotal: purchaseCalculationComplete ? purchaseTotal : null, appliedAdjustments: adjustmentCalculationComplete ? appliedAdjustments : null,
      calculatedFinalTotal: calculated, reportedFinalTotal: reported, difference,
    },
    findings, confirmationEligibility: { eligible: status === 'reconciled', reasons },
  };
  return preview;
}

function validatePreviewInput(value: unknown): { extraction: ReceiptExtractionV1; evidence: FinancialDocumentEvidence[] } {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== ['evidence', 'extraction', 'schemaVersion'].sort().join('|') || value.schemaVersion !== 'financial-document-interpretation-v1') {
    throw new Error('Expected a versioned financial document interpretation.');
  }
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 2000) throw new Error('Document evidence lines are missing or exceed the supported limit.');
  const ids = new Set<number>();
  const evidence = value.evidence.map((line: unknown) => {
    if (!isRecord(line) || Object.keys(line).sort().join('|') !== ['id', 'order', 'text'].sort().join('|') || !Number.isSafeInteger(line.id) || line.id < 0 || !Number.isSafeInteger(line.order) || line.order < 0 || typeof line.text !== 'string' || !line.text.trim() || line.text.length > 10000) {
      throw new Error('Document evidence contains an invalid line.');
    }
    if (ids.has(line.id)) throw new Error('Document evidence contains a duplicate line identity.');
    ids.add(line.id);
    return line as FinancialDocumentEvidence;
  });
  const extraction = validatePreviewExtraction(value.extraction);
  if (extraction.schemaVersion !== 'receipt-extraction-v1.1' || !extraction.documentEntries?.length) throw new Error('Evidence-linked document entries require receipt-extraction-v1.1.');
  const fields = [
    extraction.documentType, extraction.merchant, extraction.date, extraction.time, extraction.currency, extraction.subtotal,
    extraction.taxTotal, extraction.discountTotal, extraction.depositTotal, extraction.total, extraction.reportedArticleCount,
    ...extraction.documentEntries.flatMap((entry) => Object.values(entry).filter((field) => field !== undefined)),
  ] as Array<ExtractedField<unknown>>;
  for (const field of fields) {
    if (field.value === null) continue;
    const refs = field.sourceLineIds;
    if (!refs?.length) throw new Error('Every extracted value must cite at least one evidence line.');
    if (refs.some((id) => !ids.has(id))) throw new Error('An extracted value cites an unknown evidence line.');
  }
  return { extraction, evidence };
}

function validatePreviewExtraction(value: unknown): ReceiptExtractionV1 {
  if (isRecord(value) && value.schemaVersion === 'receipt-extraction-v1.1' && Array.isArray(value.documentEntries) && !Array.isArray(value.entries)) {
    const { schemaVersion, documentType, merchant, date, time, currency, subtotal, taxTotal, discountTotal, depositTotal, total, reportedArticleCount, sourceText, warnings } = value;
    return validateReceiptExtraction({
      schemaVersion, documentType, merchant, date, time, currency, subtotal, taxTotal, discountTotal, depositTotal,
      reportedArticleCount, total, sourceText, entries: value.documentEntries, warnings,
    });
  }
  return validateReceiptExtraction(value);
}

function resolvePurchaseAmount(
  entry: ReceiptDocumentEntryV1_1,
  index: number,
  add: (code: string, severity: FinancialDocumentFindingSeverity, message: string, entryIndex?: number) => void,
): PreviewFact<string> {
  const amount = entry.amount.value;
  if (amount === null) {
    add('purchase_amount_missing', 'error', 'An itemized purchase needs a source-backed line amount.', index);
    return fact(entry.amount);
  }
  return fact(entry.amount);
}

function validateOptionalPurchaseValues(
  entry: ReceiptDocumentEntryV1_1,
  index: number,
  add: (code: string, severity: FinancialDocumentFindingSeverity, message: string, entryIndex?: number) => void,
) {
  if (entry.quantity.value !== null && compareDecimal(entry.quantity.value, '0') <= 0) add('purchase_quantity_invalid', 'error', 'A specified purchase quantity must be positive.', index);
  if (entry.unitPrice.value !== null && compareDecimal(entry.unitPrice.value, '0') < 0) add('purchase_unit_price_invalid', 'error', 'A specified unit price cannot be negative.', index);
}

function fact<T>(value: ExtractedField<T>): PreviewFact<T> {
  return { value: value.value, evidenceLineIds: [...(value.sourceLineIds ?? [])], uncertainty: value.uncertainty };
}

function hasMinorUnitPrecision(value: string, scale: number): boolean {
  return roundDecimal(value, scale) === financeDecimal(value);
}

function abs(value: string): string { return value.startsWith('-') ? value.slice(1) : value; }
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function invalidPreview(message: string): FinancialDocumentPreview {
  const finding = { code: 'invalid_interpretation', severity: 'error' as const, message };
  return {
    schemaVersion: 'financial-document-preview-v1', status: 'invalid', documentType: null,
    merchant: EMPTY_FACT(), documentDate: EMPTY_FACT(), currency: EMPTY_FACT(), reportedFinalTotal: EMPTY_FACT(),
    purchases: [], adjustments: [], otherEntries: [],
    reconciliation: { status: 'undetermined', purchaseTotal: null, appliedAdjustments: null, calculatedFinalTotal: null, reportedFinalTotal: null, difference: null },
    findings: [finding], confirmationEligibility: { eligible: false, reasons: [finding.code] },
  };
}
