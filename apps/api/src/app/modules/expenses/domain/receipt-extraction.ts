import { addDecimal, compareDecimal, financeDecimal, roundDecimal } from './decimal';
import { currencyMinorUnits, expectedItemLineTotal } from './expense-rules';
import type { ExtractedField, ReceiptAdjustment, ReceiptDocumentEntryV1_1, ReceiptExtractionV1 } from './receipt-extraction.types';

const fieldKeys = ['value', 'confidence', 'uncertainty', 'sourceText'];

export function validateReceiptExtraction(value: unknown): ReceiptExtractionV1 {
  if (isRecord(value) && value.schemaVersion === 'receipt-extraction-v1.1') {
    if (Array.isArray(value.documentEntries) && !Array.isArray(value.entries)) {
      const { schemaVersion, documentType, merchant, date, time, currency, subtotal, taxTotal, discountTotal, depositTotal, reportedArticleCount, total, sourceText, documentEntries, warnings, ocrEvidence } = value;
      return validateReceiptExtractionV1_1({
        schemaVersion, documentType, merchant, date, time, currency, subtotal, taxTotal, discountTotal, depositTotal,
        reportedArticleCount, total, sourceText, entries: documentEntries, warnings, ...(ocrEvidence === undefined ? {} : { ocrEvidence }),
      });
    }
    return validateReceiptExtractionV1_1(value);
  }
  return validateReceiptExtractionV1(value);
}

function validateReceiptExtractionV1_1(value: Record<string, unknown>): ReceiptExtractionV1 {
  const keys = ['schemaVersion', 'documentType', 'merchant', 'date', 'time', 'currency', 'subtotal', 'taxTotal', 'discountTotal', 'depositTotal', 'reportedArticleCount', 'total', 'sourceText', 'entries', 'warnings'];
  assertKeys(value, Object.hasOwn(value, 'ocrEvidence') ? [...keys, 'ocrEvidence'] : keys, 'Receipt extraction V1.1');
  if (!Array.isArray(value.entries) || value.entries.length > 2000 || !Array.isArray(value.warnings)) throw new Error('Receipt V1.1 entries or warnings are invalid');
  const entries = value.entries.map(validateDocumentEntry);
  const itemEntries = entries.filter((entry) => entry.kind.value === 'purchase');
  const adjustments: ReceiptAdjustment[] = entries
    .filter((entry) => entry.kind.value === 'discount' || entry.kind.value === 'adjustment')
    .map((entry) => ({
      label: entry.description.value ?? 'Receipt adjustment',
      amount: entry.amount.value === null ? null : absoluteDecimal(entry.amount.value),
      signedAmount: entry.signedAmount.value,
      kind: entry.adjustmentKind.value ?? (entry.kind.value === 'discount' ? 'discount' : 'other'),
      includedInTotal: entry.includedInTotal.value,
      includedInLineTotal: entry.includedInLineTotal.value,
      relatedPurchaseIndex: entry.relatedPurchaseIndex.value,
    }));
  const items = itemEntries.map((entry) => ({
    originalDescription: entry.description,
    normalizedDescription: nullField(),
    quantity: entry.quantity,
    unit: entry.unit,
    packaging: nullField(),
    unitPrice: entry.unitPrice,
    lineTotal: entry.amount,
    discount: entry.discount.value === null ? nullField() : entry.discount,
    tax: entry.tax.value === null ? nullField() : entry.tax,
    taxIncluded: entry.taxIncluded,
    suggestedCategory: entry.suggestedCategory,
  }));
  const normalized = validateReceiptExtractionV1({
    schemaVersion: 'receipt-extraction-v1',
    documentType: value.documentType, merchant: value.merchant, date: value.date, time: value.time,
    currency: value.currency, subtotal: value.subtotal, taxTotal: value.taxTotal, discountTotal: value.discountTotal,
    depositTotal: value.depositTotal, reportedArticleCount: value.reportedArticleCount, total: value.total,
    sourceText: value.sourceText, items, adjustments, warnings: value.warnings,
  });
  return {
    ...normalized,
    schemaVersion: 'receipt-extraction-v1.1',
    documentEntries: entries,
    ...(value.ocrEvidence === undefined ? {} : { ocrEvidence: validateOcrEvidence(value.ocrEvidence) }),
  };
}

