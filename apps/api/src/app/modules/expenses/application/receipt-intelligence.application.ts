import { createHash } from 'node:crypto';
import { assertNewExpenseCurrency, normalizeCurrency, validateDraftProposal, validateExpenseItem } from '../domain/expense-rules';
import { compareDecimal, financeDecimal } from '../domain/decimal';
import { reconcileReceiptExtraction, validateReceiptExtraction } from '../domain/receipt-extraction';
import type { ExpenseDraftProposal, ExpenseRecord, FinanceActorContext, ReceiptMetadata } from '../domain/personal-finance.types';
import type { DocumentUnderstandingPort } from './ports/document-understanding.port';
import type { PersonalFinanceRepository } from './ports/personal-finance.repository';
import type { PrivateReceiptStoragePort } from './ports/private-receipt-storage.port';

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export class ReceiptIntelligenceApplication {
  constructor(
    private readonly repository: PersonalFinanceRepository,
    private readonly understanding: DocumentUnderstandingPort,
    private readonly storage: PrivateReceiptStoragePort,
  ) {}

  async extract(context: FinanceActorContext, bytes: Uint8Array, mediaType: string, cloudDataConsent: boolean) {
    requireContext(context);
    if (cloudDataConsent !== true) throw new Error('Explicit consent is required before cloud receipt extraction');
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error('Receipt image must be 1 byte to 10 MB');
    const verifiedType = detectImageType(bytes);
    if (verifiedType !== mediaType) throw new Error('Receipt image content does not match its declared media type');
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const duplicate = await this.repository.findReceiptByHash(context.accountId, contentHash);
    if (duplicate) {
      let draft = duplicate.draftId ? await this.repository.getDraft(context.accountId, duplicate.draftId) : null;
      if (draft?.status === 'rejected' && !duplicate.expenseId) draft = await this.repository.reopenRejectedReceiptDraft(context.accountId, context.actorId, duplicate.id);
      return { duplicate: true, receipt: duplicate, draft, possibleMatches: [] as ExpenseRecord[] };
    }

    const result = await this.understanding.extract({ bytes, mediaType: verifiedType }, { cloudDataConsent });
    const extraction = validateReceiptExtraction(result.extraction);
    const reconciliation = reconcileReceiptExtraction(extraction);
    const currency = extraction.currency.value ? normalizeCurrency(extraction.currency.value) : null;
    const amount = extraction.total.value;
    if (currency && amount) assertNewExpenseCurrency(currency);
    const storageKey = await this.storage.put(context.accountId, verifiedType, bytes);
    const metadata: Omit<ReceiptMetadata, 'id' | 'accountId' | 'draftId' | 'expenseId' | 'createdAt'> = {
      contentHash, mediaType: verifiedType, byteLength: bytes.byteLength, storageKey,
      status: 'review_required',
      extractedTotals: { subtotal: extraction.subtotal.value, tax: extraction.taxTotal.value, discount: extraction.discountTotal.value, total: amount, currency },
      parserProvider: result.provider, parserModel: result.model, extraction,
    };
    const sourceId = `receipt:sha256:${contentHash}`;
    const proposal: ExpenseDraftProposal = validateDraftProposal({
      date: extraction.date.value, amount, currency, merchantName: extraction.merchant.value,
      category: null, description: extraction.merchant.value, tags: [],
      items: toCompleteItems(extraction, currency ?? 'EUR', contentHash), receipts: [metadata],
      sourceKind: 'receipt', sourceId, extractionProvider: result.provider, extractionModel: result.model,
    });
    try {
      const draft = await this.repository.createDraft(context.accountId, context.actorId, proposal);
      const receipt = draft.receipts.find((item) => item.contentHash === contentHash);
      if (!receipt || receipt.storageKey !== storageKey) {
        await this.storage.delete(context.accountId, storageKey);
        return { duplicate: true, receipt: receipt ?? duplicate, draft, possibleMatches: [] as ExpenseRecord[] };
      }
      const possibleMatches = await this.findPossibleMatches(context.accountId, extraction);
      return { duplicate: false, draft, possibleMatches, reconciliation };
    } catch (error) {
      await this.storage.delete(context.accountId, storageKey).catch(() => undefined);
      throw error;
    }
  }

  async getImage(context: FinanceActorContext, receiptId: string) {
    requireContext(context);
    const receipt = await this.repository.getReceipt(context.accountId, receiptId);
    if (!receipt || receipt.documentDeletedAt) return null;
    return { receipt, bytes: await this.storage.get(context.accountId, receipt.storageKey) };
  }

  async deleteImage(context: FinanceActorContext, receiptId: string) {
    requireContext(context);
    const receipt = await this.repository.markReceiptDocumentDeleted(context.accountId, context.actorId, receiptId);
    if (!receipt) return null;
    await this.storage.delete(context.accountId, receipt.storageKey);
    return receipt;
  }

  async attachToExpense(context: FinanceActorContext, receiptId: string, expenseId: string) {
    requireContext(context);
    return this.repository.attachReceiptToExpense(context.accountId, context.actorId, receiptId, expenseId);
  }

  async reviewDraft(context: FinanceActorContext, draftId: string, input: import('./ports/personal-finance.repository').ExpenseDraftReviewWrite) {
    requireContext(context);
    const normalized = {
      ...input,
      date: input.date ? normalizeReviewDate(input.date) : null,
      amount: input.amount ? financeDecimal(input.amount) : null,
      currency: input.currency ? normalizeCurrency(input.currency) : null,
      merchantName: input.merchantName?.trim().slice(0, 180) || null,
      category: input.category?.trim().slice(0, 80) || null,
      description: input.description?.trim().slice(0, 500) || null,
      items: input.items.map((item) => validateExpenseItem(item)),
      itemizationReviewed: input.itemizationReviewed === true,
      totalOnly: input.totalOnly === true,
      adjustments: input.adjustments.map((adjustment) => {
        if (!adjustment || typeof adjustment.label !== 'string' || !['tax', 'discount', 'deposit', 'return', 'rounding', 'other'].includes(adjustment.kind)) throw new Error('Receipt adjustment is invalid');
        const amount = adjustment.amount === null ? null : financeDecimal(adjustment.amount);
        if (amount !== null && adjustment.kind !== 'rounding' && compareDecimal(amount, '0') < 0) throw new Error('Receipt adjustment amounts must be nonnegative');
        return { ...adjustment, label: adjustment.label.trim().slice(0, 160), amount };
      }),
    };
    if (!normalized.itemizationReviewed) throw new Error('Review the extracted itemization before continuing');
    if (normalized.totalOnly && normalized.items.length > 0) throw new Error('Total-only review cannot include item lines');
    if (!normalized.totalOnly && normalized.items.length === 0) throw new Error('Choose total-only explicitly when saving a receipt without item lines');
    if (normalized.currency) assertNewExpenseCurrency(normalized.currency);
    return this.repository.updateDraft(context.accountId, context.actorId, draftId, normalized);
  }

  private async findPossibleMatches(accountId: string, extraction: ReturnType<typeof validateReceiptExtraction>) {
    const { value: date } = extraction.date;
    const { value: amount } = extraction.total;
    const { value: currency } = extraction.currency;
    if (!date || !amount || !currency) return [];
    return this.repository.findPossibleReceiptMatches(accountId, date, amount, currency, extraction.merchant.value);
  }
}

