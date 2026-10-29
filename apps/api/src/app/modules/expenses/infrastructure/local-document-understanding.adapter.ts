import type { DocumentUnderstandingPort, DocumentUnderstandingResult } from '../application/ports/document-understanding.port';
import type { ExtractedField, ReceiptAdjustmentKind, ReceiptDocumentEntryV1_1, ReceiptExtractionV1 } from '../domain/receipt-extraction.types';
import { validateReceiptExtraction } from '../domain/receipt-extraction';

/** OCR evidence is immutable input to interpretation; provider/runtime details stay outside Finance. */
export interface LocalReceiptOcrPort {
  recognize(image: { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' }): Promise<{
    provider: string;
    model: string;
    lines: LocalOcrLine[];
  }>;
}

export interface LocalOcrLine { id: number; order: number; text: string; confidence: number | null; box: number[] }

export interface LocalReceiptInterpretationPort {
  interpret(input: {
    lines: ReadonlyArray<{ id: number; order: number; text: string; confidence: number | null; box: readonly number[] }>;
    categories: readonly string[];
    cloudDataConsent: boolean;
  }): Promise<{ provider?: string; model: string; proposal: unknown; inferenceMs: number }>;
}

/**
 * Composes local OCR with a replaceable text-only document interpreter.
 * Provider and runtime details remain outside Finance Core.
 */
export class LocalDocumentUnderstandingAdapter implements DocumentUnderstandingPort {
  constructor(
    private readonly ocr: LocalReceiptOcrPort,
    private readonly interpreter: LocalReceiptInterpretationPort,
  ) {}

