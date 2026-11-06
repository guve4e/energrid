'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FORMAT, TABLES, argsOf, addDecimals, sameDecimalValue, dateOnly, exportSummary, validatePayload, remapRow, categoriesParentFirst, samePortableRecord, validateTableCompatibility } = require('./personal-finance-transfer');

const source = '14b5f407-c477-4a2f-9205-b433e9ef5fb4';
const target = '00000000-0000-4000-8000-000000000001';

function payload(overrides = {}) {
  const tables = Object.fromEntries(TABLES.map((table) => [table, []]));
  tables.expenses = [{ id: '00000000-0000-4000-8000-000000000002', account_id: source, amount: '0.1', amount_eur: '0.100000000000000001', currency: 'EUR', deleted_at: null, source_kind: 'manual', source_id: null, expense_date: '2026-10-01' }];
  return { format: FORMAT, source: { database: 'energrid_auth_local', accountId: source }, tables, attachments: [], ...overrides };
}

test('adds decimal strings without floating-point rounding', () => {
  assert.equal(addDecimals('26888.7739144506427992', '0.0000000000000008'), '26888.7739144506428');
  assert.equal(addDecimals('73.10', '-2.56'), '70.54');
  assert.equal(sameDecimalValue('69.331179090207230000', '69.33117909020723'), true);
});

test('preserves local calendar dates instead of converting PostgreSQL DATE through UTC', () => {
  const localDate = new Date(2026, 9, 27);
  assert.equal(dateOnly(localDate), '2026-10-27');
  assert.equal(dateOnly('2026-10-27'), '2026-10-27');
});

test('parses explicit dry-run and apply flags without accepting flag values', () => {
  assert.equal(argsOf(['--dry-run'])['dry-run'], true);
  assert.equal(argsOf(['--apply']).apply, true);
  assert.throws(() => argsOf(['--dry-run=false']), /does not accept a value/);
});

test('summarizes active, deleted, currency and exact EUR values', () => {
  const data = payload();
  data.tables.expenses.push({ ...data.tables.expenses[0], id: '00000000-0000-4000-8000-000000000003', amount: '9.50', amount_eur: '9.50', currency: 'BGN', deleted_at: '2026-10-02' });
  assert.deepEqual(exportSummary(data), {
    totalExpenses: 2, activeCount: 1, deletedCount: 1, activeEur: '0.100000000000000001',
    currencies: { EUR: { activeCount: 1, deletedCount: 0, activeOriginalTotal: '0.1', deletedOriginalTotal: '0', originalTotal: '0.1' }, BGN: { activeCount: 0, deletedCount: 1, activeOriginalTotal: '0', deletedOriginalTotal: '9.5', originalTotal: '9.5' } },
    relatedRecordCounts: { merchants: 0, categories: 0, expense_items: 0, expense_drafts: 0, expense_draft_items: 0, receipts: 0, provenance_events: 0, category_events: 0 },
  });
});

test('validates account scope and rejects duplicated stable source identifiers', () => {
  const good = payload();
  assert.equal(validatePayload(good), source);
  const crossAccount = payload(); crossAccount.tables.expenses[0].account_id = target;
  assert.throws(() => validatePayload(crossAccount), /outside the exported account/);
  const duplicate = payload(); duplicate.tables.expenses.push({ ...duplicate.tables.expenses[0], id: '00000000-0000-4000-8000-000000000004', source_kind: 'mongo', source_id: 'same' }); duplicate.tables.expenses[0].source_kind = 'mongo'; duplicate.tables.expenses[0].source_id = 'same';
  assert.throws(() => validatePayload(duplicate), /Duplicate stable source identifier/);
});

test('maps account ownership and finance relationships while preserving exact amounts', () => {
  const maps = { merchants: new Map(), categories: new Map([['cat-old', 'cat-new']]), expenses: new Map(), drafts: new Map([['draft-old', 'draft-new']]), receipts: new Map([['receipt-old', 'receipt-new']]) };
  const row = remapRow({ account_id: source, amount: '0.123456789012345678', confirmed_by: source, category_id: 'cat-old', draft_id: 'draft-old', source_receipt_id: 'receipt-old' }, source, target, maps);
  assert.equal(row.account_id, target);
  assert.equal(row.confirmed_by, target);
  assert.equal(row.amount, '0.123456789012345678');
  assert.equal(row.category_id, 'cat-new');
  assert.equal(row.draft_id, 'draft-new');
  assert.equal(row.source_receipt_id, 'receipt-new');
});

test('orders category parents before children and rejects cycles', () => {
  const root = { id: 'root', parent_id: null }; const child = { id: 'child', parent_id: 'root' };
  assert.deepEqual(categoriesParentFirst([child, root]).map((row) => row.id), ['root', 'child']);
  assert.throws(() => categoriesParentFirst([{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }]), /cycle/);
});

test('rejects destination schema requirements that the export cannot supply', () => {
  const columns = new Map([
    ['id', { is_nullable: 'NO', column_default: null, is_identity: 'NO', is_generated: 'NEVER' }],
    ['account_id', { is_nullable: 'NO', column_default: null, is_identity: 'NO', is_generated: 'NEVER' }],
    ['new_required', { is_nullable: 'NO', column_default: null, is_identity: 'NO', is_generated: 'NEVER' }],
    ['with_default', { is_nullable: 'NO', column_default: "'ok'::text", is_identity: 'NO', is_generated: 'NEVER' }],
  ]);
  assert.throws(() => validateTableCompatibility('expenses', [{ id: 'x', account_id: target }], columns), /required expenses\.new_required/);
  assert.throws(() => validateTableCompatibility('expenses', [{ id: 'x', account_id: target, absent: true }], columns), /expenses\.absent is missing/);
  assert.doesNotThrow(() => validateTableCompatibility('expenses', [{ id: 'x', account_id: target, new_required: 'supplied' }], columns));
});

test('detects identical retries while refusing changed rows', () => {
  const row = { id: 'x', amount: '1.00', deleted_at: null, tags: ['a'] };
  assert.equal(samePortableRecord(row, { ...row }), true);
  assert.equal(samePortableRecord(row, { ...row, amount: '1.01' }), false);
});
