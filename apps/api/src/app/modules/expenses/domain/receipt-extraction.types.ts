export interface ExtractedField<T> {
  value: T | null;
  confidence: number | null;
  uncertainty: string | null;
  sourceText: string | null;
  /** Optional line identities from a local or provider-specific OCR evidence set. */
  sourceLineIds?: number[];
}

export interface ReceiptExtractionItem {
  originalDescription: ExtractedField<string>;
  normalizedDescription: ExtractedField<string>;
  quantity: ExtractedField<string>;
  unit: ExtractedField<string>;
  packaging: ExtractedField<string>;
  unitPrice: ExtractedField<string>;
  lineTotal: ExtractedField<string>;
  discount: ExtractedField<string>;
  tax: ExtractedField<string>;
  taxIncluded: ExtractedField<boolean>;
  suggestedCategory: ExtractedField<string>;
}

export type ReceiptDocumentEntryKind = 'purchase' | 'discount' | 'adjustment' | 'subtotal' | 'final_total' | 'payment';
export type ReceiptAdjustmentKind = 'tax' | 'discount' | 'deposit' | 'return' | 'rounding' | 'other';

/** A typed transcription of one printed document row. Non-purchase rows remain
 * in provenance so totals, tender and summaries cannot be mistaken for goods. */
export interface ReceiptDocumentEntryV1_1 {
  kind: ExtractedField<ReceiptDocumentEntryKind>;
  /** Optional per-entry currency for documents whose rows explicitly use more than one currency. */
  currency?: ExtractedField<string>;
  description: ExtractedField<string>;
  amount: ExtractedField<string>;
  signedAmount: ExtractedField<string>;
  quantity: ExtractedField<string>;
  unit: ExtractedField<string>;
  unitPrice: ExtractedField<string>;
  discount: ExtractedField<string>;
  tax: ExtractedField<string>;
  taxIncluded: ExtractedField<boolean>;
  adjustmentKind: ExtractedField<ReceiptAdjustmentKind>;
  includedInTotal: ExtractedField<boolean>;
  includedInLineTotal: ExtractedField<boolean>;
  relatedPurchaseIndex: ExtractedField<number>;
  suggestedCategory: ExtractedField<string>;
}

export interface ReceiptAdjustment {
  label: string;
  amount: string | null;
  kind: ReceiptAdjustmentKind;
  includedInTotal: boolean | null;
  /** Signed effect on the transaction total; V1 records infer sign from kind. */
  signedAmount?: string | null;
  /** True when already reflected in a purchase line's final line total. */
  includedInLineTotal?: boolean | null;
  relatedPurchaseIndex?: number | null;
}

export interface ReceiptExtractionV1 {
  schemaVersion: 'receipt-extraction-v1' | 'receipt-extraction-v1.1';
  documentType: ExtractedField<'receipt' | 'invoice' | 'other'>;
  merchant: ExtractedField<string>;
  date: ExtractedField<string>;
  time: ExtractedField<string>;
  currency: ExtractedField<string>;
  subtotal: ExtractedField<string>;
  taxTotal: ExtractedField<string>;
  discountTotal: ExtractedField<string>;
  depositTotal: ExtractedField<string>;
  total: ExtractedField<string>;
  /** Count printed on some receipts (for example, “13 articles”). This counts
   * purchased units and may differ from the number of printed line entries. */
  reportedArticleCount: ExtractedField<number>;
  adjustments: ReceiptAdjustment[];
  sourceText: string | null;
  items: ReceiptExtractionItem[];
  /** Available for V1.1. Keeps every printed row, including excluded summaries and tender. */
  documentEntries?: ReceiptDocumentEntryV1_1[];
  /** Immutable local OCR observations associated with sourceLineIds. */
  ocrEvidence?: {
    provider: string;
    model: string;
    lines: Array<{ id: number; order: number; text: string; confidence: number | null; box: number[] }>;
  };
  warnings: string[];
}