function toCompleteItems(extraction: ReturnType<typeof validateReceiptExtraction>, currency: string, contentHash: string) {
  if (!extraction.currency.value || extraction.currency.value.toUpperCase() !== currency.toUpperCase()) return [];
  const mapped = [];
  for (const item of extraction.items) {
    const description = item.originalDescription.value;
    const quantity = item.quantity.value;
    const unit = item.unit.value;
    const unitPrice = item.unitPrice.value;
    const lineTotal = item.lineTotal.value;
    const discount = item.discount.value;
    const tax = item.tax.value;
    const taxIncluded = item.taxIncluded.value;
    if (!description || !quantity || !unit || unitPrice === null || lineTotal === null || discount === null || tax === null || taxIncluded === null) continue;
    try {
      mapped.push(validateExpenseItem({
        description, productCode: null, quantity, unit, unitPrice, discount, tax, taxIncluded,
        lineTotal, currency, sourceReceiptId: null,
        normalizedDescription: item.normalizedDescription.value,
        packaging: item.packaging.value,
        extractionProvenance: { provider: 'openai', schemaVersion: 'receipt-extraction-v1', sourceContentHash: contentHash, confidence: item },
      }));
    } catch { /* Keep extracted values in receipt provenance; never bend them to fit finance rules. */ }
  }
  return mapped;
}

function normalizeReviewDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('Date must be a valid ISO calendar date');
  return value;
}

function detectImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10') return 'image/png';
  throw new Error('Receipt must be a valid JPEG or PNG image');
}

function requireContext(context: FinanceActorContext) {
  if (!context || !context.accountId?.trim() || !context.actorId?.trim() || context.accountId !== context.actorId) throw new Error('A verified finance account context is required');
}
