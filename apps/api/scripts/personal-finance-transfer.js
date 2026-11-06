#!/usr/bin/env node
'use strict';

/**
 * One-time, account-scoped Personal Finance transfer. This deliberately uses
 * PostgreSQL directly because the HTTP import API does not preserve IDs,
 * soft-deletes, categories, drafts, receipts, or provenance.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const dotenv = require('dotenv');

const FORMAT = 'energrid-personal-finance-export-v1';
const TABLES = [
  'merchants', 'categories', 'expenses', 'expense_drafts', 'receipts',
  'expense_items', 'expense_draft_items', 'provenance_events', 'category_events',
];
const JSONB_COLUMNS = new Set([
  'receipts.extracted_totals', 'receipts.extraction_result', 'receipts.extraction_warnings', 'receipts.reviewed_adjustments',
  'expense_items.extraction_provenance', 'expense_draft_items.extraction_provenance',
  'provenance_events.details', 'category_events.details',
]);
const DECIMAL_COLUMNS = new Set([
  'expenses.amount', 'expenses.amount_eur', 'expenses.fx_rate', 'expenses.liters', 'expense_drafts.amount',
  'expense_items.quantity', 'expense_items.unit_price', 'expense_items.discount', 'expense_items.tax', 'expense_items.line_total',
  'expense_draft_items.quantity', 'expense_draft_items.unit_price', 'expense_draft_items.discount', 'expense_draft_items.tax', 'expense_draft_items.line_total',
  'receipts.reviewed_total',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOLEAN_OPTIONS = new Set(['dry-run', 'apply']);

function argsOf(argv) {
  const result = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { result.positional.push(token); continue; }
    const split = token.indexOf('=');
    const key = token.slice(2, split < 0 ? undefined : split);
    const value = split >= 0 ? token.slice(split + 1) : BOOLEAN_OPTIONS.has(key) ? true : argv[++i];
    if (!key || value === undefined || (typeof value === 'string' && value.startsWith('--'))) throw new Error(`Option --${key || '?'} requires a value.`);
    if (BOOLEAN_OPTIONS.has(key) && value !== true) throw new Error(`Option --${key} does not accept a value.`);
    result[key] = value;
  }
  return result;
}

function decimal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Financial decimal has an unsupported type.');
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error('Financial decimal is invalid.');
  return text;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} must be a UUID.`);
  return value.toLowerCase();
}

function loadSourceConfig() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.auth.local'), override: true, quiet: true });
  const { PGHOST: host, PGPORT: port, PGDATABASE: database, PGUSER: user, PGPASSWORD: password, PGSSL } = process.env;
  if (!host || !port || !database || !user || !password) throw new Error('Export requires the existing PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD configuration.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || database !== 'energrid_auth_local' || port !== '5432') {
    throw new Error('Export refused: source must be 127.0.0.1:5432/energrid_auth_local.');
  }
  return { host, port: Number(port), database, user, password, ssl: PGSSL === 'true' ? { rejectUnauthorized: true } : false };
}

function loadSeedConfig() {
  const raw = process.env.FINANCE_SEED_DATABASE_URL;
  if (!raw) throw new Error('Seed requires FINANCE_SEED_DATABASE_URL to be explicitly supplied in the environment.');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('FINANCE_SEED_DATABASE_URL is invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error('FINANCE_SEED_DATABASE_URL must identify a PostgreSQL database.');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('Seed refused: use a private SSH tunnel or run on the Pi with a loopback PostgreSQL connection.');
  return { connectionString: raw, host: parsed.hostname, port: Number(parsed.port || 5432), database: decodeURIComponent(parsed.pathname.slice(1)), ssl: parsed.searchParams.get('sslmode') === 'require' ? { rejectUnauthorized: true } : false };
}

function tableRows(payload, table) {
  const rows = payload.tables?.[table];
  if (!Array.isArray(rows)) throw new Error(`Export is missing the ${table} table data.`);
  return rows;
}

function exportSummary(payload) {
  const expenses = tableRows(payload, 'expenses');
  const currencies = {};
  let activeEur = '0';
  let activeCount = 0;
  let deletedCount = 0;
  for (const row of expenses) {
    if (row.deleted_at == null) {
      activeCount++;
      if (row.amount_eur != null) activeEur = addDecimals(activeEur, row.amount_eur);
    } else deletedCount++;
    const currency = String(row.currency || '').trim();
    currencies[currency] ||= { activeCount: 0, deletedCount: 0, activeOriginalTotal: '0', deletedOriginalTotal: '0', originalTotal: '0' };
    const entry = currencies[currency];
    if (row.deleted_at == null) {
      entry.activeCount++;
      entry.activeOriginalTotal = addDecimals(entry.activeOriginalTotal, row.amount);
    } else {
      entry.deletedCount++;
      entry.deletedOriginalTotal = addDecimals(entry.deletedOriginalTotal, row.amount);
    }
    entry.originalTotal = addDecimals(entry.activeOriginalTotal, entry.deletedOriginalTotal);
  }
  const relatedRecordCounts = Object.fromEntries(TABLES.filter((table) => table !== 'expenses').map((table) => [table, tableRows(payload, table).length]));
  return { totalExpenses: expenses.length, activeCount, deletedCount, activeEur, currencies, relatedRecordCounts };
}

function validatePayload(payload) {
  if (payload.format !== FORMAT) throw new Error(`Unsupported export format. Expected ${FORMAT}.`);
  const sourceAccount = uuid(payload.source?.accountId, 'export source account');
  for (const table of TABLES) {
    const rows = tableRows(payload, table);
    const ids = new Set();
    const sourceKeys = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${table} contains a malformed row.`);
      if (!UUID.test(String(row.id || ''))) throw new Error(`${table} contains a row with an invalid ID.`);
      if (ids.has(row.id)) throw new Error(`Duplicate primary ID in export: ${table}/${row.id}.`);
      ids.add(row.id);
      if (row.account_id !== sourceAccount) throw new Error(`${table} contains a row outside the exported account.`);
      for (const actor of ['confirmed_by', 'actor_user_id']) if (row[actor] && row[actor] !== sourceAccount) throw new Error(`${table} references another actor; an explicit actor mapping is required before export can be seeded.`);
      if (table === 'expenses' || table === 'expense_drafts') {
        if (row.amount != null) decimal(row.amount);
        if (row.amount_eur != null) decimal(row.amount_eur);
        const key = row.source_id ? `${row.source_kind}\0${row.source_id}` : null;
        if (key && sourceKeys.has(key)) throw new Error(`Duplicate stable source identifier in export: ${table}.`);
        if (key) sourceKeys.add(key);
        if (table === 'expenses' && row.legacy_record_id) {
          const legacy = `legacy\0${row.legacy_record_id}`;
          if (sourceKeys.has(legacy)) throw new Error('Duplicate legacy source identifier in export.');
          sourceKeys.add(legacy);
        }
      }
    }
  }
  const receiptIds = new Set(tableRows(payload, 'receipts').map((r) => r.id));
  const attachmentIds = new Set();
  if (!Array.isArray(payload.attachments)) throw new Error('Export is missing the receipt attachment manifest.');
  for (const attachment of payload.attachments) {
    if (!receiptIds.has(attachment.receiptId) || attachmentIds.has(attachment.receiptId)) throw new Error('Receipt attachment manifest has an unknown or duplicate receipt.');
    if (!['included', 'missing'].includes(attachment.status)) throw new Error('Receipt attachment manifest has an invalid status.');
    attachmentIds.add(attachment.receiptId);
  }
  if (attachmentIds.size !== receiptIds.size) throw new Error('Receipt attachment manifest does not cover every receipt.');
  return sourceAccount;
}

function addDecimals(a, b) {
  // Decimal string addition avoids Number precision loss; totals stay exact.
  const left = decimal(a) || '0'; const right = decimal(b) || '0';
  const [li, lf = ''] = left.replace('-', '').split('.'); const [ri, rf = ''] = right.replace('-', '').split('.');
  const scale = Math.max(lf.length, rf.length);
  const negative = left.startsWith('-') !== right.startsWith('-');
  const liBig = BigInt(`${li}${lf.padEnd(scale, '0')}` || '0') * (left.startsWith('-') ? -1n : 1n);
  const riBig = BigInt(`${ri}${rf.padEnd(scale, '0')}` || '0') * (right.startsWith('-') ? -1n : 1n);
  const sum = liBig + riBig;
  const abs = sum < 0n ? -sum : sum;
  const digits = abs.toString().padStart(scale + 1, '0');
  const whole = scale ? digits.slice(0, -scale) : digits;
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, '') : '';
  return `${sum < 0n ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function sameDecimalValue(a, b) {
  const normalize = (value) => {
    const text = decimal(value);
    if (text === null) return null;
    const negative = text.startsWith('-');
    const unsigned = negative ? text.slice(1) : text;
    const [whole, fraction = ''] = unsigned.split('.');
    const normalized = `${whole.replace(/^0+(?=\d)/, '')}${fraction.replace(/0+$/, '') ? `.${fraction.replace(/0+$/, '')}` : ''}`;
    return normalized === '0' ? '0' : `${negative ? '-' : ''}${normalized}`;
  };
  return normalize(a) === normalize(b);
}

async function chooseSourceAccount(client, requested) {
  if (requested) return uuid(requested, '--account-id');
  const rows = await client.query('SELECT DISTINCT account_id::text FROM personal_finance.expenses ORDER BY account_id');
  if (rows.rowCount !== 1) throw new Error(`Source has ${rows.rowCount} accounts with expenses; pass --account-id explicitly.`);
  return uuid(rows.rows[0].account_id, 'source account');
}

async function exportData(options) {
  if (!options.output) throw new Error('Usage: pnpm finance:export --output <file.json> [--account-id <uuid>].');
  const output = path.resolve(options.output);
  const source = loadSourceConfig();
  const pool = new Pool({ ...source, max: 1, application_name: 'energrid-finance-export' });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const identity = (await client.query('SELECT current_database() AS database, inet_server_addr()::text AS server, inet_server_port() AS port')).rows[0];
      if (identity.database !== 'energrid_auth_local' || !['127.0.0.1/32', '::1/128'].includes(identity.server) || Number(identity.port) !== 5432) throw new Error('Export refused: connected database identity did not match the approved local source.');
      const accountId = await chooseSourceAccount(client, options['account-id']);
      const tables = {};
      for (const table of TABLES) {
        const dateProjection = table === 'expenses' || table === 'expense_drafts' ? ", to_char(expense_date, 'YYYY-MM-DD') AS __finance_export_date" : '';
        const { rows } = await client.query(`SELECT *${dateProjection} FROM personal_finance.${table} WHERE account_id = $1::uuid ORDER BY id`, [accountId]);
        for (const row of rows) if (Object.hasOwn(row, '__finance_export_date')) { row.expense_date = row.__finance_export_date; delete row.__finance_export_date; }
        tables[table] = rows;
      }
      await client.query('COMMIT');
      const receiptDir = `${output}.attachments`;
      const receiptRoot = path.resolve(process.env.PERSONAL_FINANCE_RECEIPTS_DIR?.trim() || path.join(os.homedir(), '.energrid', 'private-receipts'));
      const attachments = [];
      if (tables.receipts.length) {
        fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 }); fs.chmodSync(receiptDir, 0o700);
        for (const receipt of tables.receipts) {
          const keyParts = String(receipt.storage_key || '').split('/');
          const item = { receiptId: receipt.id, contentHash: String(receipt.content_hash).trim(), mediaType: receipt.media_type, byteLength: Number(receipt.byte_length), status: 'missing', bundleFile: null };
          const safeKey = keyParts.length === 2 && keyParts[0] === accountId && /^[0-9a-f-]{36}\.(jpg|png)$/.test(keyParts[1]);
          if (safeKey) {
            const file = path.resolve(receiptRoot, ...keyParts);
            const rootReal = fs.existsSync(receiptRoot) ? fs.realpathSync(receiptRoot) : null;
            const accountDir = path.join(receiptRoot, accountId);
            const accountReal = fs.existsSync(accountDir) ? fs.realpathSync(accountDir) : null;
            if (rootReal && accountReal && accountReal.startsWith(`${rootReal}${path.sep}`) && file.startsWith(`${receiptRoot}${path.sep}`) && fs.existsSync(file)) {
              const info = fs.lstatSync(file);
              const bytes = fs.readFileSync(file);
              const hash = crypto.createHash('sha256').update(bytes).digest('hex');
              if (!info.isFile() || info.isSymbolicLink() || info.size !== item.byteLength || hash !== item.contentHash) throw new Error(`Receipt attachment verification failed for receipt ${receipt.id}.`);
              const ext = path.extname(file).toLowerCase();
              const bundleFile = `${receipt.id}${ext}`;
              fs.writeFileSync(path.join(receiptDir, bundleFile), bytes, { mode: 0o600, flag: 'wx' });
              item.status = 'included'; item.bundleFile = bundleFile;
            }
          }
          attachments.push(item);
        }
      }
      const payload = {
        format: FORMAT, exportedAt: new Date().toISOString(),
        source: { database: identity.database, accountId },
        tables, attachments,
        summary: exportSummary({ tables }),
      };
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(output, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(output, 0o600);
      console.log(JSON.stringify({ output, attachmentBundle: attachments.length ? receiptDir : null, ...payload.summary, attachments: attachments.map(({ receiptId, status }) => ({ receiptId, status })) }, null, 2));
    } finally { client.release(); }
  } finally { await pool.end(); }
}

function remapRow(row, sourceAccount, targetAccount, maps) {
  const copy = { ...row };
  if (Object.hasOwn(copy, 'account_id')) copy.account_id = targetAccount;
  for (const key of ['confirmed_by', 'actor_user_id']) if (copy[key] === sourceAccount) copy[key] = targetAccount;
  if (copy.merchant_id) copy.merchant_id = maps.merchants.get(copy.merchant_id) || copy.merchant_id;
  if (copy.category_id) copy.category_id = maps.categories.get(copy.category_id) || copy.category_id;
  if (copy.parent_id) copy.parent_id = maps.categories.get(copy.parent_id) || copy.parent_id;
  if (copy.expense_id) copy.expense_id = maps.expenses.get(copy.expense_id) || copy.expense_id;
  if (copy.confirmed_expense_id) copy.confirmed_expense_id = maps.expenses.get(copy.confirmed_expense_id) || copy.confirmed_expense_id;
  if (copy.draft_id) copy.draft_id = maps.drafts.get(copy.draft_id) || copy.draft_id;
  if (copy.receipt_id) copy.receipt_id = maps.receipts.get(copy.receipt_id) || copy.receipt_id;
  if (copy.source_receipt_id) copy.source_receipt_id = maps.receipts.get(copy.source_receipt_id) || copy.source_receipt_id;
  return copy;
}

function categoriesParentFirst(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = []; const visited = new Set(); const visiting = new Set();
  const visit = (row) => {
    if (visited.has(row.id)) return;
    if (visiting.has(row.id)) throw new Error(`Category hierarchy contains a cycle at ${row.id}.`);
    visiting.add(row.id);
    if (row.parent_id && byId.has(row.parent_id)) visit(byId.get(row.parent_id));
    visiting.delete(row.id); visited.add(row.id); result.push(row);
  };
  rows.forEach(visit);
  return result;
}

function expenseIdentityFields(row) {
  return ['expense_date', 'amount', 'currency', 'amount_eur', 'fx_rate', 'fx_rate_convention', 'fx_source', 'fx_effective_at', 'fx_provider', 'merchant_name', 'category', 'description', 'tags', 'liters', 'source_kind', 'source_id', 'legacy_record_id', 'source_created_at', 'source_updated_at'];
}

function sameValues(existing, expected, keys) {
  return keys.every((key) => {
    const a = existing[key]; const b = expected[key];
    if (a == null || b == null) return a == null && b == null;
    if (key === 'expense_date') return dateOnly(a) === dateOnly(b);
    if (Array.isArray(a) || (typeof a === 'object' && a !== null) || Array.isArray(b) || (typeof b === 'object' && b !== null)) return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
  });
}

function differingKeys(existing, expected, keys, table = '') {
  return keys.filter((key) => !rowValueEqual(table, key, expected[key], existing[key]));
}

function dateOnly(value) {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return String(value).slice(0, 10);
}

async function tableColumns(client, table) {
  const rows = await client.query(`SELECT column_name, is_nullable, column_default, is_identity, is_generated FROM information_schema.columns WHERE table_schema='personal_finance' AND table_name=$1`, [table]);
  return new Map(rows.rows.map((r) => [r.column_name, r]));
}

function validateTableCompatibility(table, rows, columns) {
  if (!rows.length) return;
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.has(key)) throw new Error(`Destination schema is incompatible: ${table}.${key} is missing.`);
  }
  const provided = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const [name, column] of columns) {
    const generated = column.is_generated && column.is_generated !== 'NEVER';
    if (!provided.has(name) && column.is_nullable === 'NO' && column.column_default == null && column.is_identity !== 'YES' && !generated) {
      throw new Error(`Destination schema is incompatible: required ${table}.${name} has no source value or database default.`);
    }
  }
}

async function existingRow(client, table, id) {
  const result = await client.query(`SELECT * FROM personal_finance.${table} WHERE id=$1::uuid`, [id]);
  return result.rows[0] || null;
}

function samePortableRecord(existing, expected, table = '') {
  for (const [key, value] of Object.entries(expected)) {
    const actual = existing[key];
    if (value == null && actual == null) continue;
    if (!rowValueEqual(table, key, value, actual)) return false;
  }
  return true;
}

function portableDifferenceKeys(existing, expected, table = '') {
  return Object.entries(expected).filter(([key, value]) => !rowValueEqual(table, key, value, existing[key])).map(([key]) => key);
}

function rowValueEqual(table, key, a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (DECIMAL_COLUMNS.has(`${table}.${key}`)) return sameDecimalValue(a, b);
  if (key === 'expense_date') return dateOnly(a) === dateOnly(b);
  return portableValueEqual(a, b);
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}

function portableValueEqual(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) {
    const left = Date.parse(a instanceof Date ? a.toISOString() : a);
    const right = Date.parse(b instanceof Date ? b.toISOString() : b);
    return Number.isFinite(left) && left === right;
  }
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b)) return a === b;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(stableJson(a)) === JSON.stringify(stableJson(b));
  return String(a) === String(b);
}

async function insertPortable(client, table, row, maps, counters) {
  const id = row.id;
  const existing = await existingRow(client, table, id);
  if (existing) {
    if (table === 'receipts') {
      const current = { ...existing }; const expected = { ...row };
      delete current.id; delete current.storage_key; delete expected.id; delete expected.storage_key;
      const differences = portableDifferenceKeys(current, expected, table);
      if (differences.length) throw new Error(`Conflict: ${table} ID ${id} differs in ${differences.join(', ')}.`);
    } else {
      const differences = portableDifferenceKeys(existing, row, table);
      if (differences.length) throw new Error(`Conflict: ${table} ID ${id} differs in ${differences.join(', ')}.`);
    }
    if (table === 'expense_drafts') maps.drafts.set(id, id);
    else if (['merchants', 'categories', 'expenses', 'receipts'].includes(table)) maps[table].set(id, id);
    counters.present++;
    return;
  }
  let match = null;
  if (table === 'merchants') {
    match = (await client.query('SELECT * FROM personal_finance.merchants WHERE account_id=$1::uuid AND normalized_name=$2', [row.account_id, row.normalized_name])).rows[0] || null;
  } else if (table === 'categories') {
    match = (await client.query('SELECT * FROM personal_finance.categories WHERE account_id=$1::uuid AND lower(btrim(name))=lower(btrim($2)) AND archived_at IS NOT DISTINCT FROM $3::timestamptz LIMIT 1', [row.account_id, row.name, row.archived_at])).rows[0] || null;
  } else if (table === 'expenses') {
    if (row.source_id) match = (await client.query('SELECT * FROM personal_finance.expenses WHERE account_id=$1::uuid AND source_kind=$2 AND source_id=$3', [row.account_id, row.source_kind, row.source_id])).rows[0] || null;
    if (!match && row.legacy_record_id) match = (await client.query('SELECT * FROM personal_finance.expenses WHERE account_id=$1::uuid AND legacy_record_id=$2', [row.account_id, row.legacy_record_id])).rows[0] || null;
  } else if (table === 'expense_drafts' && row.source_id) {
    match = (await client.query('SELECT * FROM personal_finance.expense_drafts WHERE account_id=$1::uuid AND source_kind=$2 AND source_id=$3', [row.account_id, row.source_kind, row.source_id])).rows[0] || null;
  } else if (table === 'receipts') {
    match = (await client.query('SELECT * FROM personal_finance.receipts WHERE account_id=$1::uuid AND content_hash=$2', [row.account_id, row.content_hash])).rows[0] || null;
  }
  if (match) {
    const compared = { ...row };
    if (table === 'receipts') {
      // Storage paths are host-local; content hash and metadata identify the same immutable image.
      delete compared.id; delete compared.storage_key;
      const existingComparable = { ...match }; delete existingComparable.id; delete existingComparable.storage_key;
      if (!samePortableRecord(existingComparable, compared, table)) throw new Error(`Conflict: ${table} source identity exists with different data.`);
    } else if (table === 'expenses') {
      const differences = differingKeys(match, row, expenseIdentityFields(row), table);
      if (differences.length) throw new Error(`Conflict: expense stable source identifier differs in ${differences.join(', ')}.`);
    } else {
      delete compared.id;
      const existingComparable = { ...match }; delete existingComparable.id;
      for (const key of ['created_at', 'updated_at']) { delete existingComparable[key]; delete compared[key]; }
      if (!samePortableRecord(existingComparable, compared, table)) throw new Error(`Conflict: ${table} stable identifier exists with different data.`);
    }
    if (maps && table === 'merchants') maps.merchants.set(id, match.id);
    if (maps && table === 'categories') maps.categories.set(id, match.id);
    if (maps && table === 'expenses') maps.expenses.set(id, match.id);
    if (maps && table === 'expense_drafts') maps.drafts.set(id, match.id);
    if (maps && table === 'receipts') maps.receipts.set(id, match.id);
    counters.present++;
    return;
  }
  const columns = Object.keys(row);
  const values = columns.map((key) => JSONB_COLUMNS.has(`${table}.${key}`) && row[key] != null ? JSON.stringify(row[key]) : row[key]);
  const placeholders = columns.map((key, i) => JSONB_COLUMNS.has(`${table}.${key}`) ? `$${i + 1}::jsonb` : `$${i + 1}`).join(',');
  const result = await client.query(`INSERT INTO personal_finance.${table} (${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING RETURNING id`, values);
  if (!result.rowCount) throw new Error(`Conflict: ${table} row ${id} collides with a different primary or source identifier.`);
  if (maps && table === 'expense_drafts') maps.drafts.set(id, id);
  else if (maps && ['merchants', 'categories', 'expenses', 'receipts'].includes(table)) maps[table].set(id, id);
  counters.inserted++;
}

async function seedData(options) {
  if (!options.input || !options['account-id'] || !options['expected-database']) throw new Error('Usage: pnpm finance:seed --input <file.json> --account-id <destination-uuid> --expected-database <name> --dry-run|--apply.');
  if (Boolean(options['dry-run']) === Boolean(options.apply) || (options['dry-run'] && options['dry-run'] !== true) || (options.apply && options.apply !== true)) throw new Error('Choose exactly one of --dry-run or --apply.');
  const input = path.resolve(options.input);
  const payload = JSON.parse(fs.readFileSync(input, 'utf8'));
  const sourceAccount = validatePayload(payload);
  const targetAccount = uuid(options['account-id'], '--account-id');
  const config = loadSeedConfig();
  const pool = new Pool({ ...config, max: 1, application_name: 'energrid-finance-seed' });
  const isApply = Boolean(options.apply);
  const createdFiles = [];
  const sourceReceiptDir = path.resolve(`${input}.attachments`);
  const targetReceiptRoot = path.resolve(process.env.PERSONAL_FINANCE_RECEIPTS_DIR?.trim() || path.join(os.homedir(), '.energrid', 'private-receipts'));
  let committed = false;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(isApply ? 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE' : 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const identity = (await client.query('SELECT current_database() AS database, inet_server_addr()::text AS server, inet_server_port() AS port')).rows[0];
      if (identity.database !== options['expected-database']) throw new Error(`Destination database mismatch: connected to ${identity.database}, expected ${options['expected-database']}.`);
      // PostgreSQL may report its internal container address/port after a loopback
      // host-port mapping or SSH tunnel. The client endpoint was already constrained
      // to loopback in loadSeedConfig; verify the server supplied a TCP identity.
      if (!identity.server || !Number.isInteger(Number(identity.port))) throw new Error('Destination connection identity mismatch: PostgreSQL did not report a TCP server identity.');
      console.log(`Destination verified before ${isApply ? 'apply' : 'dry-run'}: database=${identity.database}, server=${identity.server}:${identity.port}, account=${targetAccount}`);
      const accountExists = (await client.query('SELECT EXISTS(SELECT 1 FROM auth.users WHERE id=$1::uuid) AS present', [targetAccount])).rows[0].present;
      if (!accountExists) throw new Error('Destination account does not exist in auth.users.');
      for (const table of TABLES) {
        const columns = await tableColumns(client, table);
        if (!columns.size) throw new Error(`Destination schema is missing personal_finance.${table}.`);
        const rows = tableRows(payload, table);
        validateTableCompatibility(table, rows, columns);
      }
      const attachmentMissing = (payload.attachments || []).filter((a) => a.status !== 'included');
      if (attachmentMissing.length && isApply) throw new Error(`${attachmentMissing.length} receipt attachment(s) are missing from the export bundle; apply refused to avoid dangling receipt references.`);
      const sourceSummary = exportSummary(payload);
      const targetBefore = await financeTotals(client, targetAccount);
      const counters = Object.fromEntries(TABLES.map((table) => [table, { inserted: 0, present: 0 }]));
      const maps = { merchants: new Map(), categories: new Map(), expenses: new Map(), drafts: new Map(), receipts: new Map() };
      if (isApply) await client.query("SELECT pg_advisory_xact_lock(hashtext('energrid-personal-finance-seed'))");
      // Parents and referenced owners are inserted first; duplicate/unique-key conflicts abort the transaction.
      for (const table of ['merchants', 'categories', 'expenses', 'expense_drafts', 'receipts', 'expense_items', 'expense_draft_items', 'provenance_events', 'category_events']) {
        const rows = table === 'categories' ? categoriesParentFirst(tableRows(payload, table)) : tableRows(payload, table);
        for (const sourceRow of rows) {
          const row = remapRow(sourceRow, sourceAccount, targetAccount, maps);
          if (table === 'receipts') {
            const attachment = (payload.attachments || []).find((a) => a.receiptId === sourceRow.id);
            if (attachment?.status !== 'included' && isApply) throw new Error(`Receipt ${sourceRow.id} is missing its private file.`);
            if (attachment?.status === 'included') {
              const bundle = path.resolve(sourceReceiptDir, attachment.bundleFile);
              if (!bundle.startsWith(`${sourceReceiptDir}${path.sep}`) || !fs.existsSync(bundle)) throw new Error(`Receipt attachment bundle is missing for receipt ${sourceRow.id}.`);
              if (!fs.lstatSync(bundle).isFile() || fs.lstatSync(bundle).isSymbolicLink()) throw new Error(`Receipt attachment bundle is not a regular file for receipt ${sourceRow.id}.`);
              const bytes = fs.readFileSync(bundle);
              if (bytes.length !== attachment.byteLength || crypto.createHash('sha256').update(bytes).digest('hex') !== attachment.contentHash) throw new Error(`Receipt attachment integrity check failed for receipt ${sourceRow.id}.`);
              const ext = attachment.mediaType === 'image/jpeg' ? '.jpg' : attachment.mediaType === 'image/png' ? '.png' : null;
              if (!ext) throw new Error(`Receipt ${sourceRow.id} has an unsupported attachment type.`);
              const receiptId = maps.receipts.get(sourceRow.id) || sourceRow.id;
              row.storage_key = `${targetAccount}/${receiptId}${ext}`;
              const duplicate = await client.query('SELECT id,storage_key FROM personal_finance.receipts WHERE account_id=$1::uuid AND content_hash=$2', [targetAccount, sourceRow.content_hash]);
              if (!duplicate.rowCount && isApply) {
                fs.mkdirSync(targetReceiptRoot, { recursive: true, mode: 0o700 });
                const realRoot = fs.realpathSync(targetReceiptRoot);
                const accountDir = path.join(realRoot, targetAccount);
                fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 }); fs.chmodSync(realRoot, 0o700); fs.chmodSync(accountDir, 0o700);
                const realAccountDir = fs.realpathSync(accountDir);
                if (!realAccountDir.startsWith(`${realRoot}${path.sep}`)) throw new Error('Destination receipt storage path escaped its private root.');
                const destination = path.join(realAccountDir, `${receiptId}${ext}`);
                if (fs.existsSync(destination)) {
                  const existingBytes = fs.readFileSync(destination);
                  if (crypto.createHash('sha256').update(existingBytes).digest('hex') !== attachment.contentHash) throw new Error(`Receipt file path already exists with different content (${receiptId}).`);
                } else {
                  fs.writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' }); createdFiles.push(destination);
                }
              }
            }
          }
          await insertPortable(client, table, row, maps, counters[table]);
        }
      }
      const after = await financeTotals(client, targetAccount);
      const expenseIds = tableRows(payload, 'expenses').map((row) => maps.expenses.get(row.id) || row.id);
      const importedPlan = await financeTotalsForIds(client, targetAccount, expenseIds);
      const expectedImported = sourceSummary;
      if (importedPlan.total !== expectedImported.totalExpenses || importedPlan.active !== expectedImported.activeCount || importedPlan.deleted !== expectedImported.deletedCount || !sameDecimalValue(importedPlan.activeEur, expectedImported.activeEur)) {
        throw new Error(`Import verification mismatch: expected ${expectedImported.totalExpenses} expenses (${expectedImported.activeCount} active, ${expectedImported.deletedCount} deleted, EUR ${expectedImported.activeEur}); found ${importedPlan.total} (${importedPlan.active} active, ${importedPlan.deleted} deleted, EUR ${importedPlan.activeEur}).`);
      }
      for (const expected of Object.entries(expectedImported.currencies)) {
        const actualCurrency = importedPlan.currencies.find((row) => String(row.currency).trim() === expected[0]);
        if (!actualCurrency || Number(actualCurrency.active) !== expected[1].activeCount || Number(actualCurrency.deleted) !== expected[1].deletedCount || !sameDecimalValue(actualCurrency.active_original_total, expected[1].activeOriginalTotal) || !sameDecimalValue(actualCurrency.deleted_original_total, expected[1].deletedOriginalTotal) || !sameDecimalValue(actualCurrency.original_total, expected[1].originalTotal)) throw new Error(`Post-import verification mismatch for original currency ${expected[0]}.`);
      }
      if (isApply) {
        await client.query('COMMIT');
        committed = true;
      } else {
        await client.query('ROLLBACK');
      }
      const actual = isApply ? await financeTotals(client, targetAccount) : after;
      const imported = isApply ? await financeTotalsForIds(client, targetAccount, expenseIds) : importedPlan;
      if (isApply && (imported.total !== expectedImported.totalExpenses || imported.active !== expectedImported.activeCount || imported.deleted !== expectedImported.deletedCount || !sameDecimalValue(imported.activeEur, expectedImported.activeEur))) throw new Error('Post-commit reconciliation failed; inspect destination records before retrying.');
      console.log(JSON.stringify({ mode: isApply ? 'apply' : 'dry-run', destination: identity, accountId: targetAccount, sourceAccountId: sourceAccount,
        source: sourceSummary, destinationBefore: targetBefore, planned: counters,
        destinationAfter: isApply ? actual : null, dryRunProjection: isApply ? null : after,
        importedRecordsVerified: imported, conflicts: [], attachmentsMissing: attachmentMissing.map((a) => a.receiptId) }, null, 2));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!committed) for (const file of createdFiles) fs.unlinkSync(file);
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

async function financeTotals(client, accountId) {
  const expenses = await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE deleted_at IS NULL)::int AS active,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted,coalesce(sum(amount_eur) FILTER(WHERE deleted_at IS NULL),0)::text AS active_eur FROM personal_finance.expenses WHERE account_id=$1::uuid", [accountId]);
  const currencies = await client.query("SELECT currency,count(*) FILTER(WHERE deleted_at IS NULL)::int AS active,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted,coalesce(sum(amount) FILTER(WHERE deleted_at IS NULL),0)::text AS active_original_total,coalesce(sum(amount) FILTER(WHERE deleted_at IS NOT NULL),0)::text AS deleted_original_total,coalesce(sum(amount),0)::text AS original_total FROM personal_finance.expenses WHERE account_id=$1::uuid GROUP BY currency ORDER BY currency", [accountId]);
  const row = expenses.rows[0];
  const tableCounts = {};
  for (const table of TABLES) tableCounts[table] = Number((await client.query(`SELECT count(*)::int AS n FROM personal_finance.${table} WHERE account_id=$1::uuid`, [accountId])).rows[0].n);
  return { total: row.total, active: row.active, deleted: row.deleted, activeEur: row.active_eur, currencies: currencies.rows, tableCounts };
}

async function financeTotalsForIds(client, accountId, ids) {
  if (!ids.length) return { total: 0, active: 0, deleted: 0, activeEur: '0', currencies: [] };
  const expenses = await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE deleted_at IS NULL)::int AS active,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted,coalesce(sum(amount_eur) FILTER(WHERE deleted_at IS NULL),0)::text AS active_eur FROM personal_finance.expenses WHERE account_id=$1::uuid AND id=ANY($2::uuid[])", [accountId, ids]);
  const currencies = await client.query("SELECT currency,count(*) FILTER(WHERE deleted_at IS NULL)::int AS active,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted,coalesce(sum(amount) FILTER(WHERE deleted_at IS NULL),0)::text AS active_original_total,coalesce(sum(amount) FILTER(WHERE deleted_at IS NOT NULL),0)::text AS deleted_original_total,coalesce(sum(amount),0)::text AS original_total FROM personal_finance.expenses WHERE account_id=$1::uuid AND id=ANY($2::uuid[]) GROUP BY currency ORDER BY currency", [accountId, ids]);
  const row = expenses.rows[0];
  return { total: row.total, active: row.active, deleted: row.deleted, activeEur: row.active_eur, currencies: currencies.rows };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = argsOf(rest);
  if (command === 'export') return exportData(options);
  if (command === 'seed') return seedData(options);
  throw new Error('Usage: personal-finance-transfer.js <export|seed> [options].');
}

if (require.main === module) main().catch((error) => { console.error(`Finance transfer stopped: ${error.message}`); process.exitCode = 1; });

module.exports = { FORMAT, TABLES, argsOf, decimal, addDecimals, sameDecimalValue, exportSummary, validatePayload, samePortableRecord, portableDifferenceKeys, remapRow, categoriesParentFirst, expenseIdentityFields, sameValues, differingKeys, dateOnly, validateTableCompatibility, JSONB_COLUMNS, DECIMAL_COLUMNS };
