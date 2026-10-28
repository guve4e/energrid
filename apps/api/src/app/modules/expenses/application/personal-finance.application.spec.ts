import { PersonalFinanceApplication } from './personal-finance.application';
import { LocalExpenseTextExtractor } from '../infrastructure/local-expense-text-extractor';
import type { PersonalFinanceRepository } from './ports/personal-finance.repository';

function repository(): jest.Mocked<PersonalFinanceRepository> {
  return {
    listCategories: jest.fn().mockResolvedValue([]), createCategory: jest.fn(), renameCategory: jest.fn(), archiveCategory: jest.fn(),
    queryExpenses: jest.fn(), getExpense: jest.fn(), updateExpense: jest.fn(), deleteExpense: jest.fn(), findImportedLegacyIds: jest.fn().mockResolvedValue([]), createExpense: jest.fn(), importExpenses: jest.fn(),
    createDraft: jest.fn(async (_account, proposal) => ({ ...proposal, id: 'draft-1', accountId: 'account-1', status: 'proposed', createdAt: '', updatedAt: '' })),
    getDraft: jest.fn(), rejectDraft: jest.fn(), confirmDraft: jest.fn(), addReceiptMetadata: jest.fn(), summarize: jest.fn(),
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
