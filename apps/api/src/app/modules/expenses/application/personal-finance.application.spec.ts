import { PersonalFinanceApplication } from './personal-finance.application';
import { LocalExpenseTextExtractor } from '../infrastructure/local-expense-text-extractor';
import type { PersonalFinanceRepository } from './ports/personal-finance.repository';

function repository(): jest.Mocked<PersonalFinanceRepository> {
  return {
    listCategories: jest.fn().mockResolvedValue([]), createCategory: jest.fn(), renameCategory: jest.fn(), archiveCategory: jest.fn(),
    queryExpenses: jest.fn(), getExpense: jest.fn(), updateExpense: jest.fn(), deleteExpense: jest.fn(), findImportedLegacyIds: jest.fn().mockResolvedValue([]), createExpense: jest.fn(), importExpenses: jest.fn(),
    createDraft: jest.fn(async (_account, proposal) => ({ ...proposal, id: 'draft-1', accountId: 'account-1', status: 'proposed', createdAt: '', updatedAt: '' })),
    getDraft: jest.fn(), rejectDraft: jest.fn(), confirmDraft: jest.fn(), addReceiptMetadata: jest.fn(), summarize: jest.fn(),
    getReceipt: jest.fn(), replaceReceiptExtraction: jest.fn(), findReceiptByHash: jest.fn(), findPossibleReceiptMatches: jest.fn(),
    markReceiptDocumentDeleted: jest.fn(), updateDraft: jest.fn(), attachReceiptToExpense: jest.fn(), reopenRejectedReceiptDraft: jest.fn(),
  };
}

function financialDocumentPreviewInput() {
  const field = <T>(value: T | null, id?: number) => ({ value, confidence: null, uncertainty: null, sourceText: id === undefined ? null : `evidence-${id}`, ...(id === undefined ? {} : { sourceLineIds: [id] }) });
  const purchase = {
    kind: field('purchase', 1), description: field('Basket', 1), amount: field('10.00', 1), signedAmount: field(null),
    quantity: field(null), unit: field(null), unitPrice: field(null), discount: field(null), tax: field(null), taxIncluded: field(null),
    adjustmentKind: field(null), includedInTotal: field(null), includedInLineTotal: field(null), relatedPurchaseIndex: field(null), suggestedCategory: field(null),
  };
  const total = { ...purchase, kind: field('final_total', 2), description: field('Total', 2), amount: field('10.00', 2) };
  return {
    schemaVersion: 'financial-document-interpretation-v1' as const,
    evidence: [{ id: 0, order: 0, text: 'Shop receipt' }, { id: 1, order: 1, text: 'Basket 10.00' }, { id: 2, order: 2, text: 'Total 10.00' }],
    extraction: {
      schemaVersion: 'receipt-extraction-v1.1' as const, documentType: field('receipt', 0), merchant: field('Shop', 0),
      date: field('2026-10-27', 0), time: field(null), currency: field('EUR', 1), subtotal: field(null), taxTotal: field(null),
      discountTotal: field(null), depositTotal: field(null), total: field('10.00', 2), reportedArticleCount: field(null),
      adjustments: [], sourceText: 'Basket 10.00\nTotal 10.00', items: [], documentEntries: [purchase, total], warnings: [],
    },
  };
}

