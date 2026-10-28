import { addDecimal, compareDecimal, convertToEur, decimalString, financeDecimal, multiplyDecimal, roundDecimal } from './decimal';
import type { ExpenseDraftProposal, ExpenseItem, FxProvenance } from './personal-finance.types';

const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyMinorUnits(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency.toUpperCase())) return 3;
  return 2;
}

export function normalizeCurrency(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Currency is required');
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter code');
  return currency;
}

export function assertNewExpenseCurrency(value: unknown): 'EUR' | 'USD' {
  const currency = normalizeCurrency(value);
  if (currency !== 'EUR' && currency !== 'USD') {
    throw new Error('New expenses must use EUR or USD');
  }
  return currency;
}

export function euroValue(
  amount: string,
  currency: string,
  importedAmountEur?: string | null,
  fx?: FxProvenance | null,
): { amountEur: string | null; fx: FxProvenance | null } {
  if (importedAmountEur !== null && importedAmountEur !== undefined) {
    return { amountEur: decimalString(importedAmountEur), fx: fx ?? null };
  }
  if (currency === 'EUR') return { amountEur: decimalString(amount), fx: null };
  if (!fx) return { amountEur: null, fx: null };
  return {
    amountEur: convertToEur(amount, fx.rate),
    fx: { ...fx, rate: decimalString(fx.rate), convention: 'currency_units_per_eur' },
  };
}

export function normalizeMerchantName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 180);
}

export function validateDraftProposal(value: ExpenseDraftProposal): ExpenseDraftProposal {
  if (!value || typeof value !== 'object' || !Array.isArray(value.tags) || !Array.isArray(value.items) || !Array.isArray(value.receipts))
    throw new Error('Expense proposal is malformed');
  const sourceKinds = ['manual', 'assistant-text', 'receipt', 'legacy-mongo', 'legacy-leveldb', 'bank'];
  if (!sourceKinds.includes(value.sourceKind)) throw new Error('Expense proposal source is invalid');
  if (value.date !== null && typeof value.date !== 'string') throw new Error('Expense proposal date is invalid');
  if (value.amount !== null && typeof value.amount !== 'string') throw new Error('Expense proposal amount is invalid');
  if (value.currency !== null && typeof value.currency !== 'string') throw new Error('Expense proposal currency is invalid');
  if (value.merchantName !== null && typeof value.merchantName !== 'string') throw new Error('Expense proposal merchant is invalid');
  if (value.category !== null && typeof value.category !== 'string') throw new Error('Expense proposal category is invalid');
  if (value.description !== null && typeof value.description !== 'string') throw new Error('Expense proposal description is invalid');
  const currency = value.currency ? normalizeCurrency(value.currency) : null;
  if (currency && currency !== 'EUR' && currency !== 'USD' && value.sourceKind !== 'legacy-mongo' && value.sourceKind !== 'legacy-leveldb') {
    throw new Error('New expenses must use EUR or USD');
  }
  return {
    ...value,
    date: value.date ? normalizeDate(value.date) : null,
    amount: value.amount === null ? null : positiveDecimal(value.amount, 'amount'),
    currency,
    merchantName: value.merchantName ? normalizeMerchantName(value.merchantName) : null,
    category: value.category?.trim().slice(0, 80) || null,
    description: value.description?.trim().slice(0, 500) || null,
    tags: value.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim().slice(0, 60)).filter(Boolean).slice(0, 30),
    items: value.items.map((item) => validateExpenseItem(item)),
    receipts: value.receipts.map(validateReceiptMetadataInput),
  };
}

