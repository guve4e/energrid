import { addDecimal, compareDecimal, financeDecimal, roundDecimal } from './decimal';
import { currencyMinorUnits } from './expense-rules';
import type { ExtractedField, ReceiptExtractionV1 } from './receipt-extraction.types';

const fieldKeys = ['value', 'confidence', 'uncertainty', 'sourceText'];

export function validateReceiptExtraction(value: unknown): ReceiptExtractionV1 {
  if (!isRecord(value) || value.schemaVersion !== 'receipt-extraction-v1' || !Array.isArray(value.items) || !Array.isArray(value.adjustments) || !Array.isArray(value.warnings))
    throw new Error('Receipt extraction does not match receipt-extraction-v1');
  assertKeys(value, ['schemaVersion', 'documentType', 'merchant', 'date', 'time', 'currency', 'subtotal', 'taxTotal', 'discountTotal', 'depositTotal', 'total', 'adjustments', 'sourceText', 'items', 'warnings'], 'Receipt extraction');
  const result = value as unknown as ReceiptExtractionV1;
  validateField(result.documentType, (item) => typeof item === 'string' && ['receipt', 'invoice', 'other'].includes(item), 'documentType');
  validateField(result.merchant, isString, 'merchant');
  validateField(result.date, isDate, 'date');
  validateField(result.time, isString, 'time');
  validateField(result.currency, (item) => typeof item === 'string' && /^[A-Z]{3}$/.test(item), 'currency');
  for (const name of ['subtotal', 'taxTotal', 'discountTotal', 'depositTotal', 'total'] as const)
    validateField(result[name], isDecimal, name);
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
    assertKeys(adjustment, ['label', 'amount', 'kind', 'includedInTotal'], `Receipt adjustment ${index + 1}`);
    if (adjustment.label.length > 160) throw new Error(`Receipt adjustment ${index + 1} label is too long`);
    if (adjustment.amount !== null) {
      if (typeof adjustment.amount !== 'string') throw new Error(`Receipt adjustment ${index + 1} amount is invalid`);
      const amount = financeDecimal(adjustment.amount);
      if (adjustment.kind !== 'rounding' && compareDecimal(amount, '0') < 0) throw new Error(`Receipt adjustment ${index + 1} amount must be nonnegative`);
    }
  }
  if (result.warnings.length > 200 || result.warnings.some((warning) => typeof warning !== 'string' || warning.length > 300)) throw new Error('Receipt warnings are invalid');
  return result;
}

export function reconcileReceiptExtraction(value: ReceiptExtractionV1): { matched: boolean | null; itemTotal: string | null; total: string | null; difference: string | null; warnings: string[] } {
  const warnings = [...value.warnings];
  const completeItems = value.items.filter((item) => item.lineTotal.value !== null);
  const itemTotal = completeItems.length === value.items.length && value.items.length
    ? completeItems.reduce((sum, item) => addDecimal(sum, item.lineTotal.value!), '0')
    : null;
  const total = value.total.value;
  if (value.items.some((item) => item.lineTotal.value === null)) warnings.push('Some line totals are unknown and need review.');
  if (total === null) warnings.push('Receipt total is unknown and must be entered before confirmation.');
  if (!value.currency.value) warnings.push('Receipt currency is unknown and must be selected before confirmation.');
  const scale = currencyMinorUnits(value.currency.value ?? 'EUR');
  let adjustedItemTotal = itemTotal;
  if (adjustedItemTotal !== null) {
    for (const adjustment of value.adjustments) {
      if (adjustment.includedInTotal === null) {
        warnings.push(`Adjustment “${adjustment.label}” needs review to determine whether it affects the total.`);
        continue;
      }
      if (adjustment.includedInTotal !== true) continue;
      if (adjustment.amount === null) {
        warnings.push(`Adjustment “${adjustment.label}” has no amount and needs review.`);
        continue;
      }
      if (adjustment.kind === 'other') {
        warnings.push(`Adjustment “${adjustment.label}” has an unknown effect on the total.`);
        continue;
      }
      const amount = financeDecimal(adjustment.amount);
      adjustedItemTotal = addDecimal(adjustedItemTotal, adjustment.kind === 'discount' || adjustment.kind === 'return' ? `-${amount}` : amount);
    }
  }
  const roundedItems = adjustedItemTotal === null ? null : roundDecimal(adjustedItemTotal, scale);
  const roundedTotal = total === null ? null : roundDecimal(total, scale);
  if (roundedItems !== null && roundedTotal !== null && compareDecimal(roundedItems, roundedTotal) !== 0) warnings.push(`Item totals (${roundedItems}) do not match the printed receipt total (${roundedTotal}).`);
  return {
    matched: roundedItems === null || roundedTotal === null ? null : compareDecimal(roundedItems, roundedTotal) === 0,
    itemTotal: roundedItems, total: roundedTotal, difference: roundedItems === null || roundedTotal === null ? null : addDecimal(roundedItems, `-${roundedTotal}`), warnings: [...new Set(warnings)],
  };
}

function validateField<T>(value: unknown, valid: (value: unknown) => boolean, label: string): asserts value is ExtractedField<T> {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== [...fieldKeys].sort().join('|')) throw new Error(`Receipt extraction field ${label} is malformed`);
  if (value.value !== null && !valid(value.value)) throw new Error(`Receipt extraction field ${label} has an invalid value`);
  if (value.confidence !== null && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) throw new Error(`Receipt extraction field ${label} has invalid confidence`);
  if (value.uncertainty !== null && (typeof value.uncertainty !== 'string' || value.uncertainty.length > 500)) throw new Error(`Receipt extraction field ${label} has invalid uncertainty`);
  if (value.sourceText !== null && (typeof value.sourceText !== 'string' || value.sourceText.length > 500)) throw new Error(`Receipt extraction field ${label} has invalid source text`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function assertKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  if (actual.join('|') !== [...expected].sort().join('|')) throw new Error(`${label} contains missing or unexpected fields`);
}
function isString(value: unknown): value is string { return typeof value === 'string' && value.length <= 500; }
function isDecimal(value: unknown): value is string { if (typeof value !== 'string') return false; try { financeDecimal(value); return true; } catch { return false; } }
function isDate(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