function validateOcrEvidence(value: unknown): NonNullable<ReceiptExtractionV1['ocrEvidence']> {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== ['provider', 'model', 'lines'].sort().join('|') ||
      typeof value.provider !== 'string' || !value.provider.trim() || value.provider.length > 100 ||
      typeof value.model !== 'string' || !value.model.trim() || value.model.length > 160 ||
      !Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > 2000) {
    throw new Error('Receipt OCR evidence is invalid');
  }
  const ids = new Set<number>();
  const lines = value.lines.map((line: unknown) => {
    if (!isRecord(line) || Object.keys(line).sort().join('|') !== ['id', 'order', 'text', 'confidence', 'box'].sort().join('|') ||
        typeof line.id !== 'number' || !Number.isSafeInteger(line.id) || line.id < 0 || ids.has(line.id) || typeof line.order !== 'number' || !Number.isSafeInteger(line.order) || line.order < 0 ||
        typeof line.text !== 'string' || line.text.length > 10000 || !Array.isArray(line.box) || line.box.length < 4 || line.box.length > 16 ||
        line.box.some((coordinate: unknown) => typeof coordinate !== 'number' || !Number.isFinite(coordinate)) ||
        (line.confidence !== null && (typeof line.confidence !== 'number' || !Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 1))) {
      throw new Error('Receipt OCR evidence line is invalid');
    }
    ids.add(line.id);
    return line as NonNullable<ReceiptExtractionV1['ocrEvidence']>['lines'][number];
  });
  return { provider: value.provider, model: value.model, lines };
}

function validateDocumentEntry(value: unknown, index: number): ReceiptDocumentEntryV1_1 {
  if (!isRecord(value)) throw new Error(`Receipt document entry ${index + 1} is invalid`);
  const entryKeys = ['kind', 'description', 'amount', 'signedAmount', 'quantity', 'unit', 'unitPrice', 'discount', 'tax', 'taxIncluded', 'adjustmentKind', 'includedInTotal', 'includedInLineTotal', 'relatedPurchaseIndex', 'suggestedCategory'];
  assertKeys(value, Object.hasOwn(value, 'currency') ? [...entryKeys, 'currency'] : entryKeys, `Receipt document entry ${index + 1}`);
  validateField(value.kind, (item) => typeof item === 'string' && ['purchase', 'discount', 'adjustment', 'subtotal', 'final_total', 'payment'].includes(item), `entry ${index + 1} kind`);
  if (value.currency !== undefined) validateField(value.currency, (item) => typeof item === 'string' && /^[A-Z]{3}$/.test(item), `entry ${index + 1} currency`);
  for (const name of ['description', 'unit', 'suggestedCategory'] as const) validateField(value[name], isString, `entry ${index + 1} ${name}`);
  for (const name of ['amount', 'signedAmount', 'quantity', 'unitPrice', 'discount', 'tax'] as const) validateField(value[name], isDecimal, `entry ${index + 1} ${name}`);
  validateField(value.taxIncluded, (item) => typeof item === 'boolean', `entry ${index + 1} taxIncluded`);
  validateField(value.includedInTotal, (item) => typeof item === 'boolean', `entry ${index + 1} includedInTotal`);
  validateField(value.includedInLineTotal, (item) => typeof item === 'boolean', `entry ${index + 1} includedInLineTotal`);
  validateField(value.relatedPurchaseIndex, isNonnegativeInteger, `entry ${index + 1} relatedPurchaseIndex`);
  validateField(value.adjustmentKind, (item) => typeof item === 'string' && ['tax', 'discount', 'deposit', 'return', 'rounding', 'other'].includes(item), `entry ${index + 1} adjustmentKind`);
  return value as unknown as ReceiptDocumentEntryV1_1;
}

