import type { ExtractedField, ReceiptAdjustmentKind, ReceiptDocumentEntryV1_1, ReceiptExtractionV1 } from '../domain/receipt-extraction.types';
import { validateReceiptExtraction } from '../domain/receipt-extraction';

const API_VERSION = '2024-11-30';
const MODEL_ID = 'prebuilt-receipt';
const MAX_POLLS = 30;
const DEFAULT_POLL_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 60_000;

// Azure response shapes intentionally stay private to this benchmark adapter.
type AzureSpan = { offset?: number; length?: number };
type AzureBoundingRegion = { pageNumber?: number; polygon?: number[] };
type AzureField = {
  type?: string;
  valueString?: string;
  valueDate?: string;
  valueNumber?: number;
  valueCurrency?: { amount?: number; currencyCode?: string };
  valueArray?: AzureField[];
  valueObject?: Record<string, AzureField>;
  content?: string;
  confidence?: number;
  spans?: AzureSpan[];
  boundingRegions?: AzureBoundingRegion[];
};
type AzurePage = {
  pageNumber?: number;
  lines?: Array<{ content?: string; spans?: AzureSpan[]; boundingRegions?: AzureBoundingRegion[] }>;
  words?: Array<{ content?: string; confidence?: number; spans?: AzureSpan[]; boundingRegions?: AzureBoundingRegion[] }>;
};
type AzureAnalysisResult = {
  status?: string;
  analyzeResult?: {
    content?: string;
    documents?: Array<{ fields?: Record<string, AzureField> }>;
    pages?: AzurePage[];
    warnings?: Array<{ code?: string; message?: string }>;
  };
};

type BenchmarkEvidence = {
  recognizedText: string | null;
  fields: Array<{ path: string; text: string | null; confidence: number | null; spans: AzureSpan[]; boundingRegions: AzureBoundingRegion[] }>;
  pages: Array<{ pageNumber: number | null; lines: Array<{ text: string; spans: AzureSpan[]; boundingRegions: AzureBoundingRegion[] }>; words: Array<{ text: string; confidence: number | null; spans: AzureSpan[]; boundingRegions: AzureBoundingRegion[] }> }>;
  warnings: string[];
};

type AzureBenchmarkOutput = {
  extraction: ReceiptExtractionV1;
  provider: 'azure-document-intelligence';
  model: 'prebuilt-receipt';
  apiVersion: string;
  latencyMs: number;
  evidence: BenchmarkEvidence;
};

