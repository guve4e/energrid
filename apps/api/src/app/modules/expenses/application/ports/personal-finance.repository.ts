import type {
  ExpenseDraft,
  ExpenseDraftProposal,
  ExpenseQuery,
  ExpenseRecord,
  ExpenseSource,
  FinanceCategory,
  ReceiptMetadata,
  SpendingSummary,
} from '../../domain/personal-finance.types';

export interface ExpenseWrite {
  date: string;
  amount: string;
  currency: string;
  amountEur: string | null;
  fx: ExpenseRecord['fx'];
  merchantName: string | null;
  category: string;
  categoryId?: string | null;
  description: string;
  tags: string[];
  items: ExpenseRecord['items'];
  liters: string | null;
  source: ExpenseSource;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
}

export interface ExpenseImportRow extends ExpenseWrite {
  legacyRecordId: string | null;
}

export interface ExpenseDraftReviewWrite {
  date: string | null;
  amount: string | null;
  currency: string | null;
  merchantName: string | null;
  category: string | null;
  categoryId: string | null;
  description: string | null;
  items: ExpenseRecord['items'];
  itemizationReviewed: boolean;
  totalOnly: boolean;
  adjustments: NonNullable<ReceiptMetadata['reviewedAdjustments']>;
}

export interface PersonalFinanceRepository {
  listCategories(accountId: string, includeArchived?: boolean): Promise<FinanceCategory[]>;
  createCategory(accountId: string, actorId: string, input: CategoryWrite): Promise<FinanceCategory>;
  renameCategory(accountId: string, actorId: string, categoryId: string, input: CategoryWrite): Promise<FinanceCategory | null>;
  archiveCategory(accountId: string, actorId: string, categoryId: string): Promise<FinanceCategory | null>;
  queryExpenses(accountId: string, query: ExpenseQuery): Promise<ExpenseRecord[]>;
  getExpense(accountId: string, expenseId: string): Promise<ExpenseRecord | null>;
  updateExpense(accountId: string, actorId: string, expenseId: string, input: ExpenseWrite): Promise<ExpenseRecord | null>;
  deleteExpense(accountId: string, actorId: string, expenseId: string): Promise<boolean>;
  findImportedLegacyIds(accountId: string, ids: readonly string[]): Promise<string[]>;
  createExpense(accountId: string, actorId: string, input: ExpenseWrite): Promise<ExpenseRecord>;
  importExpenses(accountId: string, actorId: string, rows: readonly ExpenseImportRow[]): Promise<{ imported: number; duplicates: number }>;
  createDraft(accountId: string, actorId: string, proposal: ExpenseDraftProposal): Promise<ExpenseDraft>;
  getDraft(accountId: string, draftId: string): Promise<ExpenseDraft | null>;
  reopenRejectedReceiptDraft(accountId: string, actorId: string, receiptId: string): Promise<ExpenseDraft | null>;
  rejectDraft(accountId: string, draftId: string, actorId: string): Promise<ExpenseDraft | null>;
  confirmDraft(accountId: string, draftId: string, actorId: string): Promise<ExpenseRecord | null>;
  addReceiptMetadata(accountId: string, draftId: string, receipt: Omit<ReceiptMetadata, 'id' | 'accountId' | 'draftId' | 'expenseId' | 'createdAt'>): Promise<ReceiptMetadata>;
  findReceiptByHash(accountId: string, contentHash: string): Promise<ReceiptMetadata | null>;
  findPossibleReceiptMatches(accountId: string, date: string, amount: string, currency: string, merchantName: string | null): Promise<ExpenseRecord[]>;
  getReceipt(accountId: string, receiptId: string): Promise<ReceiptMetadata | null>;
  markReceiptDocumentDeleted(accountId: string, actorId: string, receiptId: string): Promise<ReceiptMetadata | null>;
  updateDraft(accountId: string, actorId: string, draftId: string, input: ExpenseDraftReviewWrite): Promise<ExpenseDraft | null>;
  attachReceiptToExpense(accountId: string, actorId: string, receiptId: string, expenseId: string): Promise<ReceiptMetadata | null>;
  summarize(accountId: string, query: Pick<ExpenseQuery, 'fromDate' | 'toDate'>): Promise<SpendingSummary>;
}

export interface CategoryWrite {
  name: string;
  description: string | null;
  parentId: string | null;
}

export const PERSONAL_FINANCE_REPOSITORY = Symbol('PERSONAL_FINANCE_REPOSITORY');
