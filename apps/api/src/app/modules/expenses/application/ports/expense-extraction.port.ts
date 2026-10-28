import type { ExpenseDraftProposal } from '../../domain/personal-finance.types';

export interface ExpenseTextExtractionPort {
  extract(text: string, options: { cloudDataConsent: boolean }): Promise<ExpenseDraftProposal>;
}

export interface ExpenseReceiptExtractionPort {
  extract(receipt: { accountId: string; storageKey: string; mediaType: string; contentHash: string }): Promise<ExpenseDraftProposal>;
}

export const EXPENSE_TEXT_EXTRACTION = Symbol('EXPENSE_TEXT_EXTRACTION');
export const EXPENSE_RECEIPT_EXTRACTION = Symbol('EXPENSE_RECEIPT_EXTRACTION');
