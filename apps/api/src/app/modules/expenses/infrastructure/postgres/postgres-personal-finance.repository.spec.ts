import type { Pool } from 'pg';
import { isoDate, PostgresPersonalFinanceRepository } from './postgres-personal-finance.repository';
import type { ExpenseImportRow } from '../../application/ports/personal-finance.repository';

function importRow(overrides: Partial<ExpenseImportRow> = {}): ExpenseImportRow {
  return {
    date: '2025-01-03', amount: '135.6', currency: 'BGN', amountEur: '69.33117909020723',
    fx: { rate: '1.95583', convention: 'currency_units_per_eur', source: 'legacy-import', effectiveAt: null, provider: null },
    merchantName: 'Nissan', category: 'Fuel', description: 'Nissan', tags: ['petrol'], items: [], liters: '53.59',
    source: { kind: 'legacy-mongo', id: '67d3da2c28b8234d368fe844' }, legacyRecordId: '67d3da2c28b8234d368fe844', ...overrides,
  };
}

describe('PostgresPersonalFinanceRepository safety boundaries', () => {
  it('preserves PostgreSQL calendar dates in east-of-UTC time zones', () => {
    expect(isoDate(new Date(2026, 9, 26))).toBe('2026-10-26');
    expect(isoDate('2026-10-26')).toBe('2026-10-26');
  });

  it('always scopes expense reads by authenticated account id', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new PostgresPersonalFinanceRepository({ query } as unknown as Pool);
    await repo.queryExpenses('account-a', { limit: 10 });
    expect(query.mock.calls[0][0]).toContain('account_id = $1');
    expect(query.mock.calls[0][1][0]).toBe('account-a');
  });

  it('refuses to replace a receipt after the operator has reviewed it', async () => {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM personal_finance.receipts WHERE account_id=$1 AND id=$2 FOR UPDATE')) return { rows: [{ id: 'receipt-1', account_id: 'account-a', draft_id: 'draft-1', expense_id: null, status: 'review_required', user_reviewed_at: '2026-10-28T10:00:00Z', document_deleted_at: null }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const repo = new PostgresPersonalFinanceRepository({ connect: jest.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(repo.replaceReceiptExtraction('account-a', 'account-a', 'receipt-1', {} as any)).resolves.toBeNull();
    expect(statements.some((sql) => sql.startsWith('UPDATE personal_finance.receipts'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('UPDATE personal_finance.expense_drafts'))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('returns account-scoped monthly totals and counts from PostgreSQL', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('to_char(expense_date')) return { rows: [{ month: '2025-10', total: '20.50', count: '2' }] };
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total: '20.50', unconverted: '0' }] };
      if (sql.includes('COUNT(*)::text AS count FROM personal_finance.expenses')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });
    const repo = new PostgresPersonalFinanceRepository({ query } as unknown as Pool);

    await expect(repo.summarize('account-a', {})).resolves.toMatchObject({
      byMonth: [{ month: '2025-10', total: '20.5', count: 2 }],
    });
    const monthlyQuery = query.mock.calls.find(([sql]) => sql.includes('to_char(expense_date'));
    expect(monthlyQuery?.[0]).toContain('account_id=$1');
    expect(monthlyQuery?.[1]).toEqual(['account-a']);
  });

  it('rolls back an import batch when a related line item fails', async () => {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('INSERT INTO personal_finance.expenses')) return { rows: [{ id: 'expense-1' }] };
        if (sql.startsWith('INSERT INTO personal_finance.merchants')) return { rows: [{ id: 'merchant-1' }] };
        if (sql.startsWith('INSERT INTO personal_finance.expense_items')) throw new Error('simulated item persistence failure');
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    const repo = new PostgresPersonalFinanceRepository(pool as unknown as Pool);
    const row = importRow({ items: [{ description: 'Fuel', productCode: null, quantity: '1', unit: 'item', unitPrice: '135.6', discount: '0', tax: '0', lineTotal: '135.6', currency: 'BGN' }] });
    await expect(repo.importExpenses('account-a', 'account-a', [row])).rejects.toThrow('simulated item persistence failure');
    expect(statements).toContain('BEGIN');
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('locks a draft and atomically confirms it into an account-owned expense', async () => {
    const statements: string[] = [];
    const draft = {
      id: 'draft-1', account_id: 'account-a', status: 'proposed', expense_date: '2025-01-03', amount: '76', currency: 'EUR',
      merchant_name: 'Lidl', merchant_id: null, category: 'Groceries', description: 'Purchase at Lidl', tags: [], source_kind: 'assistant-text',
      source_id: 'request-1', extraction_provider: 'local-regex', extraction_model: null, source_content_hash: null,
      confirmed_expense_id: null, created_at: '2025-01-03T10:00:00Z', updated_at: '2025-01-03T10:00:00Z',
    };
    const expense = {
      id: 'expense-1', account_id: 'account-a', expense_date: '2025-01-03', amount: '76', currency: 'EUR', amount_eur: '76',
      fx_rate: null, fx_rate_convention: null, fx_source: null, fx_effective_at: null, fx_provider: null, merchant_id: null,
      merchant_name: 'Lidl', category: 'Groceries', description: 'Purchase at Lidl', tags: [], liters: null,
      source_kind: 'assistant-text', source_id: 'request-1', legacy_record_id: null, confirmed_by: 'account-a',
      confirmed_at: '2025-01-03T10:01:00Z', created_at: '2025-01-03T10:01:00Z', updated_at: '2025-01-03T10:01:00Z',
    };
    const client = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('expense_drafts WHERE account_id=$1 AND id=$2 FOR UPDATE')) return { rows: [draft] };
        if (sql.startsWith('INSERT INTO personal_finance.expenses')) return { rows: [{ id: 'expense-1' }] };
        if (sql.includes('FROM personal_finance.expenses e LEFT JOIN personal_finance.categories c') && sql.includes('WHERE e.account_id=$1 AND e.id=$2 AND e.deleted_at IS NULL')) return { rows: [expense] };
        return { rows: [] };
      }), release: jest.fn(),
    };
    const repo = new PostgresPersonalFinanceRepository({ connect: jest.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(repo.confirmDraft('account-a', 'draft-1', 'account-a')).resolves.toMatchObject({ id: 'expense-1', accountId: 'account-a', amount: '76', amountEur: '76', confirmedBy: 'account-a' });
    expect(statements[0]).toBe('BEGIN');
    expect(statements.find((sql) => sql.includes('FOR UPDATE'))).toContain('account_id=$1');
    expect(statements).toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('records rejection as a terminal state with an account-scoped event', async () => {
    const statements: string[] = [];
    const rejectedDraft = {
      id: 'draft-2', account_id: 'account-a', status: 'rejected', expense_date: '2025-01-03', amount: '76', currency: 'EUR',
      merchant_name: 'Lidl', merchant_id: null, category: 'Groceries', description: 'Purchase at Lidl', tags: [], source_kind: 'assistant-text',
      source_id: 'request-2', extraction_provider: 'local-regex', extraction_model: null, source_content_hash: null,
      confirmed_expense_id: null, created_at: '2025-01-03T10:00:00Z', updated_at: '2025-01-03T10:01:00Z',
    };
    const client = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('UPDATE personal_finance.expense_drafts')) return { rows: [rejectedDraft] };
        return { rows: [] };
      }), release: jest.fn(),
    };
    const repo = new PostgresPersonalFinanceRepository({ connect: jest.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(repo.rejectDraft('account-a', 'draft-2', 'account-a')).resolves.toMatchObject({ id: 'draft-2', status: 'rejected', accountId: 'account-a' });
    expect(statements.find((sql) => sql.startsWith('UPDATE personal_finance.expense_drafts'))).toContain("status IN ('proposed','needs_review')");
    expect(statements.some((sql) => sql.startsWith('INSERT INTO personal_finance.provenance_events'))).toBe(true);
    expect(statements).toContain('COMMIT');
  });

  it('treats an import retry as a duplicate using the database unique key', async () => {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('INSERT INTO personal_finance.expenses')) return { rows: [] };
        return { rows: [] };
      }), release: jest.fn(),
    };
    const repo = new PostgresPersonalFinanceRepository({ connect: jest.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(repo.importExpenses('account-a', 'account-a', [importRow()])).resolves.toEqual({ imported: 0, duplicates: 1 });
    expect(statements.find((sql) => sql.startsWith('INSERT INTO personal_finance.expenses'))).toContain('ON CONFLICT DO NOTHING');
    expect(statements).toContain('COMMIT');
  });

  it('handles concurrent imports of the same legacy id with one durable result', async () => {
    let inserted = false;
    const clients = Array.from({ length: 2 }, () => ({
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('INSERT INTO personal_finance.expenses')) {
          if (inserted) return { rows: [] };
          inserted = true;
          return { rows: [{ id: 'expense-winner' }] };
        }
        if (sql.startsWith('INSERT INTO personal_finance.merchants')) return { rows: [{ id: 'merchant-1' }] };
        return { rows: [] };
      }), release: jest.fn(),
    }));
    let nextClient = 0;
    const pool = { connect: jest.fn(async () => clients[nextClient++]) };
    const repo = new PostgresPersonalFinanceRepository(pool as unknown as Pool);
    const results = await Promise.all([
      repo.importExpenses('account-a', 'account-a', [importRow()]),
      repo.importExpenses('account-a', 'account-a', [importRow()]),
    ]);
    expect(results.reduce((sum, result) => sum + result.imported, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.duplicates, 0)).toBe(1);
    expect(clients.every((client) => client.release.mock.calls.length === 1)).toBe(true);
  });
});