  async extract(
    image: { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' },
    options: { cloudDataConsent: boolean; categories?: readonly string[] },
  ): Promise<DocumentUnderstandingResult> {
    if (!image.bytes.byteLength) throw new Error('Receipt image is empty');
    const evidence = await this.ocr.recognize(image);
    assertEvidence(evidence.lines);
    const interpreted = await this.interpreter.interpret({ lines: evidence.lines, categories: options.categories ?? [], cloudDataConsent: options.cloudDataConsent });
    const extraction = {
      ...mapLocalProposal(interpreted.proposal, evidence.lines),
      ocrEvidence: { provider: evidence.provider, model: evidence.model, lines: evidence.lines },
    };
    return {
      extraction: validateReceiptExtraction(extraction),
      provider: `local:${evidence.provider}${interpreted.provider ? `+${interpreted.provider}` : ''}`,
      model: interpreted.model,
      diagnostics: { responseStatus: `ocr:${evidence.model};interpretation:${Math.max(0, interpreted.inferenceMs)}ms` },
    };
  }
}

type ProposalField<T> = { value: T | null; sourceLineIds: number[]; uncertainty: string | null };
type ProposalEntry = {
  kind: ProposalField<'purchase' | 'discount' | 'fee' | 'tax' | 'adjustment' | 'subtotal' | 'final_total' | 'payment'>;
  description: ProposalField<string>;
  amount: ProposalField<string>;
  signedAmount: ProposalField<string>;
  quantity: ProposalField<string>;
  unit: ProposalField<string>;
  unitPrice: ProposalField<string>;
  lineTotal: ProposalField<string>;
  discount: ProposalField<string>;
  tax: ProposalField<string>;
  taxIncluded: ProposalField<boolean>;
  includedInTotal: ProposalField<boolean>;
  includedInLineTotal: ProposalField<boolean>;
  relatedPurchaseIndex?: ProposalField<number>;
  currency?: ProposalField<string>;
  suggestedCategory?: ProposalField<string>;
  uncertainty: string | null;
  sourceLineIds: number[];
};

export function mapLocalProposal(value: unknown, lines: LocalOcrLine[]): ReceiptExtractionV1 {
  if (!record(value)) throw new Error('Local interpreter returned an unsupported proposal schema');
  assertKeys(value, ['schemaVersion', 'documentType', 'merchant', 'transactionDate', 'currency', 'reportedArticleCount', 'entries', 'warnings'], 'Local proposal');
  if (value.schemaVersion !== 'local-financial-document-proposal-v1' || !Array.isArray(value.entries) || !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) {
    throw new Error('Local interpreter returned an unsupported proposal schema');
  }
  const ids = new Set(lines.map((line) => line.id));
  const field = <T>(item: ProposalField<T> | undefined): ExtractedField<T> => {
    if (!record(item)) throw new Error('Local interpreter field is malformed');
    assertKeys(item, ['value', 'sourceLineIds', 'uncertainty'], 'Local field');
    if (!Array.isArray(item.sourceLineIds)) throw new Error('Local interpreter field is missing evidence references');
    const refs = [...new Set(item.sourceLineIds)];
    if (refs.some((id) => !ids.has(id))) throw new Error('Local interpreter cited OCR evidence that does not exist');
    if (item.value !== null && refs.length === 0) throw new Error('Local interpreter returned a value without OCR evidence');
    const sourceText = refs.map((id) => lines.find((line) => line.id === id)!.text).join(' ').slice(0, 500) || null;
    return { value: item.value ?? null, confidence: null, uncertainty: item.uncertainty ?? null, sourceText, sourceLineIds: refs };
  };
  const nullableField = <T>(): ExtractedField<T> => ({ value: null, confidence: null, uncertainty: null, sourceText: null, sourceLineIds: [] });
  const entries: ReceiptDocumentEntryV1_1[] = (value.entries as unknown[]).map((raw, index) => {
    if (!record(raw)) throw new Error(`Local interpreter entry ${index + 1} is malformed`);
    const entryKeys = ['kind', 'description', 'amount', 'signedAmount', 'quantity', 'unit', 'unitPrice', 'lineTotal', 'discount', 'tax', 'taxIncluded', 'includedInTotal', 'includedInLineTotal', 'sourceLineIds', 'uncertainty'];
    assertKeys(raw, [...entryKeys, ...(Object.hasOwn(raw, 'relatedPurchaseIndex') ? ['relatedPurchaseIndex'] : []), ...(Object.hasOwn(raw, 'suggestedCategory') ? ['suggestedCategory'] : []), ...(Object.hasOwn(raw, 'currency') ? ['currency'] : [])], `Local entry ${index + 1}`);
    if (!Array.isArray(raw.sourceLineIds) || raw.sourceLineIds.some((id) => !ids.has(id))) throw new Error(`Local interpreter entry ${index + 1} cites OCR evidence that does not exist`);
    const entry = raw as unknown as ProposalEntry;
    const kindValue = entry.kind?.value;
    const kind: ReceiptDocumentEntryV1_1['kind']['value'] = kindValue === 'fee' || kindValue === 'tax' ? 'adjustment' : kindValue;
    if (!kind || !['purchase', 'discount', 'adjustment', 'subtotal', 'final_total', 'payment'].includes(kind)) throw new Error(`Local interpreter entry ${index + 1} has an unsupported kind`);
    const adjustmentKind: ReceiptAdjustmentKind | null = kindValue === 'fee' ? 'other' : kindValue === 'tax' ? 'tax' : kindValue === 'discount' ? 'discount' : kind === 'adjustment' ? 'other' : null;
    const shared = {
      kind: field({ ...entry.kind, value: kind }), description: field(entry.description), amount: field(entry.amount), signedAmount: field(entry.signedAmount),
      quantity: field(entry.quantity), unit: field(entry.unit), unitPrice: field(entry.unitPrice), discount: field(entry.discount), tax: field(entry.tax),
      taxIncluded: field(entry.taxIncluded), adjustmentKind: field<ReceiptAdjustmentKind>({ value: adjustmentKind, sourceLineIds: entry.sourceLineIds, uncertainty: null }),
      includedInTotal: field(entry.includedInTotal), includedInLineTotal: field(entry.includedInLineTotal),
      relatedPurchaseIndex: entry.relatedPurchaseIndex ? field(entry.relatedPurchaseIndex) : nullableField<number>(), suggestedCategory: field(entry.suggestedCategory ?? { value: null, sourceLineIds: [], uncertainty: null }),
      ...(entry.currency ? { currency: field(entry.currency) } : {}),
    };
    return shared;
  });

  const header = <T>(key: string): ExtractedField<T> => field(value[key] as ProposalField<T> | undefined);
  const extraction: ReceiptExtractionV1 = {
    schemaVersion: 'receipt-extraction-v1.1',
    documentType: header<'receipt' | 'invoice' | 'other'>('documentType'),
    merchant: header<string>('merchant'), date: header<string>('transactionDate'), time: nullableField<string>(),
    currency: header<string>('currency'), subtotal: summary(entries, 'subtotal'), taxTotal: summaryAdjustment(entries, 'tax'),
    discountTotal: summaryAdjustment(entries, 'discount'), depositTotal: nullableField<string>(),
    total: summary(entries, 'final_total'), reportedArticleCount: header<number>('reportedArticleCount'),
    sourceText: lines.map((line) => line.text).join('\n').slice(0, 30000),
    entries, warnings: value.warnings.slice(0, 200),
  } as unknown as ReceiptExtractionV1;
  return validateReceiptExtraction(extraction);
}

function summary(entries: ReceiptDocumentEntryV1_1[], kind: string): ExtractedField<string> {
  const candidate = entries.find((entry) => entry.kind.value === kind);
  return candidate ? candidate.amount : { value: null, confidence: null, uncertainty: null, sourceText: null };
}

function summaryAdjustment(entries: ReceiptDocumentEntryV1_1[], kind: string): ExtractedField<string> {
  const candidate = entries.find((entry) => entry.kind.value === 'adjustment' && entry.adjustmentKind.value === kind || entry.kind.value === kind);
  return candidate ? candidate.amount : { value: null, confidence: null, uncertainty: null, sourceText: null };
}

function assertEvidence(lines: LocalOcrLine[]): void {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Local OCR returned no evidence lines');
  const ids = new Set<number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.id) || line.id < 0 || ids.has(line.id) || !Number.isSafeInteger(line.order) || typeof line.text !== 'string' || !Array.isArray(line.box) || line.box.some((n) => !Number.isFinite(n)) || (line.confidence !== null && (typeof line.confidence !== 'number' || line.confidence < 0 || line.confidence > 1))) {
      throw new Error('Local OCR returned malformed or duplicate evidence lines');
    }
    ids.add(line.id);
  }
}

function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function assertKeys(value: Record<string, unknown>, expected: string[], label: string) {
  if (Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) throw new Error(`${label} has missing or unexpected fields`);
}
