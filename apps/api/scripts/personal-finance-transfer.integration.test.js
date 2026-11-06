'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { FORMAT, TABLES } = require('./personal-finance-transfer');

const databaseUrl = process.env.FINANCE_TRANSFER_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const source = '14b5f407-c477-4a2f-9205-b433e9ef5fb4';
const target = '00000000-0000-4000-8000-000000000101';
const other = '00000000-0000-4000-8000-000000000102';
const empty = '00000000-0000-4000-8000-000000000103';
const merchantSource = '00000000-0000-4000-8000-000000000201';
const categorySourceId = '00000000-0000-4000-8000-000000000200';
const expenseExistingId = '00000000-0000-4000-8000-000000000301';
const expenseSourceId = '00000000-0000-4000-8000-000000000302';
const expenseDeletedId = '00000000-0000-4000-8000-000000000303';
const draftId = '00000000-0000-4000-8000-000000000401';
const receiptId = '00000000-0000-4000-8000-000000000501';
const itemId = '00000000-0000-4000-8000-000000000601';
const draftItemId = '00000000-0000-4000-8000-000000000602';
const provenanceId = '00000000-0000-4000-8000-000000000701';
const categoryEventId = '00000000-0000-4000-8000-000000000801';

function runSeed(input, account, mode, receiptRoot, env) {
  return spawnSync(process.execPath, [path.join(__dirname, 'personal-finance-transfer.js'), 'seed', '--input', input, '--account-id', account, '--expected-database', new URL(databaseUrl).pathname.slice(1), mode], {
    encoding: 'utf8', env: { ...process.env, FINANCE_SEED_DATABASE_URL: databaseUrl, PERSONAL_FINANCE_RECEIPTS_DIR: receiptRoot, ...env },
  });
}

function lastJson(text) {
  const at = text.indexOf('{\n');
  return at < 0 ? null : JSON.parse(text.slice(at));
}

function fixturePayload(category, bytes, sourceItems = true) {
  const now = '2026-10-27T12:00:00.000Z';
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const tables = Object.fromEntries(TABLES.map((table) => [table, []]));
  tables.merchants = [{ id: merchantSource, account_id: source, name: 'Lidl', normalized_name: 'lidl', aliases: ['lidl'], created_at: now, updated_at: now }];
  tables.categories = [category];
  const baseExpense = {
    account_id: source, expense_date: '2026-10-27', amount: '135.600000000000000000', currency: 'BGN', amount_eur: '69.331179090207230000', fx_rate: '1.955830000000000000', fx_rate_convention: 'currency_units_per_eur', fx_source: 'historical', fx_effective_at: now, fx_provider: 'stored', merchant_id: merchantSource, merchant_name: 'Lidl', category: 'Groceries', description: 'Nissan fuel', tags: ['petrol', 'nissan'], liters: '53.590000000000000000', source_kind: 'legacy-mongo', source_id: 'mongo:mono.expenses:fixture-active', legacy_record_id: 'mongo:mono.expenses:fixture-active', source_created_at: now, source_updated_at: now, confirmed_by: source, confirmed_at: now, created_at: now, updated_at: now, deleted_at: null, category_id: category.id,
  };
  tables.expenses = [
    { ...baseExpense, id: '00000000-0000-4000-8000-000000000302' },
    { ...baseExpense, id: expenseDeletedId, expense_date: '2026-09-01', amount: '10.000000000000000000', currency: 'EUR', amount_eur: '10.000000000000000000', fx_rate: null, fx_rate_convention: null, fx_source: null, fx_effective_at: null, fx_provider: null, liters: null, source_id: 'legacy-deleted-2', legacy_record_id: 'legacy-deleted-2', deleted_at: '2026-10-28T00:00:00.000Z' },
  ];
  tables.expense_drafts = [{ id: draftId, account_id: source, status: 'needs_review', expense_date: '2026-10-27', amount: '70.54', currency: 'EUR', merchant_name: 'Lidl', merchant_id: merchantSource, category: 'Groceries', description: 'Receipt draft', tags: [], source_kind: 'receipt', source_id: `receipt:sha256:${hash}`, extraction_provider: 'fixture', extraction_model: null, source_content_hash: hash, confirmed_expense_id: null, created_at: now, updated_at: now, expires_at: null }];
  tables.receipts = [{ id: receiptId, account_id: source, draft_id: draftId, expense_id: null, content_hash: hash, media_type: 'image/jpeg', byte_length: bytes.length, storage_key: `${source}/${receiptId}.jpg`, status: 'review_required', extracted_totals: { total: '70.54', currency: 'EUR' }, parser_provider: 'fixture', parser_model: null, created_at: now, extraction_schema_version: 'v1', document_type: 'receipt', source_text: null, extraction_result: null, extraction_warnings: [], user_reviewed_at: null, reviewed_as_total_only: false, document_deleted_at: null, reviewed_adjustments: null, reviewed_total: null, reviewed_currency: null }];
  if (sourceItems) {
    tables.expense_items = [{ id: itemId, account_id: source, expense_id: expenseSourceId, description: 'Fuel', product_code: null, quantity: '1', unit: 'each', unit_price: '135.60', discount: '0', tax: '0', line_total: '135.60', currency: 'BGN', source_receipt_id: null, created_at: now, normalized_description: 'Fuel', packaging: null, tax_included: false, category_id: category.id, extraction_provenance: { source: 'fixture' } }];
    tables.expense_draft_items = [{ id: draftItemId, account_id: source, draft_id: draftId, description: 'Groceries', product_code: null, quantity: '1', unit: 'each', unit_price: '70.54', discount: '0', tax: '0', line_total: '70.54', currency: 'EUR', source_receipt_id: receiptId, normalized_description: 'Groceries', packaging: null, tax_included: false, category_id: category.id, extraction_provenance: { source: 'fixture' } }];
  }
  tables.provenance_events = [{ id: provenanceId, account_id: source, expense_id: expenseSourceId, draft_id: null, receipt_id: null, event_type: 'expense.imported', actor_user_id: source, source_kind: 'legacy-mongo', source_id: 'mongo:mono.expenses:fixture-active', provider: null, model: null, content_hash: null, details: { import: 'fixture' }, occurred_at: now }];
  tables.category_events = [{ id: categoryEventId, account_id: source, category_id: category.id, actor_user_id: source, event_type: 'category.created', details: {}, occurred_at: now }];
  return { format: FORMAT, exportedAt: now, source: { database: 'energrid_auth_local', accountId: source }, tables, attachments: [{ receiptId, contentHash: hash, mediaType: 'image/jpeg', byteLength: bytes.length, status: 'included', bundleFile: `${receiptId}.jpg` }], summary: {} };
}

