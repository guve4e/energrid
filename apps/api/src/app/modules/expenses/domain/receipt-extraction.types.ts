export interface ExtractedField<T> {
  value: T | null;
  confidence: number | null;
  uncertainty: string | null;
  sourceText: string | null;
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

export interface ReceiptExtractionV1 {
  schemaVersion: 'receipt-extraction-v1';
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
  adjustments: Array<{ label: string; amount: string | null; kind: 'tax' | 'discount' | 'deposit' | 'return' | 'rounding' | 'other'; includedInTotal: boolean | null }>;
  sourceText: string | null;
  items: ReceiptExtractionItem[];
  warnings: string[];
}