function validateReceiptExtractionV1(value: unknown): ReceiptExtractionV1 {
  if (!isRecord(value) || value.schemaVersion !== 'receipt-extraction-v1' || !Array.isArray(value.items) || !Array.isArray(value.adjustments) || !Array.isArray(value.warnings))
    throw new Error('Receipt extraction does not match receipt-extraction-v1');
  const result = {
    ...value,
    // Stored V1 extractions predate the optional article-count evidence.
    reportedArticleCount: value.reportedArticleCount ?? { value: null, confidence: null, uncertainty: null, sourceText: null },
  } as unknown as ReceiptExtractionV1;
  assertKeys(result as unknown as Record<string, unknown>, ['schemaVersion', 'documentType', 'merchant', 'date', 'time', 'currency', 'subtotal', 'taxTotal', 'discountTotal', 'depositTotal', 'reportedArticleCount', 'total', 'adjustments', 'sourceText', 'items', 'warnings'], 'Receipt extraction');
  validateField(result.documentType, (item) => typeof item === 'string' && ['receipt', 'invoice', 'other'].includes(item), 'documentType');
  validateField(result.merchant, isString, 'merchant');
  validateField(result.date, isDate, 'date');
  validateField(result.time, isString, 'time');
  validateField(result.currency, (item) => typeof item === 'string' && /^[A-Z]{3}$/.test(item), 'currency');
  for (const name of ['subtotal', 'taxTotal', 'discountTotal', 'depositTotal', 'total'] as const)
    validateField(result[name], isDecimal, name);
  validateField(result.reportedArticleCount, isNonnegativeInteger, 'reportedArticleCount');
  if (result.sourceText !== null && (typeof result.sourceText !== 'string' || result.sourceText.length > 30000)) throw new Error('Receipt source text is invalid');
  if (result.items.length > 1000) throw new Error('Receipt contains too many line items');
  for (const [index, item] of result.items.entries()) {
    if (!isRecord(item)) throw new Error(`Receipt item ${index + 1} is invalid`);
    assertKeys(item, ['originalDescription', 'normalizedDescription', 'quantity', 'unit', 'packaging', 'unitPrice', 'lineTotal', 'discount', 'tax', 'taxIncluded', 'suggestedCategory'], `Receipt item ${index + 1}`);
    for (const name of ['originalDescription', 'normalizedDescription', 'unit', 'packaging', 'suggestedCategory'] as const) validateField(item[name], isString, `item ${index + 1} ${name}`);
    for (const name of ['quantity', 'unitPrice', 'lineTotal', 'discount', 'tax'] as const) validateField(item[name], isDecimal, `item ${index + 1} ${name}`);
    validateField(item.taxIncluded, (entry) => typeof entry === 'boolean', `item ${index + 1} taxIncluded`);
  }
  for (const [index, adjustment] of result.adjustments.entries()) {
    if (!isRecord(adjustment) || typeof adjustment.label !== 'string' || !['tax', 'discount', 'deposit', 'return', 'rounding', 'other'].includes(adjustment.kind) || (adjustment.includedInTotal !== null && typeof adjustment.includedInTotal !== 'boolean')) throw new Error(`Receipt adjustment ${index + 1} is invalid`);
    const adjustmentKeys = ['label', 'amount', 'kind', 'includedInTotal'];
    if ('signedAmount' in adjustment) adjustmentKeys.push('signedAmount');
    if ('includedInLineTotal' in adjustment) adjustmentKeys.push('includedInLineTotal');
    if ('relatedPurchaseIndex' in adjustment) adjustmentKeys.push('relatedPurchaseIndex');
    assertKeys(adjustment, adjustmentKeys, `Receipt adjustment ${index + 1}`);
    if (adjustment.label.length > 160) throw new Error(`Receipt adjustment ${index + 1} label is too long`);
    if (adjustment.amount !== null) {
      if (typeof adjustment.amount !== 'string') throw new Error(`Receipt adjustment ${index + 1} amount is invalid`);
      const amount = financeDecimal(adjustment.amount);
      if (adjustment.kind !== 'rounding' && compareDecimal(amount, '0') < 0) throw new Error(`Receipt adjustment ${index + 1} amount must be nonnegative`);
    }
    if (adjustment.signedAmount !== undefined && adjustment.signedAmount !== null) financeDecimal(adjustment.signedAmount);
    if (adjustment.includedInLineTotal !== undefined && adjustment.includedInLineTotal !== null && typeof adjustment.includedInLineTotal !== 'boolean') throw new Error(`Receipt adjustment ${index + 1} line inclusion is invalid`);
    if (adjustment.relatedPurchaseIndex !== undefined && adjustment.relatedPurchaseIndex !== null && !isNonnegativeInteger(adjustment.relatedPurchaseIndex)) throw new Error(`Receipt adjustment ${index + 1} purchase reference is invalid`);
  }
  if (result.warnings.length > 200 || result.warnings.some((warning) => typeof warning !== 'string' || warning.length > 300)) throw new Error('Receipt warnings are invalid');
  return result;
}

export interface ReceiptReconciliation {
  matched: boolean | null;
  itemTotal: string | null;
  total: string | null;
  difference: string | null;
  adjustmentTotal: string | null;
  inconsistentLineCount: number;
  extractedLineCount: number;
  completeLineCount: number;
  incompleteLineCount: number;
  reportedArticleCount: number | null;
  articleCountMismatch: boolean | null;
  warnings: string[];
}