type AdapterOptions = {
  endpoint?: string;
  key?: string;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

/**
 * Isolated benchmark adapter. It is deliberately not registered in the
 * Finance module; using it requires per-call cloud consent and external config.
 */
export class AzureReceiptBenchmarkAdapter {
  private readonly endpoint: string;
  private readonly key: string;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: AdapterOptions = {}) {
    this.endpoint = (options.endpoint ?? process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? '').trim().replace(/\/+$/, '');
    this.key = (options.key ?? process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY ?? '').trim();
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  async analyze(
    image: { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' },
    options: { cloudDataConsent: boolean },
  ): Promise<AzureBenchmarkOutput> {
    if (options.cloudDataConsent !== true) throw new Error('Explicit cloud consent is required before sending a receipt to Azure');
    if (!this.endpoint || !this.key) throw new Error('Azure Document Intelligence is not configured; set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_KEY');
    if (!image.bytes.byteLength) throw new Error('Receipt image is empty');
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
      throw new Error('Azure Document Intelligence endpoint must use HTTPS');
    }

    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const analyzeUrl = new URL(`${this.endpoint}/documentintelligence/documentModels/${MODEL_ID}:analyze`);
      analyzeUrl.searchParams.set('_overload', 'analyzeDocument');
      analyzeUrl.searchParams.set('api-version', API_VERSION);
      analyzeUrl.searchParams.set('locale', 'bg');
      const submitted = await this.fetcher(analyzeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': this.key },
        body: JSON.stringify({ base64Source: Buffer.from(image.bytes).toString('base64') }),
        signal: controller.signal,
      });
      if (submitted.status !== 202) throw new Error(`Azure Document Intelligence analyze request failed with HTTP ${submitted.status}`);
      const operationLocation = submitted.headers.get('operation-location');
      if (!operationLocation) throw new Error('Azure Document Intelligence response omitted Operation-Location');
      const resultUrl = new URL(operationLocation);
      if (resultUrl.origin !== endpoint.origin) throw new Error('Azure Document Intelligence returned an operation URL on an unexpected host');

      for (let poll = 0; poll < MAX_POLLS; poll += 1) {
        const response = await this.fetcher(resultUrl, {
          headers: { 'Ocp-Apim-Subscription-Key': this.key },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Azure Document Intelligence result request failed with HTTP ${response.status}`);
        const result = await response.json() as AzureAnalysisResult;
        if (result.status === 'succeeded') {
          if (!result.analyzeResult) throw new Error('Azure Document Intelligence returned no analyze result');
          const mapped = mapAnalysisResult(result.analyzeResult);
          return {
            ...mapped,
            provider: 'azure-document-intelligence',
            model: MODEL_ID,
            apiVersion: API_VERSION,
            latencyMs: Math.max(0, this.now() - startedAt),
          };
        }
        if (result.status === 'failed') throw new Error('Azure Document Intelligence analysis failed');
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : DEFAULT_POLL_DELAY_MS;
        if (poll + 1 < MAX_POLLS) await this.sleep(delay);
      }
      throw new Error('Azure Document Intelligence analysis did not finish within the polling limit');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mapAnalysisResult(result: NonNullable<AzureAnalysisResult['analyzeResult']>) {
  const fields = result.documents?.[0]?.fields ?? {};
  const currencySource = fields.Total ?? fields.Subtotal;
  const currency = currencySource?.valueCurrency?.currencyCode ?? null;
  const itemsField = fields.Items;
  const entries: ReceiptDocumentEntryV1_1[] = [];
  const adjustments: ReceiptExtractionV1['adjustments'] = [];
  const items: ReceiptExtractionV1['items'] = [];

  for (const [index, wrapped] of (itemsField?.valueArray ?? []).entries()) {
    const itemFields = wrapped.valueObject ?? {};
    const description = stringField(itemFields.Description);
    const quantity = decimalField(itemFields.Quantity);
    const unitPrice = decimalField(itemFields.Price);
    const lineTotal = decimalField(itemFields.TotalPrice);
    const signedTotal = lineTotal.value;
    const isNegativeLine = signedTotal?.startsWith('-') === true;
    const kind = isNegativeLine ? 'adjustment' : 'purchase';
    const amount = isNegativeLine && signedTotal ? absoluteDecimal(signedTotal) : signedTotal;
    const sourceText = description.sourceText;

    entries.push(documentEntry({
      kind, description, amount: valueField(amount, sourceText, fieldConfidence(itemFields.TotalPrice)),
      signedAmount: valueField<string>(isNegativeLine ? signedTotal : null, sourceText, fieldConfidence(itemFields.TotalPrice)),
      quantity, unit: nullString(), unitPrice,
      discount: valueField(isNegativeLine ? amount : null, sourceText, fieldConfidence(itemFields.TotalPrice)),
      tax: nullString(), taxIncluded: nullBoolean(),
      adjustmentKind: valueField(isNegativeLine ? 'other' : null),
      includedInTotal: valueField(isNegativeLine ? true : null),
      includedInLineTotal: valueField(isNegativeLine ? false : null),
      relatedPurchaseIndex: valueField(isNegativeLine ? null : index),
      suggestedCategory: nullString(),
    }));

    if (isNegativeLine) {
      adjustments.push({ label: description.value ?? 'Negative receipt line', amount, signedAmount: signedTotal, kind: 'other', includedInTotal: true, includedInLineTotal: false, relatedPurchaseIndex: null });
      continue;
    }
    items.push({
      originalDescription: description,
      normalizedDescription: nullString(),
      quantity,
      unit: nullString(),
      packaging: nullString(),
      unitPrice,
      lineTotal,
      discount: nullString(),
      tax: nullString(),
      taxIncluded: nullBoolean(),
      suggestedCategory: nullString(),
    });
  }

  const subtotal = decimalField(fields.Subtotal);
  const totalTax = decimalField(fields.TotalTax ?? fields.Tax);
  const total = decimalField(fields.Total);
  const tip = decimalField(fields.Tip);
  const deposit = decimalField(fields.Deposit);
  appendSummaryEntry(entries, 'subtotal', 'Subtotal', fields.Subtotal, subtotal);
  appendSummaryEntry(entries, 'final_total', 'Total', fields.Total, total);
  appendAdjustment(entries, adjustments, 'tax', 'Tax', fields.TotalTax ?? fields.Tax, totalTax);
  appendAdjustment(entries, adjustments, 'other', 'Tip', fields.Tip, tip);
  appendAdjustment(entries, adjustments, 'deposit', 'Deposit', fields.Deposit, deposit);
  appendPaymentEntries(entries, fields);

  const warnings = items.length === 0 ? ['Azure returned no structured purchase items.'] : [];
  if (!currency) warnings.push('Azure receipt response did not provide an ISO currency code.');
  if (entries.some((entry) => entry.kind.value === 'adjustment' && entry.signedAmount.value?.startsWith('-'))) {
    warnings.push('A negative Azure item row is preserved as an adjustment; discount versus return meaning needs review.');
  }
  const validated = validateReceiptExtraction({
    schemaVersion: 'receipt-extraction-v1',
    documentType: valueField('receipt'),
    merchant: stringField(fields.MerchantName),
    date: valueField(validIsoDate(fields.TransactionDate?.valueDate), fieldText(fields.TransactionDate), fieldConfidence(fields.TransactionDate), confidenceWarning(fields.TransactionDate)),
    time: stringField(fields.TransactionTime),
    currency: valueField(currency),
    subtotal,
    taxTotal: totalTax,
    discountTotal: nullString(),
    depositTotal: deposit,
    total,
    reportedArticleCount: nullNumber(),
    sourceText: result.content ?? null,
    items,
    adjustments,
    warnings,
  });
  const extraction: ReceiptExtractionV1 = { ...validated, schemaVersion: 'receipt-extraction-v1.1', documentEntries: entries };

  return { extraction, evidence: collectEvidence(result) };
}

function appendSummaryEntry(entries: ReceiptDocumentEntryV1_1[], kind: 'subtotal' | 'final_total', label: string, source: AzureField | undefined, amount: ExtractedField<string>) {
  if (amount.value === null && !source) return;
  entries.push(documentEntry({ kind, description: stringField(source).value ? stringField(source) : valueField(label), amount, signedAmount: nullString(), quantity: nullString(), unit: nullString(), unitPrice: nullString(), discount: nullString(), tax: nullString(), taxIncluded: nullBoolean(), adjustmentKind: nullAdjustmentKind(), includedInTotal: nullBoolean(), includedInLineTotal: nullBoolean(), relatedPurchaseIndex: nullNumber(), suggestedCategory: nullString() }));
}

function appendAdjustment(entries: ReceiptDocumentEntryV1_1[], adjustments: ReceiptExtractionV1['adjustments'], kind: 'tax' | 'other' | 'deposit', label: string, source: AzureField | undefined, amount: ExtractedField<string>) {
  if (amount.value === null) return;
  const signedAmount = amount.value;
  const extractionKind = kind === 'other' ? 'other' : kind;
  // The prebuilt model reports these as fields but does not establish whether
  // they are already included in Total or the purchase line amounts.
  adjustments.push({ label, amount: absoluteDecimal(signedAmount), signedAmount, kind: extractionKind, includedInTotal: null, includedInLineTotal: null, relatedPurchaseIndex: null });
  entries.push(documentEntry({ kind: 'adjustment', description: stringField(source).value ? stringField(source) : valueField(label), amount: valueField(absoluteDecimal(signedAmount), fieldText(source), fieldConfidence(source)), signedAmount: valueField(signedAmount, fieldText(source), fieldConfidence(source)), quantity: nullString(), unit: nullString(), unitPrice: nullString(), discount: nullString(), tax: valueField(kind === 'tax' ? absoluteDecimal(signedAmount) : null), taxIncluded: nullBoolean(), adjustmentKind: valueField(extractionKind), includedInTotal: nullBoolean(), includedInLineTotal: nullBoolean(), relatedPurchaseIndex: nullNumber(), suggestedCategory: nullString() }));
}

function appendPaymentEntries(entries: ReceiptDocumentEntryV1_1[], fields: Record<string, AzureField>) {
  for (const [key, value] of Object.entries(fields)) {
    if (!/(payment|tender|card|cash)/i.test(key)) continue;
    const text = fieldText(value);
    const amount = decimalField(value);
    entries.push(documentEntry({ kind: 'payment', description: valueField(text ?? key, text, fieldConfidence(value)), amount, signedAmount: nullString(), quantity: nullString(), unit: nullString(), unitPrice: nullString(), discount: nullString(), tax: nullString(), taxIncluded: nullBoolean(), adjustmentKind: nullAdjustmentKind(), includedInTotal: nullBoolean(), includedInLineTotal: nullBoolean(), relatedPurchaseIndex: nullNumber(), suggestedCategory: nullString() }));
  }
}

function collectEvidence(result: NonNullable<AzureAnalysisResult['analyzeResult']>): BenchmarkEvidence {
  const evidence: BenchmarkEvidence = {
    recognizedText: result.content ?? null,
    fields: [],
    pages: (result.pages ?? []).map((page) => ({
      pageNumber: page.pageNumber ?? null,
      lines: (page.lines ?? []).map((line) => ({ text: line.content ?? '', spans: line.spans ?? [], boundingRegions: line.boundingRegions ?? [] })),
      words: (page.words ?? []).map((word) => ({ text: word.content ?? '', confidence: word.confidence ?? null, spans: word.spans ?? [], boundingRegions: word.boundingRegions ?? [] })),
    })),
    warnings: (result.warnings ?? []).map((warning) => warning.message ?? warning.code ?? 'Azure returned a document warning'),
  };
  for (const [path, field] of Object.entries(result.documents?.[0]?.fields ?? {})) collectFieldEvidence(field, path, evidence.fields);
  return evidence;
}

function collectFieldEvidence(field: AzureField, path: string, output: BenchmarkEvidence['fields']) {
  output.push({ path, text: fieldText(field), confidence: field.confidence ?? null, spans: field.spans ?? [], boundingRegions: field.boundingRegions ?? [] });
  for (const [key, value] of Object.entries(field.valueObject ?? {})) collectFieldEvidence(value, `${path}.${key}`, output);
  for (const [index, value] of (field.valueArray ?? []).entries()) collectFieldEvidence(value, `${path}[${index}]`, output);
}

function documentEntry(value: Omit<ReceiptDocumentEntryV1_1, 'kind'> & { kind: ReceiptDocumentEntryV1_1['kind']['value'] }): ReceiptDocumentEntryV1_1 {
  return { ...value, kind: valueField(value.kind) };
}

function stringField(field: AzureField | undefined): ExtractedField<string> {
  const value = field?.valueString ?? field?.valueDate ?? null;
  return valueField(value, fieldText(field), fieldConfidence(field), confidenceWarning(field));
}

function decimalField(field: AzureField | undefined): ExtractedField<string> {
  const numeric = field?.valueCurrency?.amount ?? field?.valueNumber;
  const value = typeof numeric === 'number' && Number.isFinite(numeric) ? String(numeric) : null;
  return valueField(value, fieldText(field), fieldConfidence(field), confidenceWarning(field));
}

function valueField<T>(value: T | null, sourceText: string | null = null, confidence: number | null = null, uncertainty: string | null = null): ExtractedField<T> {
  return { value, confidence, uncertainty, sourceText };
}

function nullString(): ExtractedField<string> { return valueField<string>(null); }
function nullBoolean(): ExtractedField<boolean> { return valueField<boolean>(null); }
function nullNumber(): ExtractedField<number> { return valueField<number>(null); }
function nullAdjustmentKind(): ExtractedField<ReceiptAdjustmentKind> { return valueField<ReceiptAdjustmentKind>(null); }

function fieldText(field: AzureField | undefined): string | null { return field?.content ?? field?.valueString ?? field?.valueDate ?? null; }
function fieldConfidence(field: AzureField | undefined): number | null { return typeof field?.confidence === 'number' && Number.isFinite(field.confidence) ? field.confidence : null; }
function confidenceWarning(field: AzureField | undefined): string | null { const confidence = fieldConfidence(field); return confidence !== null && confidence < 0.7 ? 'Azure field confidence is below 0.70' : null; }
function validIsoDate(value: string | undefined): string | null { return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null; }
function absoluteDecimal(value: string): string { return value.startsWith('-') ? value.slice(1) : value; }