function validateReceiptMetadataInput(receipt: ExpenseDraftProposal['receipts'][number]): ExpenseDraftProposal['receipts'][number] {
  if (!receipt || typeof receipt !== 'object') throw new Error('Receipt metadata is malformed');
  if (typeof receipt.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(receipt.contentHash)) throw new Error('Receipt content hash must be a SHA-256 digest');
  if (!['image/jpeg', 'image/png', 'image/heic', 'application/pdf'].includes(receipt.mediaType)) throw new Error('Receipt media type is unsupported');
  if (!Number.isInteger(receipt.byteLength) || receipt.byteLength < 1 || receipt.byteLength > 10 * 1024 * 1024) throw new Error('Receipt size must be 1 byte to 10 MB');
  if (typeof receipt.storageKey !== 'string' || !receipt.storageKey.trim() || receipt.storageKey.length > 500) throw new Error('Receipt storage key is invalid');
  if (!['attached', 'processing', 'review_required', 'reconciled', 'failed'].includes(receipt.status)) throw new Error('Receipt status is invalid');
  const totals = receipt.extractedTotals;
  const extractedTotals = totals === null ? null : {
    subtotal: totals.subtotal === null ? null : financeDecimal(totals.subtotal),
    tax: totals.tax === null ? null : financeDecimal(totals.tax),
    discount: totals.discount === null ? null : financeDecimal(totals.discount),
    total: totals.total === null ? null : financeDecimal(totals.total),
    currency: totals.currency === null ? null : normalizeCurrency(totals.currency),
  };
  return {
    ...receipt, contentHash: receipt.contentHash.toLowerCase(), storageKey: receipt.storageKey.trim(), extractedTotals,
    parserProvider: receipt.parserProvider?.trim().slice(0, 100) || null,
    parserModel: receipt.parserModel?.trim().slice(0, 160) || null,
  };
}

export function validateExpenseItem<T extends Omit<ExpenseItem, 'id'>>(item: T): T {
  if (!item || typeof item !== 'object' || typeof item.description !== 'string') throw new Error('Expense item is malformed');
  const quantity = positiveDecimal(item.quantity, 'item quantity');
  const unitPrice = financeDecimal(item.unitPrice);
  const discount = financeDecimal(item.discount);
  const tax = financeDecimal(item.tax);
  const lineTotal = financeDecimal(item.lineTotal);
  if (compareDecimal(discount, '0') < 0 || compareDecimal(tax, '0') < 0 || compareDecimal(lineTotal, '0') < 0)
    throw new Error('Item discount, tax, and line total cannot be negative');
  const currency = normalizeCurrency(item.currency);
  const normalized = {
    ...item,
    description: item.description.trim().slice(0, 240),
    productCode: item.productCode?.trim().slice(0, 100) || null,
    quantity,
    unit: item.unit.trim().slice(0, 40) || 'unit',
    unitPrice,
    discount,
    tax,
    lineTotal,
    currency,
    taxIncluded: item.taxIncluded ?? false,
  };
  const expected = expectedItemLineTotal(normalized, currency);
  if (compareDecimal(lineTotal, expected) !== 0) throw new Error(`Expense item line total must equal ${expected} ${currency}`);
  return normalized;
}

export function reconcileItemsAgainstTotal(
  items: readonly Pick<ExpenseItem, 'lineTotal' | 'currency'>[],
  receiptTotal: string,
  currency: string,
): { matched: boolean; calculatedTotal: string; receiptTotal: string; difference: string } {
  const normalizedCurrency = normalizeCurrency(currency);
  if (items.some((item) => normalizeCurrency(item.currency) !== normalizedCurrency))
    throw new Error('All receipt items must use the receipt currency');
  const scale = currencyMinorUnits(normalizedCurrency);
  const calculatedTotal = roundDecimal(items.reduce((sum, item) => addDecimal(sum, item.lineTotal), '0'), scale);
  const normalizedReceiptTotal = roundDecimal(receiptTotal, scale);
  const difference = addDecimal(calculatedTotal, `-${normalizedReceiptTotal}`);
  return { matched: compareDecimal(calculatedTotal, normalizedReceiptTotal) === 0, calculatedTotal, receiptTotal: normalizedReceiptTotal, difference };
}

export function expectedItemLineTotal(item: Pick<ExpenseItem, 'quantity' | 'unitPrice' | 'discount' | 'tax'> & { taxIncluded?: boolean }, currency: string): string {
  const preTax = addDecimal(multiplyDecimal(item.quantity, item.unitPrice), `-${item.discount}`);
  const withTax = item.taxIncluded ? preTax : addDecimal(preTax, item.tax);
  if (compareDecimal(withTax, '0') < 0) throw new Error('Item total cannot be negative');
  return roundDecimal(withTax, currencyMinorUnits(currency));
}

function positiveDecimal(value: string, label: string): string {
  const normalized = financeDecimal(value);
  if (compareDecimal(normalized, '0') <= 0) throw new Error(`${label} must be greater than zero`);
  return normalized;
}

function normalizeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw new Error('Date must be a valid ISO calendar date');
  const date = new Date(`${value}T00:00:00Z`);
  if (date.toISOString().slice(0, 10) !== value) throw new Error('Date must be a valid ISO calendar date');
  return value;
}
