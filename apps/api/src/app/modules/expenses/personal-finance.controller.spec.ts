import { ServiceUnavailableException } from '@nestjs/common';
import { PersonalFinanceController, normalizeV2Import } from './personal-finance.controller';
import type { PersonalFinanceApplication } from './application/personal-finance.application';
import type { PersonalExpenseStore } from './personal-expense.store';

describe('Personal Finance historical import normalization', () => {
  it('retains legacy Mongo money and FX values as exact decimals', () => {
    expect(normalizeV2Import({
      _id: { $oid: '67d3da2c28b8234d368fe844' },
      date: { $date: '2025-01-03T00:00:00.000Z' }, amount: 135.6, currency: 'BGN',
      amountEur: 69.33117909020723, fxRate: 1.95583, category: 'Fuel', description: 'Nissan',
    })).toMatchObject({
      date: '2025-01-03', amount: '135.6', currency: 'BGN', amountEur: '69.33117909020723',
      fx: { rate: '1.95583', source: 'legacy-import' }, source: { id: 'mongo:mono.expenses:67d3da2c28b8234d368fe844', kind: 'legacy-mongo' },
    });
  });

  it('leaves a historical BGN conversion unavailable when the source has no stored FX data', () => {
    expect(normalizeV2Import({
      _id: { $oid: '67d3da2c28b8234d368fe844' }, date: '2025-01-03', amount: '135.6', currency: 'BGN',
      category: 'Fuel', description: 'Nissan',
    })).toMatchObject({ amount: '135.6', currency: 'BGN', amountEur: null, fx: null });
  });

  it('fails closed on malformed values and entries without stable import identity', () => {
    expect(() => normalizeV2Import({ date: '2025-01-03', amount: '1.0010000000000000001', currency: 'EUR', category: 'Other', description: 'Example', _id: 'legacy-1' })).toThrow(/precision/);
    expect(() => normalizeV2Import({ date: '2025-01-03', amount: '1', currency: 'EUR', category: 'Other', description: 'Example' })).toThrow(/safe retries/);
  });

  it('round-trips preview records without losing source IDs, source kind, or FX provenance', () => {
    const first = normalizeV2Import({
      _id: { $oid: '67d3da2c28b8234d368fe844' }, date: '2025-01-03', amount: '135.6', currency: 'BGN',
      amountEur: '69.33117909020723', fxRate: '1.95583', category: 'Fuel', description: 'Nissan', tags: ['petrol'],
      createdAt: { $date: '2025-03-14T07:26:36.802Z' },
    });
    const repeated = normalizeV2Import(first);
    expect(repeated).toMatchObject({
      date: '2025-01-03', amount: '135.6', currency: 'BGN', amountEur: '69.33117909020723',
      fx: { rate: '1.95583', source: 'legacy-import' }, tags: ['petrol'],
      source: { kind: 'legacy-mongo', id: 'mongo:mono.expenses:67d3da2c28b8234d368fe844' },
      sourceCreatedAt: '2025-03-14T07:26:36.802Z',
    });
  });

  it('keeps unmigrated LevelDB entries visible once and suppresses them after import', async () => {
    const old = {
      id: 'leveldb-1', legacyRecordId: 'legacy-source-1', date: '2025-01-03', amount: 135.6, currency: 'BGN',
      amountEur: 69.33117909020723, fxRate: 1.95583, category: 'Fuel', description: 'Nissan', tags: ['petrol'], liters: 53.59,
      createdAt: '2025-03-14T07:26:36.802Z', updatedAt: '2025-03-14T07:26:36.802Z',
    };
    const finance = {
      queryExpenses: jest.fn().mockResolvedValue([]),
      findImportedLegacyIds: jest.fn().mockResolvedValue([]),
    } as unknown as PersonalFinanceApplication;
    const legacy = { list: jest.fn().mockResolvedValue([old]) } as unknown as PersonalExpenseStore;
    const controller = new PersonalFinanceController(finance, legacy);
    const request = { user: { userId: 'account-a' } } as any;

    expect((await controller.query({ limit: '100' }, request)).expenses).toMatchObject([
      { id: 'leveldb-1', date: '2025-01-03', amount: '135.6', currency: 'BGN', amountEur: '69.33117909020723', fx: { rate: '1.95583' }, category: 'Fuel', description: 'Nissan', tags: ['petrol'], liters: '53.59', legacyRecordId: 'legacy-source-1', legacyReadOnly: true },
    ]);
    (finance.findImportedLegacyIds as jest.Mock).mockResolvedValue(['legacy-source-1']);
    expect((await controller.query({ limit: '100' }, request)).expenses).toEqual([]);
  });

  it('previews source duplicates across LevelDB and PostgreSQL before confirmation', async () => {
    const finance = {
      findImportedLegacyIds: jest.fn().mockResolvedValue(['pg-duplicate']),
    } as unknown as PersonalFinanceApplication;
    const legacy = { list: jest.fn().mockResolvedValue([{ legacyRecordId: 'leveldb-duplicate' }]) } as unknown as PersonalExpenseStore;
    const controller = new PersonalFinanceController(finance, legacy);
    const request = { user: { userId: 'account-a' } } as any;
    const raw = (id: string) => ({ _id: id, date: '2025-01-03', amount: '2.50', currency: 'EUR', category: 'Food', description: 'Groceries' });
    const preview = await controller.previewImport({ records: [raw('leveldb-duplicate'), raw('pg-duplicate'), raw('new-source')] }, request);
    expect(preview).toMatchObject({ total: 3, valid: 1, duplicates: 2, errors: [] });
    expect(preview.records[0].source.id).toBe('mongo:mono.expenses:new-source');
  });

  it('rechecks both stores at import confirmation to avoid stale-preview duplicates', async () => {
    const finance = {
      findImportedLegacyIds: jest.fn().mockResolvedValue(['pg-duplicate']),
      importExpenses: jest.fn().mockResolvedValue({ imported: 1, duplicates: 0 }),
    } as unknown as PersonalFinanceApplication;
    const legacy = { list: jest.fn().mockResolvedValue([{ legacyRecordId: 'leveldb-duplicate' }]) } as unknown as PersonalExpenseStore;
    const controller = new PersonalFinanceController(finance, legacy);
    const request = { user: { userId: 'account-a' } } as any;
    const raw = (id: string) => ({ _id: id, date: '2025-01-03', amount: '2.50', currency: 'EUR', category: 'Food', description: 'Groceries' });
    const result = await controller.import({ records: [raw('leveldb-duplicate'), raw('pg-duplicate'), raw('new-source')] }, request);
    expect(result).toEqual({ imported: 1, duplicates: 2 });
    expect((finance.importExpenses as jest.Mock).mock.calls[0][2]).toHaveLength(1);
  });

  it('keeps PostgreSQL expenses queryable while marking LevelDB coverage unavailable', async () => {
    const postgresExpense = { id: 'pg-1', date: '2026-10-01', amount: '12.00' };
    const finance = {
      queryExpenses: jest.fn().mockResolvedValue([postgresExpense]),
      findImportedLegacyIds: jest.fn().mockResolvedValue([]),
    } as unknown as PersonalFinanceApplication;
    const legacy = { list: jest.fn().mockRejectedValue(new Error('Database is not open')) } as unknown as PersonalExpenseStore;
    const controller = new PersonalFinanceController(finance, legacy);

    await expect(controller.query({}, { user: { userId: 'account-a' } } as any)).resolves.toMatchObject({
      expenses: [postgresExpense],
      legacyCoverage: 'leveldb-unavailable',
    });
  });

  it('marks PostgreSQL summaries incomplete when LevelDB is unavailable', async () => {
    const finance = {
      summarizeSpending: jest.fn().mockResolvedValue({
        total: '12.00', transactionCount: 1, excludedUnconvertedCount: 0, byCategory: [],
      }),
      findImportedLegacyIds: jest.fn().mockResolvedValue([]),
    } as unknown as PersonalFinanceApplication;
    const legacy = { list: jest.fn().mockRejectedValue(new Error('Database is not open')) } as unknown as PersonalExpenseStore;
    const controller = new PersonalFinanceController(finance, legacy);

    await expect(controller.summary({}, { user: { userId: 'account-a' } } as any)).resolves.toMatchObject({
      total: '12.00', transactionCount: 1, legacyCoverage: 'leveldb-unavailable',
    });
  });

  it('orders the combined category summary by exact EUR total for the dashboard', async () => {
    const finance = {
      summarizeSpending: jest.fn().mockResolvedValue({
        total: '15', transactionCount: 2, excludedUnconvertedCount: 0,
        byMonth: [{ month: '2025-01', total: '15', count: 2 }],
        byCategory: [
          { category: 'Groceries', total: '10', count: 1 },
          { category: 'Fuel', total: '5', count: 1 },
        ],
      }),
      findImportedLegacyIds: jest.fn().mockResolvedValue([]),
    } as unknown as PersonalFinanceApplication;
    const legacy = { list: jest.fn().mockResolvedValue([
      { legacyRecordId: 'legacy-1', date: '2025-01-03', amountEur: '15', category: 'Fuel' },
    ]) } as unknown as PersonalExpenseStore;
    const controller = new PersonalFinanceController(finance, legacy);

    await expect(controller.summary({ fromDate: '2025-01-01', toDate: '2025-01-31' }, { user: { userId: 'account-a' } } as any)).resolves.toMatchObject({
      total: '30', dailyAverage: '0.97',
      byMonth: [{ month: '2025-01', total: '30', count: 3 }],
      byCategory: [
        { category: 'Fuel', total: '20', count: 2 },
        { category: 'Groceries', total: '10', count: 1 },
      ],
    });
  });

  it('fails closed on import duplicate checks when LevelDB is unavailable', async () => {
    const finance = {
      findImportedLegacyIds: jest.fn(),
      importExpenses: jest.fn(),
    } as unknown as PersonalFinanceApplication;
    const legacy = { list: jest.fn().mockRejectedValue(new Error('Database is not open')) } as unknown as PersonalExpenseStore;
    const controller = new PersonalFinanceController(finance, legacy);
    const request = { user: { userId: 'account-a' } } as any;
    const records = [{ _id: 'source-1', date: '2025-01-03', amount: '2.50', currency: 'EUR', category: 'Food', description: 'Groceries' }];

    await expect(controller.previewImport({ records }, request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.import({ records }, request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(finance.importExpenses).not.toHaveBeenCalled();
  });
});
