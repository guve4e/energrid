import { reconcileHistoricalExpenses, type ReconciliationRecord } from './historical-reconciliation';

const mongoRow = (id: string, overrides: Partial<ReconciliationRecord> = {}): ReconciliationRecord => ({
  ownerId: 'mongo-owner', date: '2025-01-03', amount: '135.60', currency: 'BGN', category: 'Fuel',
  description: 'Nissan', tags: ['petrol', 'nissan'], liters: '53.59', sourceKind: 'legacy-mongo',
  sourceId: `mongo:mono.expenses:${id}`, ...overrides,
});

describe('offline historical finance reconciliation', () => {
  it('confirms only a namespaced Mongo source identity and sums original currencies exactly', () => {
    const report = reconcileHistoricalExpenses({
      targetAccountId: 'local-account', mongoOwnerId: 'mongo-owner',
      mongo: [mongoRow('abc', { amount: '135.60' }), mongoRow('def', { amount: '10.20', currency: 'EUR' })],
      postgres: [mongoRow('abc', { ownerId: 'local-account' })],
      leveldb: [{ ...mongoRow('legacy-1', { sourceKind: 'legacy-leveldb', sourceId: 'legacy-1', ownerId: 'local-account' }), amount: '12.30', currency: 'EUR' }],
    });

    expect(report.counts).toMatchObject({ mongo: 2, postgres: 1, leveldb: 1, confirmedSourceDuplicates: 1, possibleDuplicates: 0 });
    expect(report.totalsByOriginalCurrency).toEqual({
      mongo: { BGN: '135.6', EUR: '10.2' }, postgres: { BGN: '135.6' }, leveldb: { EUR: '12.3' },
    });
    expect(report.monthlyTotalsByOriginalCurrency.mongo).toEqual({ '2025-01': { BGN: '135.6', EUR: '10.2' } });
    expect(report.dateRanges.mongo).toEqual({ earliest: '2025-01-03', latest: '2025-01-03' });
    expect(report.dateRanges.mongo).toEqual({ earliest: '2025-01-03', latest: '2025-01-03' });
    expect(report.readyToImport).toBe(true);
  });

  it('flags a conservative full-record candidate for review and never drops it as a duplicate', () => {
    const report = reconcileHistoricalExpenses({
      targetAccountId: 'local-account', mongoOwnerId: 'mongo-owner', mongo: [mongoRow('abc')], postgres: [],
      leveldb: [{ ...mongoRow('legacy-1', { sourceKind: 'legacy-leveldb', sourceId: 'legacy-1', ownerId: 'local-account' }) }],
    });

    expect(report.counts).toMatchObject({ confirmedSourceDuplicates: 0, possibleDuplicates: 1 });
    expect(report.possibleDuplicates[0].reasons).toEqual(expect.arrayContaining(['same-date', 'same-currency', 'same-amount', 'same-description', 'same-category', 'same-tags', 'same-liters']));
    expect(report.readyToImport).toBe(false);
  });

  it('does not flag matching date, amount, and currency alone as a duplicate candidate', () => {
    const report = reconcileHistoricalExpenses({
      targetAccountId: 'local-account', mongoOwnerId: 'mongo-owner', mongo: [mongoRow('abc')], postgres: [],
      leveldb: [{ ...mongoRow('legacy-1', { sourceKind: 'legacy-leveldb', sourceId: 'legacy-1', ownerId: 'local-account', description: 'Different purchase', category: 'Other', tags: [], liters: null }) }],
    });

    expect(report.possibleDuplicates).toEqual([]);
    expect(report.readyToImport).toBe(true);
  });

  it('treats a raw Mongo ID in an unproven LevelDB namespace as a review candidate, not a confirmed duplicate', () => {
    const report = reconcileHistoricalExpenses({
      targetAccountId: 'local-account', mongoOwnerId: 'mongo-owner', mongo: [mongoRow('abc')], postgres: [],
      leveldb: [{ ...mongoRow('abc', { sourceKind: 'legacy-leveldb', sourceId: 'abc', ownerId: 'local-account', amount: '8', description: 'Different' }), legacyRecordId: 'abc' }],
    });

    expect(report.counts).toMatchObject({ confirmedSourceDuplicates: 0, possibleDuplicates: 1 });
    expect(report.possibleDuplicates[0].reasons).toContain('same-raw-source-id-review');
    expect(report.readyToImport).toBe(false);
  });

  it('excludes cross-account rows from totals and blocks the import plan', () => {
    const report = reconcileHistoricalExpenses({
      targetAccountId: 'local-account', mongoOwnerId: 'mongo-owner', mongo: [mongoRow('abc', { ownerId: 'other-mongo-owner' })],
      postgres: [{ ...mongoRow('pg', { ownerId: 'other-account' }) }], leveldb: [],
    });

    expect(report.counts.ownershipMismatches).toBe(2);
    expect(report.totalsByOriginalCurrency).toEqual({ mongo: {}, postgres: {}, leveldb: {} });
    expect(report.readyToImport).toBe(false);
  });

  it('reports malformed rows and blocks import readiness instead of silently omitting them', () => {
    const report = reconcileHistoricalExpenses({
      targetAccountId: 'local-account', mongoOwnerId: 'mongo-owner',
      mongo: [mongoRow('abc', { amount: 'not-money' })], postgres: [], leveldb: [],
    });

    expect(report.counts.validationErrors).toBe(1);
    expect(report.validationErrors[0].reason).toBe('amount must be a valid exact decimal');
    expect(report.totalsByOriginalCurrency.mongo).toEqual({});
    expect(report.readyToImport).toBe(false);
  });

  it('blocks duplicate source identities inside the Mongo export', () => {
    const row = mongoRow('same-id');
    const report = reconcileHistoricalExpenses({ targetAccountId: 'local-account', mongoOwnerId: 'mongo-owner', mongo: [row, row], postgres: [], leveldb: [] });
    expect(report.duplicateMongoSourceIds).toEqual(['mongo:mono.expenses:same-id']);
    expect(report.counts.duplicateMongoSourceIds).toBe(1);
    expect(report.readyToImport).toBe(false);
  });

  it('blocks duplicate source identities inside the Mongo export', () => {
    const row = mongoRow('same-id');
    const report = reconcileHistoricalExpenses({ targetAccountId: 'local-account', mongoOwnerId: 'mongo-owner', mongo: [row, row], postgres: [], leveldb: [] });
    expect(report.duplicateMongoSourceIds).toEqual(['mongo:mono.expenses:same-id']);
    expect(report.counts.duplicateMongoSourceIds).toBe(1);
    expect(report.readyToImport).toBe(false);
  });
});