export function reconcileReceiptExtraction(value: ReceiptExtractionV1): ReceiptReconciliation {
  const warnings = [...value.warnings];
  const completeItems = value.items.filter((item) => item.lineTotal.value !== null);
  const completeLineCount = value.items.filter((item) => isCompleteReceiptItem(item)).length;
  const incompleteLineCount = value.items.length - completeLineCount;
  const reportedArticleCount = value.reportedArticleCount?.value ?? null;
  const articleCountMismatch = reportedArticleCount === null ? null : reportedArticleCount !== value.items.length;
  if (articleCountMismatch) warnings.push(`The receipt reports ${reportedArticleCount} purchased article(s), while ${value.items.length} line entry/entries were extracted. Receipt counts can include quantities; check that every printed line is represented.`);
  if (incompleteLineCount > 0) warnings.push(`${incompleteLineCount} extracted line item(s) have missing fields and need review.`);
  const itemTotal = completeItems.length === value.items.length && value.items.length
    ? completeItems.reduce((sum, item) => addDecimal(sum, item.lineTotal.value!), '0')
    : null;
  const inconsistentLineCount = value.items.filter((item) => hasInconsistentLineArithmetic(item, value.currency.value ?? 'EUR')).length;
  if (inconsistentLineCount) warnings.push(`${inconsistentLineCount} purchase line(s) do not agree with quantity, unit price, discount and tax.`);
  const total = value.total.value;
  if (value.items.some((item) => item.lineTotal.value === null)) warnings.push('Some line totals are unknown and need review.');
  if (total === null) warnings.push('Receipt total is unknown and must be entered before confirmation.');
  if (!value.currency.value) warnings.push('Receipt currency is unknown and must be selected before confirmation.');
  const scale = currencyMinorUnits(value.currency.value ?? 'EUR');
  let adjustmentTotal = '0';
  let unresolvedAdjustment = false;
  let adjustedItemTotal = itemTotal;
  if (adjustedItemTotal !== null) {
    for (const adjustment of value.adjustments) {
      if (adjustment.includedInTotal === null) {
        warnings.push(`Adjustment “${adjustment.label}” needs review to determine whether it affects the total.`);
        unresolvedAdjustment = true;
        continue;
      }
      if (adjustment.includedInTotal !== true) continue;
      if (adjustment.includedInLineTotal === true) continue;
      if (adjustment.includedInLineTotal === null) {
        warnings.push(`Adjustment “${adjustment.label}” needs review to determine whether it is already included in a purchase line.`);
        unresolvedAdjustment = true;
        continue;
      }
      if (value.schemaVersion === 'receipt-extraction-v1.1' && (adjustment.signedAmount === undefined || adjustment.signedAmount === null)) {
        warnings.push(`Adjustment “${adjustment.label}” has no signed effect and needs review.`);
        unresolvedAdjustment = true;
        continue;
      }
      if (adjustment.signedAmount !== undefined && adjustment.signedAmount !== null) {
        adjustmentTotal = addDecimal(adjustmentTotal, adjustment.signedAmount);
        adjustedItemTotal = addDecimal(adjustedItemTotal, adjustment.signedAmount);
        continue;
      }
      if (adjustment.amount === null) {
        warnings.push(`Adjustment “${adjustment.label}” has no amount and needs review.`);
        unresolvedAdjustment = true;
        continue;
      }
      if (adjustment.kind === 'other') {
        warnings.push(`Adjustment “${adjustment.label}” has an unknown effect on the total.`);
        unresolvedAdjustment = true;
        continue;
      }
      const amount = financeDecimal(adjustment.amount);
      const signed = adjustment.kind === 'discount' || adjustment.kind === 'return' ? `-${amount}` : amount;
      adjustmentTotal = addDecimal(adjustmentTotal, signed);
      adjustedItemTotal = addDecimal(adjustedItemTotal, signed);
    }
  }
  const roundedItems = adjustedItemTotal === null ? null : roundDecimal(adjustedItemTotal, scale);
  const roundedTotal = total === null ? null : roundDecimal(total, scale);
  if (roundedItems !== null && roundedTotal !== null && compareDecimal(roundedItems, roundedTotal) !== 0) warnings.push(`Item totals (${roundedItems}) do not match the printed receipt total (${roundedTotal}).`);
  return {
    matched: roundedItems === null || roundedTotal === null || incompleteLineCount > 0 || unresolvedAdjustment ? null : inconsistentLineCount > 0 ? false : compareDecimal(roundedItems, roundedTotal) === 0,
    itemTotal: roundedItems, total: roundedTotal, difference: roundedItems === null || roundedTotal === null ? null : addDecimal(roundedItems, `-${roundedTotal}`),
    adjustmentTotal: value.adjustments.some((item) => item.includedInTotal === true) ? roundDecimal(adjustmentTotal, scale) : null,
    inconsistentLineCount, extractedLineCount: value.items.length, completeLineCount, incompleteLineCount, reportedArticleCount, articleCountMismatch,
    warnings: [...new Set(warnings)],
  };
}

