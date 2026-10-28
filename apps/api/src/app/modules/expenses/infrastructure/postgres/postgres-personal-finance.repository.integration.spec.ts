import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ExpenseImportRow } from '../../application/ports/personal-finance.repository';
import { PostgresPersonalFinanceRepository } from './postgres-personal-finance.repository';

const databaseUrl = process.env.AUTH_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('Postgres Personal Finance repository integration', () => {
  let pool: Pool;
  let repository: PostgresPersonalFinanceRepository;
  const accounts: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    const target = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (target.rows[0]?.name !== 'energrid_personal_finance_test') throw new Error('Refusing integration tests outside energrid_personal_finance_test');
    repository = new PostgresPersonalFinanceRepository(pool);
  });

  afterAll(async () => { await pool?.end(); });

  async function account() {
    const id = randomUUID();
    accounts.push(id);
    await pool.query(
      "INSERT INTO auth.users(id,email,password_hash,display_name,role) VALUES ($1,$2,'integration-test-password-hash','Finance integration test','viewer')",
      [id, `${id}@finance.integration.test`],
    );
    return id;
  }

  function row(sourceId: string, overrides: Partial<ExpenseImportRow> = {}): ExpenseImportRow {
    return {
      date: '2025-01-03', amount: '135.6', currency: 'BGN', amountEur: '69.33117909020723',
      fx: { rate: '1.95583', convention: 'currency_units_per_eur', source: 'legacy-import', effectiveAt: null, provider: null },
      merchantName: 'Lidl', category: 'Fuel', description: 'Nissan', tags: ['petrol', 'nissan'], items: [], liters: '53.59',
      source: { kind: 'legacy-mongo', id: sourceId, provider: 'historical-import' }, legacyRecordId: sourceId,
      ...overrides,
    };
  }

  it('persists exact decimal and legacy provenance, and isolates account queries and summaries', async () => {
    const owner = await account();
    const other = await account();
    const sourceId = randomUUID();
    expect(await repository.importExpenses(owner, owner, [row(sourceId)])).toEqual({ imported: 1, duplicates: 0 });
    const [visible, hidden, summary] = await Promise.all([
      repository.queryExpenses(owner, { limit: 10 }), repository.queryExpenses(other, { limit: 10 }),
      repository.summarize(owner, { fromDate: '2025-01-01', toDate: '2025-01-31' }),
    ]);
    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(0);
    expect(visible[0]).toMatchObject({ amount: '135.6', amountEur: '69.33117909020723', currency: 'BGN', tags: ['petrol', 'nissan'], liters: '53.59', legacyRecordId: sourceId });
    expect(summary.total).toBe('69.33117909020723');
    expect(summary.byCategory).toEqual([{ categoryId: null, category: 'Fuel', total: '69.33117909020723', count: 1 }]);
  });

  it('manages account-scoped category identity, hierarchy, archives, history labels and summary names', async () => {
    const owner = await account();
    const other = await account();
    const root = await repository.createCategory(owner, owner, { name: 'Food', description: 'Meals', parentId: null });
    const child = await repository.createCategory(owner, owner, { name: 'Dining out', description: null, parentId: root.id });
    await expect(repository.createCategory(other, other, { name: 'Private parent', description: null, parentId: root.id })).rejects.toThrow();
    await expect(repository.renameCategory(owner, owner, root.id, { name: 'Food', description: null, parentId: child.id })).rejects.toThrow(/cycle/);
    await expect(repository.createCategory(owner, owner, { name: ' food ', description: null, parentId: null })).rejects.toThrow();

    const original = row(randomUUID());
    const untouchedLegacy = row(randomUUID(), { amount: '21.25', amountEur: '10.877210365' });
    await repository.importExpenses(owner, owner, [original, untouchedLegacy]);
    const expenses = await repository.queryExpenses(owner, { limit: 10 });
    const legacyExpense = expenses.find((expense) => expense.legacyRecordId === original.legacyRecordId)!;
    const linked = await repository.updateExpense(owner, owner, legacyExpense.id, { ...original, category: 'Food', categoryId: root.id });
    expect(linked).toMatchObject({ category: 'Food', categoryId: root.id });
    const legacyFreeText = expenses.find((expense) => expense.legacyRecordId === untouchedLegacy.legacyRecordId)!;
    const renamed = await repository.renameCategory(owner, owner, root.id, { name: 'Dining', description: 'Restaurants', parentId: null });
    expect(renamed?.name).toBe('Dining');
    expect((await repository.queryExpenses(owner, { categoryId: root.id }))[0]).toMatchObject({ category: 'Dining', categoryId: root.id });
    const afterRename = await repository.queryExpenses(owner, { limit: 10 });
    expect(afterRename.find((expense) => expense.id === legacyFreeText.id)).toMatchObject({ category: 'Fuel', categoryId: null, amount: '21.25', amountEur: '10.877210365' });
    expect((await repository.summarize(owner, {})).byCategory).toEqual([
      { categoryId: root.id, category: 'Dining', total: '69.33117909020723', count: 1 },
      { categoryId: null, category: 'Fuel', total: '10.877210365', count: 1 },
    ]);

    await expect(repository.archiveCategory(owner, owner, root.id)).rejects.toThrow(/child categories/);
    const otherRoot = await repository.createCategory(owner, owner, { name: 'Other food', description: null, parentId: null });
    const reparented = await repository.renameCategory(owner, owner, child.id, { name: 'Dining out', description: null, parentId: otherRoot.id });
    expect(reparented?.parentId).toBe(otherRoot.id);
    await repository.archiveCategory(owner, owner, child.id);
    const archived = await repository.archiveCategory(owner, owner, root.id);
    expect(archived?.status).toBe('archived');
    await repository.archiveCategory(owner, owner, otherRoot.id);
    expect(await repository.listCategories(owner)).toEqual([]);
    expect(await repository.listCategories(other)).toEqual([]);
    await expect(repository.createExpense(owner, owner, {
      date: '2025-01-04', amount: '1', currency: 'EUR', amountEur: '1', fx: null, merchantName: null,
      category: 'Dining', categoryId: root.id, description: 'Should fail', tags: [], items: [], liters: null,
      source: { kind: 'manual', id: randomUUID() },
    })).rejects.toThrow(/unavailable/);
    const events = await pool.query<{ event_type: string }>('SELECT event_type FROM personal_finance.category_events WHERE account_id=$1 AND category_id=$2 ORDER BY occurred_at,id', [owner, root.id]);
    expect(events.rows).toHaveLength(3);
    expect(events.rows.map((event) => event.event_type)).toEqual(expect.arrayContaining(['category.created', 'category.renamed', 'category.archived']));
    await expect(pool.query("UPDATE personal_finance.category_events SET details='{}'::jsonb WHERE account_id=$1 AND category_id=$2", [owner, root.id])).rejects.toThrow(/immutable/);
  });

  it('reports exact category totals and does not roll child spending into parent categories', async () => {
    const owner = await account();
    const parent = await repository.createCategory(owner, owner, { name: 'Transport', description: null, parentId: null });
    const child = await repository.createCategory(owner, owner, { name: 'Fuel', description: null, parentId: parent.id });
    await repository.createExpense(owner, owner, {
      date: '2025-01-05', amount: '10', currency: 'EUR', amountEur: '10', fx: null, merchantName: 'Station',
      category: 'Fuel', categoryId: child.id, description: 'Petrol', tags: [], items: [], liters: null,
      source: { kind: 'manual', id: randomUUID() },
    });
    expect((await repository.summarize(owner, {})).byCategory).toEqual([
      { categoryId: child.id, category: 'Fuel', total: '10', count: 1 },
    ]);
  });

  it('rolls back category creation when its audit event cannot be written', async () => {
    const owner = await account();
    await pool.query(`
      CREATE FUNCTION personal_finance.test_reject_category_event() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$;
      CREATE TRIGGER personal_finance_test_reject_category_event
      BEFORE INSERT ON personal_finance.category_events
      FOR EACH ROW EXECUTE FUNCTION personal_finance.test_reject_category_event();
    `);
    try {
      await expect(repository.createCategory(owner, owner, { name: 'Rollback category', description: null, parentId: null })).rejects.toThrow(/test audit failure/);
      const result = await pool.query('SELECT count(*)::int AS count FROM personal_finance.categories WHERE account_id=$1 AND name=$2', [owner, 'Rollback category']);
      expect(result.rows[0].count).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS personal_finance_test_reject_category_event ON personal_finance.category_events; DROP FUNCTION IF EXISTS personal_finance.test_reject_category_event();');
    }
  });

  it('does not create default categories for accounts created after the category migration', async () => {
    const owner = await account();
    expect(await repository.listCategories(owner)).toEqual([]);
  });

  it('serializes concurrent source-key retries and reports one durable record', async () => {
    const owner = await account();
    const sourceId = randomUUID();
    const results = await Promise.all([
      repository.importExpenses(owner, owner, [row(sourceId)]),
      repository.importExpenses(owner, owner, [row(sourceId)]),
    ]);
    expect(results.reduce((sum, result) => sum + result.imported, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.duplicates, 0)).toBe(1);
    expect(await repository.queryExpenses(owner, { limit: 10 })).toHaveLength(1);
  });

  it('rolls back parent rows and provenance when an item constraint fails', async () => {
    const owner = await account();
    const sourceId = randomUUID();
    const invalid = row(sourceId, { items: [{ description: 'Item', productCode: null, quantity: '1', unit: 'piece', unitPrice: '1', discount: '0', tax: '0', lineTotal: '1', currency: 'BGN', sourceReceiptId: randomUUID() }] });
    await expect(repository.importExpenses(owner, owner, [invalid])).rejects.toThrow();
    const result = await pool.query('SELECT count(*)::int AS count FROM personal_finance.expenses WHERE account_id=$1', [owner]);
    expect(result.rows[0].count).toBe(0);
  });

  it('confirms the same draft idempotently and prevents another account from reading it', async () => {
    const owner = await account();
    const other = await account();
    const draft = await repository.createDraft(owner, owner, {
      date: '2025-02-10', amount: '12.34', currency: 'EUR', merchantName: 'Shop', category: 'Groceries', description: 'Food',
      tags: [], items: [], receipts: [], sourceKind: 'assistant-text', sourceId: randomUUID(), extractionProvider: 'local', extractionModel: null,
    });
    const first = await repository.confirmDraft(owner, draft.id, owner);
    const retry = await repository.confirmDraft(owner, draft.id, owner);
    expect(first?.id).toBe(retry?.id);
    expect(await repository.getDraft(other, draft.id)).toBeNull();
    expect(await repository.queryExpenses(owner, { limit: 10 })).toHaveLength(1);
  });

  it('persists an account-private receipt extraction through review, item confirmation, duplicate retry, attachment and document deletion audit', async () => {
    const owner = await account();
    const other = await account();
    const category = await repository.createCategory(owner, owner, { name: 'Groceries', description: null, parentId: null });
    const contentHash = randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);
    const extraction = {
      schemaVersion: 'receipt-extraction-v1' as const,
      documentType: { value: 'receipt', confidence: 0.99, uncertainty: null, sourceText: 'Receipt' },
      merchant: { value: 'Store', confidence: 0.9, uncertainty: null, sourceText: 'Store' },
      date: { value: '2025-03-01', confidence: 0.9, uncertainty: null, sourceText: '01.03.2025' },
      time: { value: null, confidence: null, uncertainty: null, sourceText: null },
      currency: { value: 'EUR', confidence: 0.99, uncertainty: null, sourceText: 'EUR' },
      subtotal: { value: '12.34', confidence: 0.9, uncertainty: null, sourceText: '12,34' },
      taxTotal: { value: null, confidence: null, uncertainty: null, sourceText: null },
      discountTotal: { value: null, confidence: null, uncertainty: null, sourceText: null },
      depositTotal: { value: null, confidence: null, uncertainty: null, sourceText: null },
      reportedArticleCount: { value: null, confidence: null, uncertainty: null, sourceText: null },
      total: { value: '12.34', confidence: 0.99, uncertainty: null, sourceText: '12,34' },
      adjustments: [], sourceText: 'Bread 12,34 EUR', warnings: [],
      items: [{ originalDescription: { value: 'Bread', confidence: 0.9, uncertainty: null, sourceText: 'Bread' }, normalizedDescription: { value: null, confidence: null, uncertainty: null, sourceText: null }, quantity: { value: '1', confidence: 0.9, uncertainty: null, sourceText: '1' }, unit: { value: 'each', confidence: 0.9, uncertainty: null, sourceText: '1' }, packaging: { value: null, confidence: null, uncertainty: null, sourceText: null }, unitPrice: { value: '12.34', confidence: 0.9, uncertainty: null, sourceText: '12,34' }, lineTotal: { value: '12.34', confidence: 0.9, uncertainty: null, sourceText: '12,34' }, discount: { value: '0', confidence: 0.9, uncertainty: null, sourceText: null }, tax: { value: '0', confidence: 0.9, uncertainty: null, sourceText: null }, taxIncluded: { value: false, confidence: 0.9, uncertainty: null, sourceText: null }, suggestedCategory: { value: 'Groceries', confidence: 0.8, uncertainty: null, sourceText: null } }],
    };
    const draft = await repository.createDraft(owner, owner, {
      date: '2025-03-01', amount: '12.34', currency: 'EUR', merchantName: 'Store', category: 'Groceries', description: 'Store', tags: [], items: [],
      receipts: [{ contentHash, mediaType: 'image/jpeg', byteLength: 4, storageKey: `${owner}/receipt.jpg`, status: 'review_required', extractedTotals: { subtotal: '12.34', tax: null, discount: null, total: '12.34', currency: 'EUR' }, parserProvider: 'test', parserModel: 'vision', extraction }],
      sourceKind: 'receipt', sourceId: `receipt:sha256:${contentHash}`, extractionProvider: 'test', extractionModel: 'vision',
    });
    const receipt = draft.receipts[0];
    expect(await repository.getReceipt(other, receipt.id)).toBeNull();
    await expect(repository.confirmDraft(owner, draft.id, owner)).rejects.toThrow(/review the receipt/i);
    const item = { description: 'Bread', productCode: null, quantity: '1', unit: 'each', unitPrice: '12.34', discount: '0', tax: '0', lineTotal: '12.34', currency: 'EUR', sourceReceiptId: receipt.id, categoryId: category.id, normalizedDescription: null, packaging: null, taxIncluded: false, extractionProvenance: { provider: 'test' } };
    await repository.updateDraft(owner, owner, draft.id, { date: '2025-03-01', amount: '12.34', currency: 'EUR', merchantName: 'Store', category: 'Groceries', categoryId: category.id, description: 'Store', items: [item], itemizationReviewed: true, totalOnly: false, adjustments: [] });
    await pool.query('DROP TRIGGER IF EXISTS personal_finance_test_fail_confirm ON personal_finance.provenance_events');
    await pool.query('DROP FUNCTION IF EXISTS public.personal_finance_test_fail_confirm()');
    await pool.query(`CREATE FUNCTION public.personal_finance_test_fail_confirm() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='expense.confirmed' THEN RAISE EXCEPTION 'forced confirmation rollback'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER personal_finance_test_fail_confirm BEFORE INSERT ON personal_finance.provenance_events FOR EACH ROW EXECUTE FUNCTION public.personal_finance_test_fail_confirm()');
    try {
      await expect(repository.confirmDraft(owner, draft.id, owner)).rejects.toThrow(/forced confirmation rollback/);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS personal_finance_test_fail_confirm ON personal_finance.provenance_events');
      await pool.query('DROP FUNCTION IF EXISTS public.personal_finance_test_fail_confirm()');
    }
    expect((await pool.query('SELECT count(*)::int AS count FROM personal_finance.expenses WHERE account_id=$1', [owner])).rows[0].count).toBe(0);
    expect((await repository.getDraft(owner, draft.id))?.status).toBe('needs_review');
    expect((await pool.query('SELECT 1 FROM personal_finance.receipts WHERE account_id=$1 AND id=$2 AND draft_id=$3 AND expense_id IS NULL', [owner, receipt.id, draft.id])).rowCount).toBe(1);
    const confirmed = await repository.confirmDraft(owner, draft.id, owner);
    const retry = await repository.confirmDraft(owner, draft.id, owner);
    expect(confirmed?.items).toMatchObject([{ description: 'Bread', quantity: '1', lineTotal: '12.34', categoryId: category.id }]);
    expect(retry?.id).toBe(confirmed?.id);
    expect((await pool.query('SELECT 1 FROM personal_finance.receipts WHERE account_id=$1 AND id=$2 AND draft_id IS NULL AND expense_id=$3', [owner, receipt.id, confirmed!.id])).rowCount).toBe(1);
    const confirmationEvents = await pool.query<{ event_type: string }>('SELECT event_type FROM personal_finance.provenance_events WHERE account_id=$1 AND draft_id=$2 ORDER BY occurred_at,id', [owner, draft.id]);
    expect(confirmationEvents.rows.map((event) => event.event_type)).toEqual(expect.arrayContaining(['draft.proposed', 'draft.reviewed', 'draft.confirmed', 'expense.confirmed']));
    const secondHash = randomUUID().replaceAll('-', '').padEnd(64, 'b').slice(0, 64);
    const pendingAttachment = await repository.createDraft(owner, owner, {
      date: '2025-03-01', amount: '12.34', currency: 'EUR', merchantName: 'Store', category: 'Groceries', description: 'Store', tags: [], items: [], receipts: [{
        contentHash: secondHash, mediaType: 'image/jpeg', byteLength: 4, storageKey: `${owner}/receipt-copy.jpg`, status: 'review_required',
        extractedTotals: { subtotal: '12.34', tax: null, discount: null, total: '12.34', currency: 'EUR' }, parserProvider: 'test', parserModel: 'vision', extraction,
      }], sourceKind: 'receipt', sourceId: `receipt:sha256:${secondHash}`, extractionProvider: 'test', extractionModel: 'vision',
    });
    const attachmentReceiptId = pendingAttachment.receipts[0].id;
    const attached = await repository.attachReceiptToExpense(owner, owner, attachmentReceiptId, confirmed!.id);
    expect(attached?.expenseId).toBe(confirmed?.id);
    expect((await pool.query('SELECT count(*)::int AS count FROM personal_finance.expenses WHERE account_id=$1 AND deleted_at IS NULL', [owner])).rows[0].count).toBe(1);
    const deleted = await repository.markReceiptDocumentDeleted(owner, owner, attachmentReceiptId);
    expect(deleted?.documentDeletedAt).toBeTruthy();
    const events = await pool.query<{ event_type: string }>('SELECT event_type FROM personal_finance.provenance_events WHERE account_id=$1 AND receipt_id=$2 ORDER BY occurred_at,id', [owner, attachmentReceiptId]);
    expect(events.rows.map((event) => event.event_type)).toEqual(expect.arrayContaining(['receipt.attached_to_expense', 'receipt.document_deleted']));
  });

  it('audits edits and soft deletion, and keeps deleted expenses out of reports', async () => {
    const owner = await account();
    const sourceId = randomUUID();
    await repository.importExpenses(owner, owner, [row(sourceId)]);
    const original = (await repository.queryExpenses(owner, { limit: 1 }))[0];
    const edited = await repository.updateExpense(owner, owner, original.id, row(sourceId, {
      amount: '136.1', amountEur: '69.5875', description: 'Nissan fuel', category: 'Auto', liters: '53.8',
      fx: { rate: '1.95583', convention: 'currency_units_per_eur', source: 'legacy-import', effectiveAt: null, provider: null },
    }));
    expect(edited?.description).toBe('Nissan fuel');
    expect(edited?.confirmedBy).toBe(original.confirmedBy);
    expect(edited?.confirmedAt).toBe(original.confirmedAt);
    const deleted = await repository.deleteExpense(owner, owner, original.id);
    expect(deleted).toBe(true);
    expect(await repository.queryExpenses(owner, { limit: 10 })).toHaveLength(0);
    const events = await pool.query<{ event_type: string }>('SELECT event_type FROM personal_finance.provenance_events WHERE account_id=$1 AND expense_id=$2 ORDER BY occurred_at', [owner, original.id]);
    expect(events.rows.map((event) => event.event_type)).toEqual(['expense.imported', 'expense.updated', 'expense.deleted']);
    const summary = await repository.summarize(owner, {});
    expect(summary.transactionCount).toBe(0);
  });

  it('uses the account/date and category/date indexes for scoped reporting', async () => {
    const client = await pool.connect();
    try {
      await client.query('SET enable_seqscan=off');
      const plan = await client.query<{ 'QUERY PLAN': string }>("EXPLAIN SELECT id FROM personal_finance.expenses WHERE account_id=$1 AND deleted_at IS NULL AND category=$2 AND expense_date >= $3 ORDER BY expense_date DESC", [randomUUID(), 'Fuel', '2025-01-01']);
      expect(plan.rows.map((line) => line['QUERY PLAN']).join('\n')).toContain('personal_finance_expenses_account_category_date');
    } finally { client.release(); }
  });
});
