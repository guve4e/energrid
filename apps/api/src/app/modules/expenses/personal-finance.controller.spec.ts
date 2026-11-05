import { BadRequestException } from '@nestjs/common';
import { PersonalFinanceController, normalizeV2Import } from './personal-finance.controller';
import type { ReceiptIntelligenceApplication } from './application/receipt-intelligence.application';
import type { PersonalFinanceApplication } from './application/personal-finance.application';
import type { ExpenseRecord } from './domain/personal-finance.types';

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

  const request = { user: { userId: 'account-a' } } as any;
  const raw = (id: string) => ({ _id: id, date: '2025-01-03', amount: '2.50', currency: 'EUR', category: 'Food', description: 'Groceries' });

  it('returns only PostgreSQL records and passes pagination filters to the application', async () => {
    const rows = [{ id: 'pg-1', date: '2025-01-03', amount: '12.00' }];
    const finance = { queryExpenses: jest.fn().mockResolvedValue(rows) } as unknown as PersonalFinanceApplication;
    const controller = new PersonalFinanceController(finance, {} as never);
    await expect(controller.query({ limit: '50', categoryId: 'food-id', before: '2025-02-01' }, request))
      .resolves.toEqual({ expenses: rows });
    expect(finance.queryExpenses).toHaveBeenCalledWith({ accountId: 'account-a', query: expect.objectContaining({
      limit: 50, categoryId: 'food-id', before: '2025-02-01',
    }) });
  });

  it('reads the same account-scoped summary as the Assistant without a legacy bridge', async () => {
    const summary = { currency: 'EUR', total: '12.30', transactionCount: 2, excludedUnconvertedCount: 0,
      dailyAverage: '0.40', byMonth: [{ month: '2025-01', total: '12.30', count: 2 }], byCategory: [], byMerchant: [], byProduct: [] };
    const finance = { summarizeSpending: jest.fn().mockResolvedValue(summary) } as unknown as PersonalFinanceApplication;
    const controller = new PersonalFinanceController(finance, {} as never);
    await expect(controller.summary({ fromDate: '2025-01-01', toDate: '2025-01-31' }, request)).resolves.toEqual(summary);
    expect(finance.summarizeSpending).toHaveBeenCalledWith({ accountId: 'account-a', query: {
      fromDate: '2025-01-01', toDate: '2025-01-31',
    } });
  });

  it('previews duplicates only against PostgreSQL and within the incoming batch', async () => {
    const finance = { findImportedLegacyIds: jest.fn().mockResolvedValue(['pg-duplicate']) } as unknown as PersonalFinanceApplication;
    const controller = new PersonalFinanceController(finance, {} as never);
    const preview = await controller.previewImport({ records: [raw('pg-duplicate'), raw('new-source'), raw('new-source')] }, request);
    expect(preview).toMatchObject({ total: 3, valid: 1, duplicates: 2, errors: [] });
    expect(preview.records[0].source.id).toBe('mongo:mono.expenses:new-source');
    expect(finance.findImportedLegacyIds).toHaveBeenCalledWith('account-a', expect.arrayContaining(['pg-duplicate', 'new-source']));
  });

  it('rechecks PostgreSQL at commit time and never reimports an existing source', async () => {
    const finance = {
      findImportedLegacyIds: jest.fn().mockResolvedValue(['pg-duplicate']),
      importExpenses: jest.fn().mockResolvedValue({ imported: 1, duplicates: 0 }),
    } as unknown as PersonalFinanceApplication;
    const controller = new PersonalFinanceController(finance, {} as never);
    const result = await controller.import({ records: [raw('pg-duplicate'), raw('new-source'), raw('new-source')] }, request);
    expect(result).toEqual({ imported: 1, duplicates: 2 });
    expect(finance.importExpenses).toHaveBeenCalledWith('account-a', 'account-a', [expect.objectContaining({
      legacyRecordId: 'new-source', source: expect.objectContaining({ id: 'mongo:mono.expenses:new-source' }),
    })]);
  });
});

