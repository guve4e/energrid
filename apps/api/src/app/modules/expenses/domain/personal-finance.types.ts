export type CurrencyCode = string;
export type ExpenseSourceKind = 'manual' | 'assistant-text' | 'receipt' | 'legacy-mongo' | 'legacy-leveldb' | 'bank';
export type ExpenseDraftStatus = 'proposed' | 'needs_review' | 'confirmed' | 'rejected';
export type ReceiptStatus = 'attached' | 'processing' | 'review_required' | 'reconciled' | 'failed';

/** Account-owned category. The id is stable; the name is display text. */
export interface FinanceCategory {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  parentId: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface FinanceActorContext {
  /** Supplied by the host application's verified authentication adapter. */
  accountId: string;
  actorId: string;
}

export interface FxProvenance {
  rate: string;
  /** Source-currency units per one EUR. */
  convention: 'currency_units_per_eur';
  source: string;
  effectiveAt: string | null;
  provider: string | null;
}

export interface ExpenseItem {
  id?: string;
  description: string;
  productCode: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  discount: string;
  tax: string;
  lineTotal: string;
  currency: CurrencyCode;
  sourceReceiptId?: string | null;
  normalizedDescription?: string | null;
  packaging?: string | null;
  taxIncluded?: boolean;
  categoryId?: string | null;
  extractionProvenance?: Record<string, unknown> | null;
}

export interface ReceiptMetadata {
  id: string;
  accountId: string;
  draftId: string | null;
  expenseId: string | null;
  contentHash: string;
  mediaType: string;
  byteLength: number;
  storageKey: string;
  status: ReceiptStatus;
  extractedTotals: {
    subtotal: string | null;
    tax: string | null;
    discount: string | null;
    total: string | null;
    currency: CurrencyCode | null;
  } | null;
  parserProvider: string | null;
  parserModel: string | null;
  extraction?: import('./receipt-extraction.types').ReceiptExtractionV1 | null;
  userReviewedAt?: string | null;
  reviewedAsTotalOnly?: boolean;
  reviewedTotal?: string | null;
  reviewedCurrency?: CurrencyCode | null;
  documentDeletedAt?: string | null;
  reviewedAdjustments?: import('./receipt-extraction.types').ReceiptExtractionV1['adjustments'] | null;
  createdAt: string;
}

export interface ExpenseRecord {
  id: string;
  accountId: string;
  date: string;
  amount: string;
  currency: CurrencyCode;
  amountEur: string | null;
  fx: FxProvenance | null;
  merchantId: string | null;
  merchantName: string | null;
  category: string;
  categoryId?: string | null;
  description: string;
  tags: string[];
  items: ExpenseItem[];
  liters: string | null;
  sourceKind: ExpenseSourceKind;
  sourceId: string | null;
  legacyRecordId?: string;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedBy: string;
  confirmedAt: string;
  /** Only used while exposing untouched LevelDB records during migration. */
  legacyReadOnly?: true;
}

export interface ExpenseDraftProposal {
  date: string | null;
  amount: string | null;
  currency: CurrencyCode | null;
  merchantName: string | null;
  category: string | null;
  description: string | null;
  tags: string[];
  items: Omit<ExpenseItem, 'id'>[];
  receipts: Omit<ReceiptMetadata, 'id' | 'accountId' | 'draftId' | 'expenseId' | 'createdAt'>[];
  sourceKind: ExpenseSourceKind;
  sourceId: string | null;
  extractionProvider: string | null;
  extractionModel: string | null;
}

export interface ExpenseDraft extends Omit<ExpenseDraftProposal, 'receipts'> {
  receipts: ReceiptMetadata[];
  id: string;
  accountId: string;
  status: ExpenseDraftStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseSource {
  kind: ExpenseSourceKind;
  id: string | null;
  provider?: string | null;
  model?: string | null;
  contentHash?: string | null;
}

export interface ExpenseQuery {
  fromDate?: string;
  toDate?: string;
  category?: string;
  categoryId?: string;
  merchantId?: string;
  text?: string;
  limit?: number;
  before?: string;
}

export interface SpendingSummary {
  currency: 'EUR';
  total: string;
  transactionCount: number;
  excludedUnconvertedCount: number;
  byMonth: Array<{ month: string; total: string; count: number }>;
  byCategory: Array<{ categoryId: string | null; category: string; total: string; count: number }>;
  byMerchant: Array<{ merchantId: string | null; merchant: string; total: string; count: number }>;
  byProduct: Array<{ product: string; currency: CurrencyCode; unit: string; total: string; quantity: string; lineCount: number }>;
  fromDate: string | null;
  toDate: string | null;
}

export interface ExpenseConfirmation {
  expenseId: string;
  accountId: string;
  confirmedBy: string;
  confirmedAt: string;
  source: ExpenseSource;
}
