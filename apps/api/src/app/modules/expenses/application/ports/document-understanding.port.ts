import type { ReceiptExtractionV1 } from '../../domain/receipt-extraction.types';
export type { ReceiptExtractionV1 } from '../../domain/receipt-extraction.types';

export interface DocumentUnderstandingResult {
  extraction: ReceiptExtractionV1;
  provider: string;
  model: string;
}

export interface DocumentUnderstandingPort {
  extract(image: { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' }, options: { cloudDataConsent: boolean }): Promise<DocumentUnderstandingResult>;
}

export const DOCUMENT_UNDERSTANDING = Symbol('DOCUMENT_UNDERSTANDING');
