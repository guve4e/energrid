import { FinanceAssistantTools } from './finance-assistant-tools';
import type { AuthPrincipal } from '../auth/auth.types';

const principal = (userId: string): AuthPrincipal => ({
  userId, email: `${userId}@example.test`, name: userId, role: 'admin', sessionId: `session-${userId}`, sessionVersion: 1,
});

const draft = {
  id: 'draft-00000001', accountId: 'account-a', status: 'proposed', date: '2026-10-27',
  amount: '76.00', currency: 'EUR', merchantName: 'Lidl', category: 'Groceries',
  description: 'Purchase at Lidl', tags: [], items: [], createdAt: '2026-10-27T12:00:00.000Z',
};

function setup() {
  const finance = {
    proposeExpenseDraft: jest.fn().mockResolvedValue(draft),
    getExpenseDraft: jest.fn(async (accountId: string) => accountId === 'account-a' ? draft : null),
    confirmExpense: jest.fn().mockResolvedValue({ ...draft, id: 'expense-0000001', amountEur: '76.00' }),
    rejectExpenseDraft: jest.fn().mockResolvedValue({ ...draft, status: 'rejected' }),
    queryExpenses: jest.fn().mockResolvedValue([{ id: 'expense-0000001', amountEur: '76.00' }]),
    summarizeSpending: jest.fn().mockResolvedValue({ currency: 'EUR', total: '76.00', transactionCount: 1, byCategory: [{ category: 'Groceries', total: '76.00', count: 1 }] }),
  };
  const boundary = new FinanceAssistantTools(finance as never);
  const make = (userId: string | undefined, message: string, conversationId = 'conversation-0001') => boundary.tools({
    principal: userId ? principal(userId) : undefined, conversationId, userMessage: message,
  }) as any[];
  return { finance, boundary, make };
}

const tool = (tools: any[], name: string) => tools.find(item => item.name === name);
const textResult = (value: any) => value.details ?? value.content?.[0]?.text;

describe('FinanceAssistantTools', () => {
  it('requires a verified principal and never accepts an account ID from model arguments', async () => {
    const { finance, make } = setup();
    const proposal = tool(make(undefined, 'I spent €76 at Lidl.'), 'finance.propose_expense');
    expect((await proposal.execute('call-1', {})).isError).toBe(true);
    expect(finance.proposeExpenseDraft).not.toHaveBeenCalled();

    const summarize = tool(make('account-a', 'How much this month?'), 'finance.summarize_spending');
    expect((await summarize.execute('call-2', { accountId: 'account-b' })).isError).toBe(true);
    expect(finance.summarizeSpending).not.toHaveBeenCalled();
  });

  it('creates an account-owned draft from the user message without confirming an expense', async () => {
    const { finance, make } = setup();
    const proposal = tool(make('account-a', 'I spent €76 at Lidl.'), 'finance.propose_expense');
    expect(textResult(await proposal.execute('call-1', {}))).toMatchObject({ id: draft.id, status: 'proposed' });
    expect(finance.proposeExpenseDraft).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-a', text: 'I spent €76 at Lidl.', cloudDataConsent: false,
    }));
    expect(finance.confirmExpense).not.toHaveBeenCalled();
  });

  it('confirms only the exact pending draft after an unambiguous affirmative and allows idempotent retries', async () => {
    const { finance, make } = setup();
    await tool(make('account-a', 'I spent €76 at Lidl.'), 'finance.propose_expense').execute('call-1', {});
    const wrongDraft = tool(make('account-a', 'Yes.'), 'finance.confirm_expense');
    expect((await wrongDraft.execute('call-2', { draftId: 'draft-00000002' })).isError).toBe(true);
    const confirm = tool(make('account-a', 'Да, запиши го.'), 'finance.confirm_expense');
    const first = await confirm.execute('call-3', { draftId: draft.id });
    const repeated = await tool(make('account-a', 'Да.'), 'finance.confirm_expense').execute('call-4', { draftId: draft.id });
    expect(textResult(first)).toMatchObject({ amountEur: '76.00' });
    expect(textResult(repeated)).toMatchObject({ amountEur: '76.00' });
    expect(finance.confirmExpense).toHaveBeenCalledTimes(2);
    expect(finance.confirmExpense).toHaveBeenCalledWith({ accountId: 'account-a', actorId: 'account-a', draftId: draft.id });
  });

  it('rejects cross-account draft reads and ambiguous confirmation language', async () => {
    const { finance, make } = setup();
    const getOther = tool(make('account-b', 'Show that draft.'), 'finance.get_draft');
    expect((await getOther.execute('call-1', { draftId: draft.id })).isError).toBe(true);
    expect(finance.getExpenseDraft).toHaveBeenCalledWith('account-b', draft.id);

    await tool(make('account-a', 'I spent €76 at Lidl.'), 'finance.propose_expense').execute('call-2', {});
    const ambiguous = tool(make('account-a', 'Yes, but I also bought coffee.'), 'finance.confirm_expense');
    expect((await ambiguous.execute('call-3', { draftId: draft.id })).isError).toBe(true);
    expect(finance.confirmExpense).not.toHaveBeenCalled();
  });

  it('rejects malformed arguments and expired pending conversations', async () => {
    const { finance, make } = setup();
    const query = tool(make('account-a', 'Show my latest expenses.'), 'finance.query_expenses');
    expect((await query.execute('call-1', { limit: 'many' })).isError).toBe(true);
    expect((await query.execute('call-2', { tenantId: 'tenant-a' })).isError).toBe(true);
    expect(finance.queryExpenses).not.toHaveBeenCalled();

    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await tool(make('account-a', 'I spent €76 at Lidl.'), 'finance.propose_expense').execute('call-3', {});
    dateNow.mockReturnValue(1_000_000 + 15 * 60 * 1000 + 1);
    const expired = tool(make('account-a', 'Yes.'), 'finance.confirm_expense');
    expect((await expired.execute('call-4', { draftId: draft.id })).isError).toBe(true);
    expect(finance.confirmExpense).not.toHaveBeenCalled();
    dateNow.mockRestore();
  });

  it('requires a clear rejection and keeps confirmation restricted to the current conversation', async () => {
    const { finance, make } = setup();
    await tool(make('account-a', 'I spent €76 at Lidl.', 'conversation-0001'), 'finance.propose_expense').execute('call-1', {});
    const otherConversation = tool(make('account-a', 'Yes.', 'conversation-0002'), 'finance.confirm_expense');
    expect((await otherConversation.execute('call-2', { draftId: draft.id })).isError).toBe(true);
    const reject = tool(make('account-a', `Откажи черновата ${draft.id}`), 'finance.reject_draft');
    expect(textResult(await reject.execute('call-3', { draftId: draft.id } )).status).toBe('rejected');
    expect(finance.rejectExpenseDraft).toHaveBeenCalledWith({ accountId: 'account-a', actorId: 'account-a', draftId: draft.id });
  });

  it('returns backend-calculated totals unchanged', async () => {
    const { finance, make } = setup();
    const expected = await tool(make('account-a', 'Compare spending by category.'), 'finance.summarize_spending').execute('call-1', {});
    expect(textResult(expected)).toEqual(await (finance.summarizeSpending as jest.Mock).mock.results[0].value);
    expect(finance.summarizeSpending).toHaveBeenCalledWith({ accountId: 'account-a', query: {} });
  });
});