describe('receipt re-extraction route', () => {
  it('requires explicit cloud consent and returns the same account-scoped draft without storage paths', async () => {
    const receipts = { reextract: jest.fn().mockResolvedValue({
      draft: { id: 'draft-1', receipts: [{ id: 'receipt-1', storageKey: 'private/account/file.jpg' }] },
      receipt: { id: 'receipt-1', storageKey: 'private/account/file.jpg' },
      reconciliation: { matched: false }, extractionDiagnostics: { modelItemCount: 3 },
    }) } as unknown as ReceiptIntelligenceApplication;
    const controller = new PersonalFinanceController({} as any, receipts);
    const request = { user: { userId: 'account-a' } } as any;
    await expect(controller.reextractReceipt('receipt-1', false, request)).rejects.toThrow(/explicitly consent/i);
    const result = await controller.reextractReceipt('receipt-1', true, request);
    expect(result).toMatchObject({ draft: { id: 'draft-1', receipts: [{ id: 'receipt-1' }] }, receipt: { id: 'receipt-1' } });
    expect(result.receipt).not.toHaveProperty('storageKey');
    expect(result.draft.receipts[0]).not.toHaveProperty('storageKey');
    expect((receipts.reextract as jest.Mock)).toHaveBeenCalledWith({ accountId: 'account-a', actorId: 'account-a' }, 'receipt-1', true);
  });
});


describe('Personal Finance expense partial updates', () => {
  const request = { user: { userId: 'account-a' } } as any;
  const existing: ExpenseRecord = {
    id: 'expense-1', accountId: 'account-a', date: '2025-01-03',
    amount: '135.6', currency: 'BGN', amountEur: '69.33117909020723',
    fx: { rate: '1.95583', convention: 'currency_units_per_eur', source: 'legacy-import', effectiveAt: '2025-01-03', provider: null },
    merchantId: null, merchantName: 'Fuel station', category: 'Fuel', categoryId: 'category-1',
    description: 'Old description', tags: ['car'], items: [], liters: '53.59',
    sourceKind: 'legacy-mongo', sourceId: 'mongo:mono.expenses:expense-1',
    createdAt: '2025-01-03T12:00:00.000Z', updatedAt: '2025-01-03T12:00:00.000Z',
    confirmedBy: 'account-a', confirmedAt: '2025-01-03T12:00:00.000Z',
  };

  function controllerFor(record: ExpenseRecord = existing) {
    const finance = {
      getExpense: jest.fn().mockResolvedValue(record),
      updateExpense: jest.fn().mockResolvedValue(record),
      createExpense: jest.fn(),
    } as unknown as PersonalFinanceApplication;
    return { controller: new PersonalFinanceController(finance, {} as ReceiptIntelligenceApplication), finance };
  }

  it('preserves all financial and fuel fields when only the description changes', async () => {
    const { controller, finance } = controllerFor();
    await expect(controller.update(existing.id, { description: 'New description' }, request))
      .resolves.toEqual({ expense: existing });
    expect(finance.updateExpense).toHaveBeenCalledWith('account-a', 'account-a', existing.id, expect.objectContaining({
      description: 'New description', amount: existing.amount, amountEur: existing.amountEur,
      currency: existing.currency, fx: existing.fx, liters: existing.liters,
      categoryId: existing.categoryId, items: existing.items,
      source: { kind: existing.sourceKind, id: existing.sourceId },
    }));
  });

  it('preserves imported EUR values even when the source has no FX rate', async () => {
    const record = { ...existing, fx: null };
    const { controller, finance } = controllerFor(record);
    await controller.update(record.id, { category: 'Transport' }, request);
    expect(finance.updateExpense).toHaveBeenCalledWith('account-a', 'account-a', record.id, expect.objectContaining({
      amount: record.amount, amountEur: record.amountEur, fx: null, liters: record.liters,
    }));
  });

  it('recalculates converted EUR only for changed financial values and records user FX corrections', async () => {
    const record = { ...existing, amount: '20', currency: 'USD', amountEur: '10',
      fx: { ...existing.fx!, rate: '2', source: 'provider-import' } };
    const { controller, finance } = controllerFor(record);
    await controller.update(record.id, { amount: '30', fxRate: '1.5' }, request);
    expect(finance.updateExpense).toHaveBeenCalledWith('account-a', 'account-a', record.id, expect.objectContaining({
      amount: '30', amountEur: '20', liters: record.liters,
      fx: expect.objectContaining({ rate: '1.5', source: 'user-entered', provider: null, effectiveAt: null }),
    }));
  });

  it('clears fuel volume and FX only when explicitly requested', async () => {
    const { controller, finance } = controllerFor();
    await controller.update(existing.id, { liters: null, fxRate: null }, request);
    expect(finance.updateExpense).toHaveBeenCalledWith('account-a', 'account-a', existing.id, expect.objectContaining({
      amount: existing.amount, liters: null, fx: null, amountEur: null,
    }));
  });

  it('still requires an amount for a newly created expense', async () => {
    const { controller, finance } = controllerFor();
    await expect(controller.create({ date: '2026-11-05', description: 'Missing amount' }, request))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(finance.createExpense).not.toHaveBeenCalled();
  });
});