function freshCopy(payload) {
  const copy = structuredClone(payload);
  const idMap = new Map();
  for (const table of TABLES) for (const row of copy.tables[table]) idMap.set(row.id, crypto.randomUUID());
  const foreignKeys = ['parent_id', 'merchant_id', 'category_id', 'expense_id', 'confirmed_expense_id', 'draft_id', 'receipt_id', 'source_receipt_id'];
  for (const table of TABLES) for (const row of copy.tables[table]) {
    row.id = idMap.get(row.id);
    for (const key of foreignKeys) if (row[key]) row[key] = idMap.get(row[key]) || row[key];
    if (table === 'expenses' && row.source_id) row.source_id += ':fresh';
    if (table === 'expenses' && row.legacy_record_id) row.legacy_record_id += ':fresh';
    if (table === 'expense_drafts' && row.source_id) row.source_id += ':fresh';
    if (table === 'receipts') row.storage_key = `${source}/${row.id}.jpg`;
  }
  copy.attachments = copy.attachments.map((a) => ({ ...a, receiptId: idMap.get(a.receiptId), bundleFile: `${idMap.get(a.receiptId)}.jpg` }));
  copy.summary = {};
  return copy;
}

integration('Finance seed imports transactionally, maps account references, skips exact retries and preserves exact totals', { timeout: 60000 }, async () => {
  const parsed = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname), 'integration DB must be loopback');
  assert.match(parsed.pathname.slice(1), /^energrid_finance_transfer_test_[a-z0-9_]+$/i, 'integration DB must have the disposable test prefix');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-seed-integration-'));
  const receiptRoot = path.join(temp, 'private-receipts');
  fs.mkdirSync(receiptRoot, { mode: 0o700 });
  try {
    const c = await pool.connect();
    let createdSchemas = false;
    try {
      const identity = await c.query('SELECT current_database() db, inet_server_addr()::text host');
      assert.equal(identity.rows[0].db, parsed.pathname.slice(1));
      assert.ok(['127.0.0.1/32', '::1/128'].includes(identity.rows[0].host));
      const existing = await c.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('auth','personal_finance')");
      assert.equal(existing.rowCount, 0, 'disposable test database must be empty before setup');
      await c.query('CREATE SCHEMA auth');
      createdSchemas = true;
      await c.query('CREATE TABLE auth.users(id uuid PRIMARY KEY)');
      await c.query('INSERT INTO auth.users(id) VALUES($1),($2),($3)', [target, other, empty]);
      const migrationFiles = [
        '1793098041000_personal-finance-v2.js',
        '1793188800000_personal-finance-categories.js',
        '1793275200000_personal-finance-receipt-intelligence-v1.js',
        '1793361600000_personal-finance-reviewed-receipt-total-v1-1.js',
      ];
      for (const file of migrationFiles) {
        const statements = [];
        require(path.resolve(__dirname, '../../core/migrations', file)).up({ sql: (sql) => statements.push(sql) });
        for (const sql of statements) await c.query(sql);
      }

      const targetCategory = (await c.query("SELECT * FROM personal_finance.categories WHERE account_id=$1 AND name='Groceries'", [target])).rows[0];
      const sourceCategory = { id: categorySourceId, account_id: source, name: 'Groceries', description: null, parent_id: null, archived_at: null, created_at: '2026-10-27T12:00:00.000Z', updated_at: '2026-10-27T12:00:00.000Z' };
      const targetMerchantId = '00000000-0000-4000-8000-000000000202';
      const now = '2026-10-27T12:00:00.000Z';
      await c.query('INSERT INTO personal_finance.merchants(id,account_id,name,normalized_name,aliases,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)', [targetMerchantId, target, 'Lidl', 'lidl', ['lidl'], now]);
      await c.query(`INSERT INTO personal_finance.expenses(id,account_id,expense_date,amount,currency,amount_eur,fx_rate,fx_rate_convention,fx_source,fx_effective_at,fx_provider,merchant_id,merchant_name,category,description,tags,liters,source_kind,source_id,legacy_record_id,source_created_at,source_updated_at,confirmed_by,confirmed_at,created_at,updated_at,deleted_at,category_id)
        VALUES($1,$2,'2026-10-27','135.600000000000000000','BGN','69.331179090207230000','1.955830000000000000','currency_units_per_eur','historical',$3,'stored',$4,'Lidl','Groceries','Nissan fuel',ARRAY['petrol','nissan'],'53.590000000000000000','legacy-mongo','mongo:mono.expenses:fixture-active','mongo:mono.expenses:fixture-active',$3,$3,$2,$3,$3,$3,NULL,$5)`, [expenseExistingId, target, now, targetMerchantId, targetCategory.id]);

      const bytes = Buffer.from('synthetic receipt image for integration test');
      const payload = fixturePayload(sourceCategory, bytes);
      const input = path.join(temp, 'export.json');
      fs.writeFileSync(input, JSON.stringify(payload), { mode: 0o600 });
      const bundle = `${input}.attachments`; fs.mkdirSync(bundle, { mode: 0o700 });
      fs.writeFileSync(path.join(bundle, `${receiptId}.jpg`), bytes, { mode: 0o600 });

      const dry = runSeed(input, target, '--dry-run', receiptRoot);
      assert.equal(dry.status, 0, dry.stderr);
      const dryJson = lastJson(dry.stdout);
      assert.equal(dryJson.source.totalExpenses, 2);
      assert.equal(dryJson.source.deletedCount, 1);
      assert.equal(dryJson.planned.expenses.present, 1);
      assert.equal(dryJson.planned.expenses.inserted, 1);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expenses WHERE account_id=$1', [target])).rows[0].n, 1, 'dry-run must rollback all database writes');
      assert.equal(fs.existsSync(path.join(receiptRoot, target, `${receiptId}.jpg`)), false, 'dry-run must not install receipt files');

      const apply = runSeed(input, target, '--apply', receiptRoot);
      assert.equal(apply.status, 0, apply.stderr);
      const applied = lastJson(apply.stdout);
      assert.equal(applied.importedRecordsVerified.total, 2);
      assert.equal(applied.importedRecordsVerified.activeEur, '69.331179090207230000');
      assert.equal(applied.importedRecordsVerified.deleted, 1);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expense_items WHERE account_id=$1', [target])).rows[0].n, 1);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expense_draft_items WHERE account_id=$1', [target])).rows[0].n, 1);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.provenance_events WHERE account_id=$1', [target])).rows[0].n, 1);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.category_events WHERE account_id=$1', [target])).rows[0].n, 1);
      const seededReceipt = (await c.query('SELECT * FROM personal_finance.receipts WHERE account_id=$1', [target])).rows[0];
      assert.equal(seededReceipt.storage_key, `${target}/${receiptId}.jpg`);
      assert.deepEqual(fs.readFileSync(path.join(receiptRoot, target, `${receiptId}.jpg`)), bytes);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expenses WHERE account_id=$1', [other])).rows[0].n, 0, 'other account must remain untouched');

      const repeat = runSeed(input, target, '--apply', receiptRoot);
      assert.equal(repeat.status, 0, repeat.stderr);
      const repeated = lastJson(repeat.stdout);
      assert.equal(repeated.planned.expenses.inserted, 0);
      assert.equal(repeated.planned.expenses.present, 2);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expenses WHERE account_id=$1', [target])).rows[0].n, 2);

      const conflictPath = path.join(temp, 'conflict.json');
      const conflict = structuredClone(payload); conflict.tables.expenses[0].amount = '999.00';
      fs.writeFileSync(conflictPath, JSON.stringify(conflict), { mode: 0o600 });
      fs.mkdirSync(`${conflictPath}.attachments`, { mode: 0o700 });
      fs.writeFileSync(path.join(`${conflictPath}.attachments`, `${receiptId}.jpg`), bytes, { mode: 0o600 });
      const conflictRun = runSeed(conflictPath, target, '--apply', receiptRoot);
      assert.notEqual(conflictRun.status, 0);
      assert.match(conflictRun.stderr, /Conflict:/);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expenses WHERE account_id=$1', [target])).rows[0].n, 2, 'conflict must not partially change data');

      const rollbackPath = path.join(temp, 'rollback.json');
      const rollback = structuredClone(payload);
      rollback.tables.expenses.push({ ...rollback.tables.expenses[1], id: '00000000-0000-4000-8000-000000000304', expense_date: '2026-08-01', amount: '5', currency: 'EUR', amount_eur: '5', fx_rate: null, fx_rate_convention: null, fx_source: null, fx_effective_at: null, fx_provider: null, source_kind: 'manual', source_id: null, legacy_record_id: null, merchant_id: merchantSource, category_id: sourceCategory.id, description: 'valid row rolled back', deleted_at: null });
      rollback.tables.expenses.push({ ...rollback.tables.expenses[2], id: '00000000-0000-4000-8000-000000000305', expense_date: '2026-08-02', merchant_id: '00000000-0000-4000-8000-000000000999', description: 'bad foreign key row' });
      fs.writeFileSync(rollbackPath, JSON.stringify(rollback), { mode: 0o600 });
      fs.mkdirSync(`${rollbackPath}.attachments`, { mode: 0o700 });
      fs.writeFileSync(path.join(`${rollbackPath}.attachments`, `${receiptId}.jpg`), bytes, { mode: 0o600 });
      const rollbackRun = runSeed(rollbackPath, target, '--apply', receiptRoot);
      assert.notEqual(rollbackRun.status, 0);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expenses WHERE account_id=$1', [target])).rows[0].n, 2, 'transaction must rollback earlier inserts after later FK failure');

      const freshPath = path.join(temp, 'fresh.json');
      const freshData = freshCopy(payload);
      fs.writeFileSync(freshPath, JSON.stringify(freshData), { mode: 0o600 });
      fs.mkdirSync(`${freshPath}.attachments`, { mode: 0o700 });
      fs.writeFileSync(path.join(`${freshPath}.attachments`, freshData.attachments[0].bundleFile), bytes, { mode: 0o600 });
      const fresh = runSeed(freshPath, other, '--apply', receiptRoot);
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.equal(lastJson(fresh.stdout).planned.expenses.inserted, 2);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expenses WHERE account_id=$1', [other])).rows[0].n, 2, 'fresh account import must insert all rows');

      const missingPath = path.join(temp, 'missing.json');
      const missing = structuredClone(payload); missing.attachments[0].status = 'missing'; missing.attachments[0].bundleFile = null;
      fs.writeFileSync(missingPath, JSON.stringify(missing), { mode: 0o600 });
      const missingRun = runSeed(missingPath, empty, '--apply', receiptRoot);
      assert.notEqual(missingRun.status, 0);
      assert.match(missingRun.stderr, /attachment\(s\) are missing/);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM personal_finance.expenses WHERE account_id=$1', [empty])).rows[0].n, 0);
    } finally {
      if (createdSchemas) {
        const schemas = await c.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('auth','personal_finance')");
        if (schemas.rows.some((r) => r.schema_name === 'personal_finance')) await c.query('DROP SCHEMA personal_finance CASCADE');
        if (schemas.rows.some((r) => r.schema_name === 'auth')) await c.query('DROP SCHEMA auth CASCADE');
      }
      c.release();
    }
  } finally {
    await pool.end();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