describe('PersonalFinanceApplication', () => {
  it('normalizes and account-scopes category creation, rename, archive and listing', async () => {
    const repo = repository();
    const app = new PersonalFinanceApplication(repo, new LocalExpenseTextExtractor());
    const context = { accountId: 'account-a', actorId: 'user-a' };
    await app.createCategory(context, { name: '  Food  ', description: '  Meals  ', parentId: null });
    await app.renameCategory(context, 'category-a', { name: 'Dining', description: null, parentId: 'parent-a' });
    await app.archiveCategory(context, 'category-a');
    await app.listCategories(context, true);
    expect(repo.createCategory).toHaveBeenCalledWith('account-a', 'user-a', { name: 'Food', description: 'Meals', parentId: null });
    expect(repo.renameCategory).toHaveBeenCalledWith('account-a', 'user-a', 'category-a', { name: 'Dining', description: null, parentId: 'parent-a' });
    expect(repo.archiveCategory).toHaveBeenCalledWith('account-a', 'user-a', 'category-a');
    expect(repo.listCategories).toHaveBeenCalledWith('account-a', true);
  });

  it('rejects missing verified context and malformed category values before repository access', async () => {
    const repo = repository();
    const app = new PersonalFinanceApplication(repo, new LocalExpenseTextExtractor());
    expect(() => app.listCategories({ accountId: '', actorId: 'actor' })).toThrow(/verified finance account/);
    expect(() => app.createCategory({ accountId: 'a', actorId: 'b' }, { name: ' '.repeat(3), description: null, parentId: null })).toThrow(/Category name/);
    expect(repo.createCategory).not.toHaveBeenCalled();
  });

  it('proposes a local draft for conversational text without persisting an expense', async () => {
    const repo = repository();
    const app = new PersonalFinanceApplication(repo, new LocalExpenseTextExtractor());
    await app.proposeExpenseDraft({ accountId: 'account-1', text: 'I spent €76 at Lidl.', cloudDataConsent: false });
    expect(repo.createDraft).toHaveBeenCalledWith('account-1', 'account-1', expect.objectContaining({ amount: '76', currency: 'EUR', merchantName: 'Lidl', sourceKind: 'assistant-text' }));
    expect(repo.createExpense).not.toHaveBeenCalled();
  });

  it('previews financial documents with verified account context and performs no repository writes', () => {
    const repo = repository();
    const app = new PersonalFinanceApplication(repo, new LocalExpenseTextExtractor());
    const input = financialDocumentPreviewInput();
    const first = app.previewFinancialDocument({ accountId: 'account-a', actorId: 'actor-a' }, input);
    const second = app.previewFinancialDocument({ accountId: 'account-b', actorId: 'actor-b' }, input);
    expect(first.status).toBe('reconciled');
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('accountId');
    expect(() => app.previewFinancialDocument({ accountId: '', actorId: 'actor-a' }, input)).toThrow(/verified finance account/);
    expect(Object.values(repo).flatMap((method) => method.mock.calls)).toEqual([]);
  });

  it('requires the authenticated account itself to confirm or reject mutations', async () => {
    const app = new PersonalFinanceApplication(repository(), new LocalExpenseTextExtractor());
    expect(() => app.confirmExpense({ accountId: 'account-a', actorId: 'account-b', draftId: 'draft-1' })).toThrow(/owning account/);
    await expect(app.rejectExpenseDraft({ accountId: 'account-a', actorId: 'account-b', draftId: 'draft-1' })).rejects.toThrow(/owning account/);
  });

  it('delegates explicit draft confirmation, rejection, queries, and summaries with the account scope', async () => {
    const repo = repository();
    const app = new PersonalFinanceApplication(repo, new LocalExpenseTextExtractor());
    await app.confirmExpense({ accountId: 'account-1', actorId: 'account-1', draftId: 'draft-1' });
    await app.rejectExpenseDraft({ accountId: 'account-1', actorId: 'account-1', draftId: 'draft-2' });
    await app.queryExpenses({ accountId: 'account-1', query: { category: 'Fuel' } });
    await app.summarizeSpending({ accountId: 'account-1', query: { fromDate: '2025-01-01' } });
    expect(repo.confirmDraft).toHaveBeenCalledWith('account-1', 'draft-1', 'account-1');
    expect(repo.rejectDraft).toHaveBeenCalledWith('account-1', 'draft-2', 'account-1');
    expect(repo.queryExpenses).toHaveBeenCalledWith('account-1', { category: 'Fuel' });
    expect(repo.summarize).toHaveBeenCalledWith('account-1', { fromDate: '2025-01-01' });
  });

  it('rejects malformed AI/extractor proposals before repository writes', async () => {
    const repo = repository();
    const invalidExtractor = { extract: jest.fn().mockResolvedValue({ amount: 'NaN', tags: null }) };
    const app = new PersonalFinanceApplication(repo, invalidExtractor);
    await expect(app.proposeExpenseDraft({ accountId: 'account-1', text: 'spent money', cloudDataConsent: false })).rejects.toThrow();
    expect(repo.createDraft).not.toHaveBeenCalled();
  });

  it('allows only EUR and USD for new expenses while historical imports can retain BGN', async () => {
    const repo = repository();
    const app = new PersonalFinanceApplication(repo, new LocalExpenseTextExtractor());
    const expense = { date: '2026-10-27', amount: '10', currency: 'BGN', amountEur: null, fx: null, merchantName: null, category: 'Groceries', description: 'Food', tags: [], items: [], liters: null, source: { kind: 'manual' as const, id: null } };
    await expect(app.createExpense('account-1', 'account-1', expense)).rejects.toThrow(/EUR or USD/);
    expect(repo.createExpense).not.toHaveBeenCalled();
    await app.importExpenses('account-1', 'account-1', [{ ...expense, source: { kind: 'legacy-mongo', id: 'mongo:mono.expenses:abc123' }, legacyRecordId: 'mongo:mono.expenses:abc123' }]);
    expect(repo.importExpenses).toHaveBeenCalledWith('account-1', 'account-1', [expect.objectContaining({ currency: 'BGN' })]);
  });
});

describe('PostgreSQL-only Finance summaries', () => {
  it('preserves repository totals and computes a calendar-month daily pace with exact decimal arithmetic', async () => {
    const repo = repository();
    repo.summarize.mockResolvedValue({
      currency: 'EUR', total: '17.80', transactionCount: 2, excludedUnconvertedCount: 0,
      fromDate: '2025-01-01', toDate: '2025-01-31', byMonth: [], byCategory: [], byMerchant: [], byProduct: [],
    });
    const app = new PersonalFinanceApplication(repo, new LocalExpenseTextExtractor());
    await expect(app.summarizeSpending({ accountId: 'account-a', query: { fromDate: '2025-01-01', toDate: '2025-01-31' } }))
      .resolves.toMatchObject({ total: '17.80', transactionCount: 2, dailyAverage: '0.57' });
    expect(repo.summarize).toHaveBeenCalledWith('account-a', { fromDate: '2025-01-01', toDate: '2025-01-31' });
    await expect(app.summarizeSpending({ accountId: 'account-a', query: {} })).resolves.toHaveProperty('dailyAverage', null);
  });

  it('rejects invalid PostgreSQL query limits before asking the repository', async () => {
    const repo = repository();
    const app = new PersonalFinanceApplication(repo, new LocalExpenseTextExtractor());
    expect(() => app.queryExpenses({ accountId: 'account-a', query: { limit: -1 } })).toThrow('limit');
    expect(repo.queryExpenses).not.toHaveBeenCalled();
  });
});