/** Recalculate the reviewed draft with the same exact rules used during extraction.
 * The client supplies edited fields; it never supplies a reconciliation result. */
export function reconcileReceiptReview(
  extraction: ReceiptExtractionV1,
  review: {
    amount: string;
    currency: string;
    items: Array<Pick<import('./personal-finance.types').ExpenseItem, 'description' | 'quantity' | 'unit' | 'unitPrice' | 'discount' | 'tax' | 'lineTotal' | 'taxIncluded'>>;
    adjustments: ReceiptAdjustment[];
  },
): ReceiptReconciliation {
  const field = <T>(value: T): ExtractedField<T> => ({ value, confidence: null, uncertainty: null, sourceText: null });
  const reviewed: ReceiptExtractionV1 = {
    ...extraction,
    currency: field(review.currency.toUpperCase()),
    total: field(review.amount),
    items: review.items.map((item) => ({
      originalDescription: field(item.description), normalizedDescription: nullField(),
      quantity: field(item.quantity), unit: field(item.unit), packaging: nullField(),
      unitPrice: field(item.unitPrice), lineTotal: field(item.lineTotal),
      discount: field(item.discount), tax: field(item.tax), taxIncluded: field(item.taxIncluded ?? false),
      suggestedCategory: nullField(),
    })),
    adjustments: review.adjustments,
  };
  return reconcileReceiptExtraction(reviewed);
}

function isCompleteReceiptItem(item: ReceiptExtractionV1['items'][number]): boolean {
  return !!item.originalDescription.value && !!item.quantity.value && !!item.unit.value &&
    item.unitPrice.value !== null && item.lineTotal.value !== null && item.discount.value !== null &&
    item.tax.value !== null && item.taxIncluded.value !== null;
}

function hasInconsistentLineArithmetic(item: ReceiptExtractionV1['items'][number], currency: string) {
  if (!isCompleteReceiptItem(item)) return false;
  try {
    return compareDecimal(expectedItemLineTotal({ quantity: item.quantity.value!, unitPrice: item.unitPrice.value!, discount: item.discount.value!, tax: item.tax.value!, taxIncluded: item.taxIncluded.value! }, currency), item.lineTotal.value!) !== 0;
  } catch { return true; }
}

function absoluteDecimal(value: string) {
  const normalized = financeDecimal(value);
  return normalized.startsWith('-') ? normalized.slice(1) : normalized;
}

function nullField<T>(): ExtractedField<T> { return { value: null, confidence: null, uncertainty: null, sourceText: null }; }

function validateField<T>(value: unknown, valid: (value: unknown) => boolean, label: string): asserts value is ExtractedField<T> {
  if (!isRecord(value)) throw new Error(`Receipt extraction field ${label} is malformed`);
  const keys = Object.keys(value).sort().join('|');
  if (keys !== [...fieldKeys].sort().join('|') && keys !== [...fieldKeys, 'sourceLineIds'].sort().join('|')) throw new Error(`Receipt extraction field ${label} is malformed`);
  if (value.value !== null && !valid(value.value)) throw new Error(`Receipt extraction field ${label} has an invalid value`);
  if (value.confidence !== null && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) throw new Error(`Receipt extraction field ${label} has invalid confidence`);
  if (value.uncertainty !== null && (typeof value.uncertainty !== 'string' || value.uncertainty.length > 500)) throw new Error(`Receipt extraction field ${label} has invalid uncertainty`);
  if (value.sourceText !== null && (typeof value.sourceText !== 'string' || value.sourceText.length > 500)) throw new Error(`Receipt extraction field ${label} has invalid source text`);
  if ('sourceLineIds' in value && (!Array.isArray(value.sourceLineIds) || value.sourceLineIds.length > 100 || value.sourceLineIds.some((id) => !Number.isSafeInteger(id) || id < 0))) throw new Error(`Receipt extraction field ${label} has invalid source line references`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function assertKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  if (actual.join('|') !== [...expected].sort().join('|')) throw new Error(`${label} contains missing or unexpected fields`);
}
function isString(value: unknown): value is string { return typeof value === 'string' && value.length <= 500; }
function isDecimal(value: unknown): value is string { if (typeof value !== 'string') return false; try { financeDecimal(value); return true; } catch { return false; } }
function isNonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isDate(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
