import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { addDecimal, compareDecimal, decimalString, financeDecimal, roundDecimal } from '../../domain/decimal';
import { currencyMinorUnits, euroValue, normalizeMerchantName, reconcileItemsAgainstTotal } from '../../domain/expense-rules';
import type { ExpenseDraft, ExpenseDraftProposal, ExpenseItem, ExpenseQuery, ExpenseRecord, ExpenseSource, ExpenseSourceKind, FinanceCategory, ReceiptMetadata, SpendingSummary } from '../../domain/personal-finance.types';
import { ExpenseVersionConflictError } from '../../application/ports/personal-finance.repository';
import type { CategoryWrite, ExpenseDraftReviewWrite, ExpenseImportRow, ExpenseWrite, PersonalFinanceRepository, ReceiptReextractionWrite } from '../../application/ports/personal-finance.repository';

export const PERSONAL_FINANCE_POOL = Symbol('PERSONAL_FINANCE_POOL');

type ExpenseRow = QueryResultRow & {
  id: string; account_id: string; revision: number; expense_date: Date | string; amount: string; currency: string; amount_eur: string | null;
  fx_rate: string | null; fx_rate_convention: string | null; fx_source: string | null; fx_effective_at: Date | string | null;
  fx_provider: string | null; merchant_id: string | null; merchant_name: string | null; category: string; description: string;
  tags: string[]; liters: string | null; source_kind: ExpenseSourceKind; source_id: string | null; legacy_record_id: string | null;
  source_created_at: Date | string | null; source_updated_at: Date | string | null;
  confirmed_by: string; confirmed_at: Date | string; created_at: Date | string; updated_at: Date | string;
  category_id: string | null;
};
type CategoryRow = QueryResultRow & { id: string; account_id: string; name: string; description: string | null; parent_id: string | null; archived_at: Date | string | null; created_at: Date | string; updated_at: Date | string };
type DraftRow = QueryResultRow & {
  id: string; account_id: string; status: ExpenseDraft['status']; expense_date: Date | string | null; amount: string | null;
  currency: string | null; merchant_name: string | null; merchant_id: string | null; category: string | null; description: string | null;
  tags: string[]; source_kind: ExpenseSourceKind; source_id: string | null; extraction_provider: string | null; extraction_model: string | null;
  source_content_hash: string | null; confirmed_expense_id: string | null; created_at: Date | string; updated_at: Date | string;
};
type ItemRow = QueryResultRow & {
  id: string; expense_id?: string; description: string; product_code: string | null; quantity: string; unit: string; unit_price: string; discount: string;
  tax: string; line_total: string; currency: string; source_receipt_id: string | null; normalized_description: string | null; packaging: string | null;
  tax_included: boolean; category_id: string | null; extraction_provenance: Record<string, unknown>;
};
type ReceiptRow = QueryResultRow & {
  id: string; account_id: string; draft_id: string | null; expense_id: string | null; content_hash: string; media_type: string;
  byte_length: string | number; storage_key: string; status: ReceiptMetadata['status']; extracted_totals: ReceiptMetadata['extractedTotals'];
  parser_provider: string | null; parser_model: string | null; created_at: Date | string; extraction_result: ReceiptMetadata['extraction'];
  user_reviewed_at: Date | string | null; reviewed_as_total_only: boolean; document_deleted_at: Date | string | null;
  reviewed_adjustments: ReceiptMetadata['reviewedAdjustments'];
  reviewed_total: string | null; reviewed_currency: string | null;
};

export class PostgresPersonalFinanceRepository implements PersonalFinanceRepository {
  constructor(private readonly pool: Pool) {}

  async listCategories(accountId: string, includeArchived = false): Promise<FinanceCategory[]> {
    const result = await this.pool.query<CategoryRow>(
      `SELECT * FROM personal_finance.categories WHERE account_id=$1 ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY lower(name),id`,
      [accountId],
    );
    return result.rows.map(mapCategory);
  }

  async createCategory(accountId: string, actorId: string, input: CategoryWrite): Promise<FinanceCategory> {
    return this.transaction(async (client) => {
      await this.lockCategoryAccount(client, accountId);
      await this.assertValidParent(client, accountId, input.parentId, null);
      const id = randomUUID();
      const result = await client.query<CategoryRow>(
        `INSERT INTO personal_finance.categories(id,account_id,name,description,parent_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, accountId, input.name, input.description, input.parentId],
      );
      await this.insertCategoryEvent(client, accountId, actorId, id, 'category.created', { category: mapCategory(result.rows[0]) });
      return mapCategory(result.rows[0]);
    });
  }

  async renameCategory(accountId: string, actorId: string, categoryId: string, input: CategoryWrite): Promise<FinanceCategory | null> {
    return this.transaction(async (client) => {
      await this.lockCategoryAccount(client, accountId);
      const before = await client.query<CategoryRow>('SELECT * FROM personal_finance.categories WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE', [accountId, categoryId]);
      if (!before.rows[0]) return null;
      await this.assertValidParent(client, accountId, input.parentId, categoryId);
      const result = await client.query<CategoryRow>(
        `UPDATE personal_finance.categories SET name=$3,description=$4,parent_id=$5,updated_at=now()
         WHERE account_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,
        [accountId, categoryId, input.name, input.description, input.parentId],
      );
      const updated = mapCategory(result.rows[0]);
      await this.insertCategoryEvent(client, accountId, actorId, categoryId, 'category.renamed', { before: mapCategory(before.rows[0]), after: updated });
      return updated;
    });
  }

  async archiveCategory(accountId: string, actorId: string, categoryId: string): Promise<FinanceCategory | null> {
    return this.transaction(async (client) => {
      await this.lockCategoryAccount(client, accountId);
      const children = await client.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM personal_finance.categories WHERE account_id=$1 AND parent_id=$2 AND archived_at IS NULL) AS exists',
        [accountId, categoryId],
      );
      if (children.rows[0]?.exists) throw new Error('Reparent or archive active child categories first');
      const result = await client.query<CategoryRow>(
        `UPDATE personal_finance.categories SET archived_at=now(),updated_at=now()
         WHERE account_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,
        [accountId, categoryId],
      );
      if (!result.rows[0]) return null;
      const archived = mapCategory(result.rows[0]);
      await this.insertCategoryEvent(client, accountId, actorId, categoryId, 'category.archived', { category: archived });
      return archived;
    });
  }

  private async lockCategoryAccount(client: PoolClient, accountId: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [accountId]);
  }

  private async assertValidParent(client: PoolClient, accountId: string, parentId: string | null, categoryId: string | null) {
    if (!parentId) return;
    if (parentId === categoryId) throw new Error('A category cannot be its own parent');
    const result = await client.query<{ id: string }>(
      `WITH RECURSIVE ancestors AS (
         SELECT id,parent_id FROM personal_finance.categories WHERE account_id=$1 AND id=$2 AND archived_at IS NULL
         UNION ALL
         SELECT c.id,c.parent_id FROM personal_finance.categories c JOIN ancestors a ON c.id=a.parent_id
          WHERE c.account_id=$1 AND c.archived_at IS NULL
       )
       SELECT id FROM ancestors WHERE id=$3
       UNION ALL
       SELECT id FROM personal_finance.categories WHERE account_id=$1 AND id=$2 AND archived_at IS NULL`,
      [accountId, parentId, categoryId],
    );
    if (!result.rows.length) throw new Error('Parent category must be active and belong to this account');
    if (categoryId && result.rows.some((row) => row.id === categoryId)) throw new Error('Category hierarchy cannot contain a cycle');
  }

  private async insertCategoryEvent(client: PoolClient, accountId: string, actorId: string, categoryId: string, eventType: string, details: Record<string, unknown>) {
    await client.query(
      'INSERT INTO personal_finance.category_events(id,account_id,category_id,actor_user_id,event_type,details) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), accountId, categoryId, actorId, eventType, details],
    );
  }

  async queryExpenses(accountId: string, query: ExpenseQuery): Promise<ExpenseRecord[]> {
    const values: unknown[] = [accountId];
    const where = ['e.account_id = $1', 'e.deleted_at IS NULL'];
    if (query.fromDate) { values.push(query.fromDate); where.push(`e.expense_date >= $${values.length}`); }
    if (query.toDate) { values.push(query.toDate); where.push(`e.expense_date <= $${values.length}`); }
    if (query.category) { values.push(query.category); where.push(`COALESCE(c.name,e.category) = $${values.length}`); }
    if (query.categoryId) { values.push(query.categoryId); where.push(`e.category_id = $${values.length}`); }
    if (query.merchantId) { values.push(query.merchantId); where.push(`e.merchant_id = $${values.length}`); }
    if (query.text) {
      values.push(`%${query.text}%`);
      where.push(`(e.description ILIKE $${values.length} OR e.merchant_name ILIKE $${values.length} OR COALESCE(c.name,e.category) ILIKE $${values.length} OR array_to_string(e.tags, ' ') ILIKE $${values.length}
        OR EXISTS (SELECT 1 FROM personal_finance.expense_items i WHERE i.account_id=$1 AND i.expense_id=e.id AND (i.description ILIKE $${values.length} OR i.product_code ILIKE $${values.length})))`);
    }
    if (query.before) { values.push(query.before); where.push(`(e.expense_date, e.id) < ($${values.length}::date, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)`); }
    values.push(query.limit ?? 200);
    const rows = await this.pool.query<ExpenseRow>(
      `SELECT e.*,COALESCE(c.name,e.category) AS category FROM personal_finance.expenses e LEFT JOIN personal_finance.categories c ON c.account_id=e.account_id AND c.id=e.category_id WHERE ${where.join(' AND ')} ORDER BY e.expense_date DESC, e.id DESC LIMIT $${values.length}`,
      values,
    );
    return this.attachExpenseItems(accountId, rows.rows);
  }

  async getExpense(accountId: string, expenseId: string): Promise<ExpenseRecord | null> {
    const result = await this.pool.query<ExpenseRow>(
      'SELECT e.*,COALESCE(c.name,e.category) AS category FROM personal_finance.expenses e LEFT JOIN personal_finance.categories c ON c.account_id=e.account_id AND c.id=e.category_id WHERE e.account_id = $1 AND e.id = $2 AND e.deleted_at IS NULL',
      [accountId, expenseId],
    );
    if (!result.rows[0]) return null;
    return (await this.attachExpenseItems(accountId, result.rows))[0] ?? null;
  }

  async updateExpense(accountId: string, actorId: string, expenseId: string, input: ExpenseWrite, expectedRevision: number): Promise<ExpenseRecord | null> {
    return this.transaction(async (client) => {
      const before = await this.getExpenseWithClient(client, accountId, expenseId, true);
      if (!before) return null;
      if (before.revision !== expectedRevision) throw new ExpenseVersionConflictError();
      const effectiveInput = await this.applyActiveCategory(client, accountId, input, Boolean(before.categoryId && before.categoryId === input.categoryId));
      const converted = euroValue(effectiveInput.amount, effectiveInput.currency, effectiveInput.amountEur, effectiveInput.fx);
      const merchantId = await this.resolveMerchant(client, accountId, effectiveInput.merchantName);
      const updated = await client.query(
        `UPDATE personal_finance.expenses SET expense_date=$3,amount=$4,currency=$5,amount_eur=$6,
          fx_rate=$7,fx_rate_convention=$8,fx_source=$9,fx_effective_at=$10,fx_provider=$11,
          merchant_id=$12,merchant_name=$13,category=$14,description=$15,tags=$16,liters=$17,category_id=$18,
          revision=revision+1,updated_at=now()
         WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL AND revision=$19 RETURNING id`,
        [accountId, expenseId, effectiveInput.date, effectiveInput.amount, effectiveInput.currency, converted.amountEur, effectiveInput.fx?.rate ?? null,
          effectiveInput.fx?.convention ?? null, effectiveInput.fx?.source ?? null, effectiveInput.fx?.effectiveAt ?? null, effectiveInput.fx?.provider ?? null,
          merchantId, effectiveInput.merchantName, effectiveInput.category, effectiveInput.description, effectiveInput.tags, effectiveInput.liters, effectiveInput.categoryId ?? null, expectedRevision],
      );
      if (!updated.rows[0]) throw new ExpenseVersionConflictError();
      await client.query('DELETE FROM personal_finance.expense_items WHERE account_id=$1 AND expense_id=$2', [accountId, expenseId]);
      await this.insertItems(client, accountId, expenseId, effectiveInput.items);
      await this.insertEvent(client, accountId, { kind: before.sourceKind, id: before.sourceId, provider: effectiveInput.source.provider, model: effectiveInput.source.model }, 'expense.updated', {
        expenseId, actorId,
        before: { date: before.date, amount: before.amount, currency: before.currency, amountEur: before.amountEur, fx: before.fx, merchantId: before.merchantId, merchantName: before.merchantName, category: before.category, description: before.description, tags: before.tags, liters: before.liters, sourceKind: before.sourceKind, sourceId: before.sourceId, confirmedBy: before.confirmedBy, confirmedAt: before.confirmedAt, items: before.items },
        after: { date: input.date, amount: input.amount, currency: input.currency, amountEur: converted.amountEur, fx: input.fx, merchantId, merchantName: input.merchantName, category: input.category, description: input.description, tags: input.tags, liters: input.liters, sourceKind: before.sourceKind, sourceId: before.sourceId, confirmedBy: before.confirmedBy, confirmedAt: before.confirmedAt, updatedBy: actorId, items: input.items },
      });
      return this.getExpenseWithClient(client, accountId, expenseId);
    });
  }

  async deleteExpense(accountId: string, actorId: string, expenseId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const before = await this.getExpenseWithClient(client, accountId, expenseId, true);
      if (!before) return false;
      const result = await client.query(
        'UPDATE personal_finance.expenses SET deleted_at=now(),updated_at=now() WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id',
        [accountId, expenseId],
      );
      if (!result.rows[0]) return false;
      await this.insertEvent(client, accountId, { kind: before.sourceKind, id: before.sourceId }, 'expense.deleted', { expenseId, actorId, snapshot: before });
      return true;
    });
  }

  async findImportedLegacyIds(accountId: string, ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return [];
    const result = await this.pool.query<{ legacy_record_id: string }>(
      'SELECT legacy_record_id FROM personal_finance.expenses WHERE account_id=$1 AND legacy_record_id=ANY($2::text[])',
      [accountId, [...ids]],
    );
    return result.rows.map((row) => row.legacy_record_id);
  }

  async createExpense(accountId: string, actorId: string, input: ExpenseWrite): Promise<ExpenseRecord> {
    return this.transaction(async (client) => {
      input = await this.applyActiveCategory(client, accountId, input);
      const id = randomUUID();
      const converted = euroValue(input.amount, input.currency, input.amountEur, input.fx);
      const sourceId = input.source.id ?? id;
      const inserted = await this.insertExpense(client, accountId, actorId, id, input, null, converted.amountEur, sourceId, null, true);
      if (!inserted) {
        const existing = await client.query<ExpenseRow>(
          'SELECT * FROM personal_finance.expenses WHERE account_id=$1 AND source_kind=$2 AND source_id=$3',
          [accountId, input.source.kind, sourceId],
        );
        if (existing.rows[0]) {
          const duplicate = await this.getExpenseWithClient(client, accountId, existing.rows[0].id);
          if (duplicate) return duplicate;
          throw new Error('This source key belongs to an expense that is already deleted');
        }
      }
      const merchantId = await this.resolveMerchant(client, accountId, input.merchantName);
      if (merchantId) await client.query('UPDATE personal_finance.expenses SET merchant_id=$3 WHERE account_id=$1 AND id=$2', [accountId, id, merchantId]);
      await this.insertItems(client, accountId, id, input.items);
      await this.insertEvent(client, accountId, { kind: input.source.kind, id: input.source.id ?? id, provider: input.source.provider, model: input.source.model, contentHash: input.source.contentHash }, 'expense.confirmed', { expenseId: id, actorId });
      return (await this.getExpenseWithClient(client, accountId, id))!;
    });
  }

  async importExpenses(accountId: string, actorId: string, rows: readonly ExpenseImportRow[]): Promise<{ imported: number; duplicates: number }> {
    return this.transaction(async (client) => {
      let imported = 0;
      let duplicates = 0;
      for (const row of rows) {
        const id = randomUUID();
        const sourceId = row.source.id ?? row.legacyRecordId;
        if (!sourceId) throw new Error('Every imported expense needs a stable source-specific idempotency key');
        const converted = euroValue(row.amount, row.currency, row.amountEur, row.fx);
        const result = await this.insertExpense(client, accountId, actorId, id, row, null, converted.amountEur, sourceId, row.legacyRecordId, true);
        if (!result) { duplicates++; continue; }
        const merchantId = await this.resolveMerchant(client, accountId, row.merchantName);
        if (merchantId) await client.query('UPDATE personal_finance.expenses SET merchant_id=$3 WHERE account_id=$1 AND id=$2', [accountId, id, merchantId]);
        await this.insertItems(client, accountId, id, row.items);
        await this.insertEvent(client, accountId, { ...row.source, id: sourceId }, 'expense.imported', { expenseId: id, legacyRecordId: row.legacyRecordId, actorId });
        imported++;
      }
      return { imported, duplicates };
    });
  }

  async createDraft(accountId: string, actorId: string, proposal: ExpenseDraftProposal): Promise<ExpenseDraft> {
    return this.transaction(async (client) => {
      const id = randomUUID();
      const source = { kind: proposal.sourceKind, id: proposal.sourceId, provider: proposal.extractionProvider, model: proposal.extractionModel };
      const inserted = await client.query(
        `INSERT INTO personal_finance.expense_drafts
          (id,account_id,status,expense_date,amount,currency,merchant_name,merchant_id,category,description,tags,source_kind,source_id,extraction_provider,extraction_model,source_content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (account_id,source_kind,source_id) WHERE source_id IS NOT NULL DO NOTHING RETURNING id`,
        [id, accountId, proposal.sourceKind === 'receipt' ? 'needs_review' : 'proposed', proposal.date, proposal.amount, proposal.currency, proposal.merchantName, null, proposal.category, proposal.description, proposal.tags, proposal.sourceKind, proposal.sourceId, proposal.extractionProvider, proposal.extractionModel, null],
      );
      if (!inserted.rows[0] && proposal.sourceId) {
        const existing = await client.query<DraftRow>(
          'SELECT * FROM personal_finance.expense_drafts WHERE account_id=$1 AND source_kind=$2 AND source_id=$3',
          [accountId, proposal.sourceKind, proposal.sourceId],
        );
        return existing.rows[0] ? this.loadDraftWithClient(client, accountId, existing.rows[0]) : this.missingDraft();
      }
      const merchantId = await this.resolveMerchant(client, accountId, proposal.merchantName);
      if (merchantId) await client.query('UPDATE personal_finance.expense_drafts SET merchant_id=$3 WHERE account_id=$1 AND id=$2', [accountId, id, merchantId]);
      const receipts: ReceiptMetadata[] = [];
      for (const receipt of proposal.receipts) {
        const created = await this.insertReceipt(client, accountId, id, receipt);
        receipts.push(created);
        await this.insertEvent(client, accountId, { kind: 'receipt', id: created.id, contentHash: receipt.contentHash, provider: receipt.parserProvider, model: receipt.parserModel }, 'receipt.extracted', { draftId: id, receiptId: created.id, mediaType: receipt.mediaType, byteLength: receipt.byteLength });
      }
      const receiptItems = proposal.items.map((item) => ({ ...item, sourceReceiptId: item.sourceReceiptId ?? (receipts.length === 1 ? receipts[0].id : null) }));
      await this.insertDraftItems(client, accountId, id, receiptItems);
      await this.insertEvent(client, accountId, source, 'draft.proposed', { draftId: id, actorId });
      const row = await this.getDraftRow(client, accountId, id);
      return row ? this.loadDraftWithClient(client, accountId, row) : this.missingDraft();
    });
  }

  async getDraft(accountId: string, draftId: string): Promise<ExpenseDraft | null> {
    const row = await this.getDraftRow(this.pool, accountId, draftId);
    return row ? this.loadDraftWithClient(this.pool, accountId, row) : null;
  }

  async reopenRejectedReceiptDraft(accountId: string, actorId: string, receiptId: string): Promise<ExpenseDraft | null> {
    return this.transaction(async (client) => {
      const receipt = await client.query<ReceiptRow>('SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND id=$2 FOR UPDATE', [accountId, receiptId]);
      const draftId = receipt.rows[0]?.draft_id;
      if (!draftId || receipt.rows[0].expense_id) return null;
      const updated = await client.query<DraftRow>(`UPDATE personal_finance.expense_drafts SET status='needs_review',updated_at=now()
        WHERE account_id=$1 AND id=$2 AND status='rejected' RETURNING *`, [accountId, draftId]);
      if (!updated.rows[0]) return null;
      await this.insertEvent(client, accountId, { kind: 'receipt', id: receiptId, contentHash: receipt.rows[0].content_hash, provider: receipt.rows[0].parser_provider, model: receipt.rows[0].parser_model }, 'draft.reopened', { draftId, receiptId, actorId });
      return this.loadDraftWithClient(client, accountId, updated.rows[0]);
    });
  }

  async rejectDraft(accountId: string, draftId: string, actorId: string): Promise<ExpenseDraft | null> {
    return this.transaction(async (client) => {
      const row = await client.query<DraftRow>(
        `UPDATE personal_finance.expense_drafts SET status='rejected',updated_at=now()
         WHERE account_id=$1 AND id=$2 AND status IN ('proposed','needs_review') RETURNING *`,
        [accountId, draftId],
      );
      if (!row.rows[0]) {
        const existing = await this.getDraftRow(client, accountId, draftId);
        return existing?.status === 'rejected' ? this.loadDraftWithClient(client, accountId, existing) : null;
      }
      await this.insertEvent(client, accountId, { kind: 'manual', id: draftId }, 'draft.rejected', { draftId, actorId });
      return this.loadDraftWithClient(client, accountId, row.rows[0]);
    });
  }

  async confirmDraft(accountId: string, draftId: string, actorId: string): Promise<ExpenseRecord | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<DraftRow>(
        'SELECT * FROM personal_finance.expense_drafts WHERE account_id=$1 AND id=$2 FOR UPDATE',
        [accountId, draftId],
      );
      const draft = selected.rows[0];
      if (!draft) return null;
      if (draft.status === 'confirmed' && draft.confirmed_expense_id) return this.getExpenseWithClient(client, accountId, draft.confirmed_expense_id);
      if (!['proposed', 'needs_review'].includes(draft.status)) throw new Error('Only a reviewable draft can be confirmed');
      if (!draft.expense_date || !draft.amount || !draft.currency || !draft.category || !draft.description)
        throw new Error('Draft needs a date, amount, currency, category, and description before confirmation');
      const draftItems = await this.listDraftItems(client, accountId, draftId);
      const receipts = await this.listReceipts(client, accountId, draftId);
      this.assertReceiptsReconcile(draftItems, receipts, draft.amount, draft.currency.trim());
      const source: ExpenseSource = { kind: draft.source_kind, id: draft.source_id, provider: draft.extraction_provider, model: draft.extraction_model, contentHash: draft.source_content_hash };
      const input: ExpenseWrite = {
        date: isoDate(draft.expense_date), amount: draft.amount, currency: draft.currency.trim(), amountEur: null,
        fx: null, merchantName: draft.merchant_name, category: draft.category, description: draft.description,
        tags: draft.tags ?? [], items: draftItems, liters: null, source,
      };
      const matchingCategory = await client.query<{ id: string }>(
        'SELECT id FROM personal_finance.categories WHERE account_id=$1 AND lower(btrim(name))=lower(btrim($2)) AND archived_at IS NULL',
        [accountId, draft.category],
      );
      if (matchingCategory.rows[0]) input.categoryId = matchingCategory.rows[0].id;
      const id = randomUUID();
      const merchantId = await this.resolveMerchant(client, accountId, input.merchantName);
      const converted = euroValue(input.amount, input.currency, input.amountEur, input.fx);
      await this.insertExpense(client, accountId, actorId, id, input, merchantId, converted.amountEur, source.id ?? id);
      await this.insertItems(client, accountId, id, draftItems);
      await client.query('UPDATE personal_finance.receipts SET draft_id=NULL,expense_id=$3 WHERE account_id=$1 AND draft_id=$2', [accountId, draftId, id]);
      await client.query(`UPDATE personal_finance.expense_drafts SET status='confirmed',confirmed_expense_id=$3,updated_at=now() WHERE account_id=$1 AND id=$2`, [accountId, draftId, id]);
      await this.insertEvent(client, accountId, source, 'draft.confirmed', { draftId, expenseId: id, actorId });
      await this.insertEvent(client, accountId, source, 'expense.confirmed', { expenseId: id, draftId, actorId });
      return this.getExpenseWithClient(client, accountId, id);
    });
  }

  async addReceiptMetadata(accountId: string, draftId: string, receipt: Omit<ReceiptMetadata, 'id' | 'accountId' | 'draftId' | 'expenseId' | 'createdAt'>): Promise<ReceiptMetadata> {
    return this.transaction(async (client) => {
      const draft = await this.getDraftRow(client, accountId, draftId);
      if (!draft || !['proposed', 'needs_review'].includes(draft.status)) throw new Error('Receipt requires an active expense draft');
      const created = await this.insertReceipt(client, accountId, draftId, receipt);
      await this.insertEvent(client, accountId, { kind: 'receipt', id: created.id, contentHash: receipt.contentHash, provider: receipt.parserProvider, model: receipt.parserModel }, 'receipt.attached', { draftId, receiptId: created.id });
      return created;
    });
  }

  async findReceiptByHash(accountId: string, contentHash: string): Promise<ReceiptMetadata | null> {
    const result = await this.pool.query<ReceiptRow>('SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND content_hash=$2', [accountId, contentHash.toLowerCase()]);
    return result.rows[0] ? mapReceipt(result.rows[0]) : null;
  }

  async findPossibleReceiptMatches(accountId: string, date: string, amount: string, currency: string, merchantName: string | null): Promise<ExpenseRecord[]> {
    const result = await this.pool.query<ExpenseRow>(
      `SELECT e.*,COALESCE(c.name,e.category) AS category FROM personal_finance.expenses e
       LEFT JOIN personal_finance.categories c ON c.account_id=e.account_id AND c.id=e.category_id
       WHERE e.account_id=$1 AND e.deleted_at IS NULL AND e.expense_date=$2 AND e.amount=$3::numeric AND upper(trim(e.currency))=upper($4)
       AND ($5::text IS NULL OR lower(trim(COALESCE(e.merchant_name,'')))=lower(trim($5))) ORDER BY e.created_at DESC LIMIT 50`,
      [accountId, date, financeDecimal(amount), currency, merchantName],
    );
    return this.attachExpenseItems(accountId, result.rows);
  }

  async getReceipt(accountId: string, receiptId: string): Promise<ReceiptMetadata | null> {
    const result = await this.pool.query<ReceiptRow>('SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND id=$2', [accountId, receiptId]);
    return result.rows[0] ? mapReceipt(result.rows[0]) : null;
  }

  async replaceReceiptExtraction(accountId: string, actorId: string, receiptId: string, input: ReceiptReextractionWrite): Promise<ExpenseDraft | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<ReceiptRow>(
        'SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND id=$2 FOR UPDATE',
        [accountId, receiptId],
      );
      const receipt = selected.rows[0];
      if (!receipt || !receipt.draft_id || receipt.expense_id || receipt.user_reviewed_at || receipt.document_deleted_at || receipt.status !== 'review_required') return null;
      const row = await client.query<DraftRow>(
        'SELECT * FROM personal_finance.expense_drafts WHERE account_id=$1 AND id=$2 FOR UPDATE',
        [accountId, receipt.draft_id],
      );
      if (!row.rows[0] || !['proposed', 'needs_review'].includes(row.rows[0].status)) return null;

      await client.query(
        `UPDATE personal_finance.receipts SET extracted_totals=$3,parser_provider=$4,parser_model=$5,extraction_result=$6,status='review_required'
         WHERE account_id=$1 AND id=$2`,
        [accountId, receiptId, JSON.stringify(input.extractedTotals), input.parserProvider, input.parserModel, JSON.stringify(input.extraction)],
      );
      await client.query(
        `UPDATE personal_finance.expense_drafts SET expense_date=$3,amount=$4,currency=$5,merchant_name=$6,description=$7,
         category=$8,extraction_provider=$9,extraction_model=$10,status='needs_review',updated_at=now()
         WHERE account_id=$1 AND id=$2`,
        [accountId, receipt.draft_id, input.date, input.amount, input.currency, input.merchantName, input.merchantName, input.category, input.parserProvider, input.parserModel],
      );
      await client.query('DELETE FROM personal_finance.expense_draft_items WHERE account_id=$1 AND draft_id=$2', [accountId, receipt.draft_id]);
      const items = input.items.map((item) => ({ ...item, sourceReceiptId: receiptId }));
      await this.insertDraftItems(client, accountId, receipt.draft_id, items);
      await this.insertEvent(client, accountId, { kind: 'receipt', id: receiptId, contentHash: receipt.content_hash, provider: input.parserProvider, model: input.parserModel }, 'receipt.reextracted', {
        draftId: receipt.draft_id, receiptId, actorId, extractedLineCount: input.extraction.items.length,
        completeDraftItemCount: items.length, reportedArticleCount: input.extraction.reportedArticleCount.value,
      });
      const refreshed = await this.getDraftRow(client, accountId, receipt.draft_id);
      return refreshed ? this.loadDraftWithClient(client, accountId, refreshed) : null;
    });
  }

  async markReceiptDocumentDeleted(accountId: string, actorId: string, receiptId: string): Promise<ReceiptMetadata | null> {
    return this.transaction(async (client) => {
      const before = await client.query<ReceiptRow>('SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND id=$2 FOR UPDATE', [accountId, receiptId]);
      if (!before.rows[0]) return null;
      if (!before.rows[0].document_deleted_at) {
        const result = await client.query<ReceiptRow>('UPDATE personal_finance.receipts SET document_deleted_at=now() WHERE account_id=$1 AND id=$2 RETURNING *', [accountId, receiptId]);
        await this.insertEvent(client, accountId, { kind: 'receipt', id: receiptId, contentHash: before.rows[0].content_hash, provider: before.rows[0].parser_provider, model: before.rows[0].parser_model }, 'receipt.document_deleted', { receiptId, actorId });
        return mapReceipt(result.rows[0]);
      }
      return mapReceipt(before.rows[0]);
    });
  }

  async updateDraft(accountId: string, actorId: string, draftId: string, input: ExpenseDraftReviewWrite): Promise<ExpenseDraft | null> {
    return this.transaction(async (client) => {
      const row = await client.query<DraftRow>('SELECT * FROM personal_finance.expense_drafts WHERE account_id=$1 AND id=$2 FOR UPDATE', [accountId, draftId]);
      if (!row.rows[0] || !['proposed', 'needs_review'].includes(row.rows[0].status)) return null;
      const receiptsForReview = await this.listReceipts(client, accountId, draftId);
      const items = input.items.map((item) => ({ ...item, sourceReceiptId: item.sourceReceiptId ?? null }));
      await client.query(
        `UPDATE personal_finance.expense_drafts SET expense_date=$3,amount=$4,currency=$5,merchant_name=$6,category=$7,description=$8,status='needs_review',updated_at=now()
         WHERE account_id=$1 AND id=$2`,
        [accountId, draftId, input.date, input.amount, input.currency, input.merchantName, input.category, input.description],
      );
      await client.query('DELETE FROM personal_finance.expense_draft_items WHERE account_id=$1 AND draft_id=$2', [accountId, draftId]);
      await this.insertDraftItems(client, accountId, draftId, items);
      if (receiptsForReview.length) {
        await client.query(
          `UPDATE personal_finance.receipts SET user_reviewed_at=now(),reviewed_as_total_only=$3,status='review_required',reviewed_adjustments=$4,reviewed_total=$5,reviewed_currency=$6
           WHERE account_id=$1 AND draft_id=$2`,
          [accountId, draftId, input.totalOnly, JSON.stringify(input.adjustments), input.amount, input.currency],
        );
      }
      if (input.categoryId) {
        const selected = await client.query('SELECT 1 FROM personal_finance.categories WHERE account_id=$1 AND id=$2 AND archived_at IS NULL', [accountId, input.categoryId]);
        if (!selected.rows[0]) throw new Error('Selected category is unavailable for this account');
      }
      const reviewRevisionHash = createHash('sha256').update(JSON.stringify({ date: input.date, amount: input.amount, currency: input.currency, merchantName: input.merchantName, category: input.category, categoryId: input.categoryId, description: input.description, items, adjustments: input.adjustments, totalOnly: input.totalOnly })).digest('hex');
      await this.insertEvent(client, accountId, { kind: 'receipt', id: draftId }, 'draft.reviewed', { draftId, receiptId: receiptsForReview[0]?.id ?? null, actorId, itemCount: items.length, itemizationReviewed: input.itemizationReviewed, financialFindingsAcknowledged: input.financialFindingsAcknowledged === true, totalOnly: input.totalOnly, adjustmentCount: input.adjustments.length, reviewRevisionHash });
      const refreshed = await this.getDraftRow(client, accountId, draftId);
      return refreshed ? this.loadDraftWithClient(client, accountId, refreshed) : null;
    });
  }

  async attachReceiptToExpense(accountId: string, actorId: string, receiptId: string, expenseId: string): Promise<ReceiptMetadata | null> {
    return this.transaction(async (client) => {
      const receipt = await client.query<ReceiptRow>('SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND id=$2 FOR UPDATE', [accountId, receiptId]);
      const expense = await client.query('SELECT 1 FROM personal_finance.expenses WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR KEY SHARE', [accountId, expenseId]);
      if (!receipt.rows[0] || !expense.rows[0] || receipt.rows[0].expense_id) return null;
      const draftId = receipt.rows[0].draft_id;
      await client.query('UPDATE personal_finance.receipts SET draft_id=NULL,expense_id=$3,status=\'attached\' WHERE account_id=$1 AND id=$2', [accountId, receiptId, expenseId]);
      if (draftId) await client.query("UPDATE personal_finance.expense_drafts SET status='rejected',updated_at=now() WHERE account_id=$1 AND id=$2 AND status IN ('proposed','needs_review')", [accountId, draftId]);
      await this.insertEvent(client, accountId, { kind: 'receipt', id: receiptId, contentHash: receipt.rows[0].content_hash, provider: receipt.rows[0].parser_provider, model: receipt.rows[0].parser_model }, 'receipt.attached_to_expense', { receiptId, expenseId, draftId, actorId });
      const updated = await client.query<ReceiptRow>('SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND id=$2', [accountId, receiptId]);
      return updated.rows[0] ? mapReceipt(updated.rows[0]) : null;
    });
  }

  async summarize(accountId: string, query: Pick<ExpenseQuery, 'fromDate' | 'toDate'>): Promise<SpendingSummary> {
    const values: unknown[] = [accountId];
    const where = ['account_id=$1', 'deleted_at IS NULL'];
    if (query.fromDate) { values.push(query.fromDate); where.push(`expense_date >= $${values.length}`); }
    if (query.toDate) { values.push(query.toDate); where.push(`expense_date <= $${values.length}`); }
    const clause = where.join(' AND ');
    const productWhere = ['e.account_id=$1', 'e.deleted_at IS NULL'];
    if (query.fromDate) productWhere.push('e.expense_date >= $2');
    if (query.toDate) productWhere.push(`e.expense_date <= $${query.fromDate ? 3 : 2}`);
    const [total, categories, merchants, products, months, count] = await Promise.all([
      this.pool.query<{ total: string | null; unconverted: string }>(`SELECT SUM(amount_eur)::text AS total,COUNT(*) FILTER (WHERE amount_eur IS NULL)::text AS unconverted FROM personal_finance.expenses WHERE ${clause}`, values),
      this.pool.query<{ category_id: string | null; category: string; total: string | null; count: string }>(`SELECT e.category_id,COALESCE(c.name,e.category) AS category,SUM(e.amount_eur)::text AS total,COUNT(*)::text AS count FROM personal_finance.expenses e LEFT JOIN personal_finance.categories c ON c.account_id=e.account_id AND c.id=e.category_id WHERE ${clause.replaceAll('account_id', 'e.account_id').replaceAll('deleted_at', 'e.deleted_at').replaceAll('expense_date', 'e.expense_date')} GROUP BY e.category_id,COALESCE(c.name,e.category) ORDER BY SUM(e.amount_eur) DESC NULLS LAST`, values),
      this.pool.query<{ merchant_id: string | null; merchant_name: string | null; total: string | null; count: string }>(`SELECT merchant_id,COALESCE(merchant_name,'Unknown merchant') AS merchant_name,SUM(amount_eur)::text AS total,COUNT(*)::text AS count FROM personal_finance.expenses WHERE ${clause} GROUP BY merchant_id,merchant_name ORDER BY SUM(amount_eur) DESC NULLS LAST`, values),
      this.pool.query<{ product: string; currency: string; unit: string; total: string; quantity: string; line_count: string }>(
        `SELECT COALESCE(NULLIF(btrim(i.product_code),''),i.description) AS product,i.currency,i.unit,SUM(i.line_total)::text AS total,SUM(i.quantity)::text AS quantity,COUNT(*)::text AS line_count
         FROM personal_finance.expense_items i JOIN personal_finance.expenses e ON e.account_id=i.account_id AND e.id=i.expense_id
         WHERE ${productWhere.join(' AND ')}
         GROUP BY COALESCE(NULLIF(btrim(i.product_code),''),i.description),i.currency,i.unit ORDER BY SUM(i.line_total) DESC`, values),
      this.pool.query<{ month: string; total: string | null; count: string }>(
        `SELECT to_char(expense_date,'YYYY-MM') AS month,SUM(amount_eur)::text AS total,COUNT(*)::text AS count
         FROM personal_finance.expenses WHERE ${clause} GROUP BY to_char(expense_date,'YYYY-MM') ORDER BY month`, values),
      this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM personal_finance.expenses WHERE ${clause}`, values),
    ]);
    return {
      currency: 'EUR', total: decimalString(total.rows[0]?.total ?? '0'), transactionCount: Number(count.rows[0]?.count ?? '0'),
      excludedUnconvertedCount: Number(total.rows[0]?.unconverted ?? '0'),
      byMonth: months.rows.map((row) => ({ month: row.month, total: decimalString(row.total ?? '0'), count: Number(row.count) })),
      byCategory: categories.rows.map((row) => ({ categoryId: row.category_id, category: row.category, total: decimalString(row.total ?? '0'), count: Number(row.count) })),
      byMerchant: merchants.rows.map((row) => ({ merchantId: row.merchant_id, merchant: row.merchant_name ?? 'Unknown merchant', total: decimalString(row.total ?? '0'), count: Number(row.count) })),
      byProduct: products.rows.map((row) => ({ product: row.product, currency: row.currency.trim(), unit: row.unit, total: decimalString(row.total), quantity: decimalString(row.quantity), lineCount: Number(row.line_count) })),
      fromDate: query.fromDate ?? null, toDate: query.toDate ?? null,
    };
  }

  private async insertExpense(client: PoolClient, accountId: string, actorId: string, id: string, input: ExpenseWrite, merchantId: string | null, amountEur: string | null, sourceId: string | null, legacyRecordId: string | null = null, ignoreDuplicate = false): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO personal_finance.expenses
       (id,account_id,expense_date,amount,currency,amount_eur,fx_rate,fx_rate_convention,fx_source,fx_effective_at,fx_provider,merchant_id,merchant_name,category,description,tags,liters,source_kind,source_id,legacy_record_id,source_created_at,source_updated_at,confirmed_by,confirmed_at,category_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,now(),$24)
       ${ignoreDuplicate ? 'ON CONFLICT DO NOTHING' : ''} RETURNING id`,
      [id, accountId, input.date, financeDecimal(input.amount), input.currency, amountEur === null ? null : financeDecimal(amountEur), input.fx?.rate ? financeDecimal(input.fx.rate) : null, input.fx?.convention ?? null, input.fx?.source ?? null, input.fx?.effectiveAt ?? null, input.fx?.provider ?? null, merchantId, input.merchantName, input.category, input.description, input.tags, input.liters === null ? null : financeDecimal(input.liters), input.source.kind, sourceId, legacyRecordId, input.sourceCreatedAt ?? null, input.sourceUpdatedAt ?? null, actorId, input.categoryId ?? null],
    );
    return Boolean(result.rows[0]);
  }

  private async insertItems(client: PoolClient, accountId: string, expenseId: string, items: readonly ExpenseItem[]) {
    for (const item of items) {
      await client.query(
        `INSERT INTO personal_finance.expense_items
          (id,account_id,expense_id,description,product_code,quantity,unit,unit_price,discount,tax,line_total,currency,source_receipt_id,normalized_description,packaging,tax_included,category_id,extraction_provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [item.id ?? randomUUID(), accountId, expenseId, item.description, item.productCode, financeDecimal(item.quantity), item.unit, financeDecimal(item.unitPrice), financeDecimal(item.discount), financeDecimal(item.tax), financeDecimal(item.lineTotal), item.currency, item.sourceReceiptId ?? null, item.normalizedDescription ?? null, item.packaging ?? null, item.taxIncluded ?? false, item.categoryId ?? null, item.extractionProvenance ?? {}],
      );
    }
  }

  private async insertDraftItems(client: PoolClient, accountId: string, draftId: string, items: readonly Omit<ExpenseItem, 'id'>[]) {
    for (const item of items) {
      await client.query(
        `INSERT INTO personal_finance.expense_draft_items
          (id,account_id,draft_id,description,product_code,quantity,unit,unit_price,discount,tax,line_total,currency,source_receipt_id,normalized_description,packaging,tax_included,category_id,extraction_provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [randomUUID(), accountId, draftId, item.description, item.productCode, financeDecimal(item.quantity), item.unit, financeDecimal(item.unitPrice), financeDecimal(item.discount), financeDecimal(item.tax), financeDecimal(item.lineTotal), item.currency, item.sourceReceiptId ?? null, item.normalizedDescription ?? null, item.packaging ?? null, item.taxIncluded ?? false, item.categoryId ?? null, item.extractionProvenance ?? {}],
      );
    }
  }

  private async insertReceipt(client: PoolClient, accountId: string, draftId: string, receipt: Omit<ReceiptMetadata, 'id' | 'accountId' | 'draftId' | 'expenseId' | 'createdAt'>): Promise<ReceiptMetadata> {
    const id = randomUUID();
    const result = await client.query<ReceiptRow>(
      `INSERT INTO personal_finance.receipts
       (id,account_id,draft_id,content_hash,media_type,byte_length,storage_key,status,extracted_totals,parser_provider,parser_model,extraction_schema_version,document_type,source_text,extraction_result,extraction_warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [id, accountId, draftId, receipt.contentHash.toLowerCase(), receipt.mediaType, receipt.byteLength, receipt.storageKey, receipt.status, receipt.extractedTotals, receipt.parserProvider, receipt.parserModel, receipt.extraction?.schemaVersion ?? null, receipt.extraction?.documentType.value ?? null, receipt.extraction?.sourceText ?? null, receipt.extraction ?? null, JSON.stringify(receipt.extraction?.warnings ?? [])],
    );
    return mapReceipt(result.rows[0]);
  }

  private async resolveMerchant(client: PoolClient, accountId: string, name: string | null): Promise<string | null> {
    if (!name?.trim()) return null;
    const normalized = normalizeMerchantName(name).toLowerCase();
    const id = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO personal_finance.merchants(id,account_id,name,normalized_name)
       VALUES ($1,$2,$3,$4) ON CONFLICT (account_id,normalized_name) DO NOTHING RETURNING id`,
      [id, accountId, normalizeMerchantName(name), normalized],
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = await client.query<{ id: string }>('SELECT id FROM personal_finance.merchants WHERE account_id=$1 AND normalized_name=$2', [accountId, normalized]);
    return existing.rows[0]?.id ?? null;
  }

  private async applyActiveCategory(client: PoolClient, accountId: string, input: ExpenseWrite, allowArchived = false): Promise<ExpenseWrite> {
    if (!input.categoryId) return { ...input, categoryId: null };
    const category = await client.query<{ name: string }>(
      `SELECT name FROM personal_finance.categories WHERE account_id=$1 AND id=$2 ${allowArchived ? '' : 'AND archived_at IS NULL'} FOR KEY SHARE`,
      [accountId, input.categoryId],
    );
    if (!category.rows[0]) throw new Error('Selected category is unavailable for this account');
    return { ...input, category: category.rows[0].name };
  }

  private async insertEvent(client: PoolClient, accountId: string, source: ExpenseSource, eventType: string, details: Record<string, unknown>) {
    const expenseId = typeof details.expenseId === 'string' ? details.expenseId : null;
    const draftId = typeof details.draftId === 'string' ? details.draftId : null;
    const receiptId = typeof details.receiptId === 'string' ? details.receiptId : null;
    const actorId = typeof details.actorId === 'string' ? details.actorId : null;
    await client.query(
      `INSERT INTO personal_finance.provenance_events
       (id,account_id,expense_id,draft_id,receipt_id,event_type,actor_user_id,source_kind,source_id,provider,model,content_hash,details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [randomUUID(), accountId, expenseId, draftId, receiptId, eventType, actorId, source.kind, source.id, source.provider ?? null, source.model ?? null, source.contentHash ?? null, details],
    );
  }

  private async attachExpenseItems(accountId: string, rows: ExpenseRow[]): Promise<ExpenseRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const result = await this.pool.query<ItemRow>('SELECT * FROM personal_finance.expense_items WHERE account_id=$1 AND expense_id=ANY($2::uuid[]) ORDER BY id', [accountId, ids]);
    const grouped = new Map<string, ExpenseItem[]>();
    for (const row of result.rows) {
      if (!row.expense_id) continue;
      const list = grouped.get(row.expense_id) ?? [];
      list.push(mapItem(row));
      grouped.set(row.expense_id, list);
    }
    return rows.map((row) => mapExpense(row, grouped.get(row.id) ?? []));
  }

  private async getExpenseWithClient(client: Pick<Pool, 'query'> | PoolClient, accountId: string, id: string, lock = false): Promise<ExpenseRecord | null> {
    const result = await client.query<ExpenseRow>(`SELECT e.*,COALESCE(c.name,e.category) AS category FROM personal_finance.expenses e LEFT JOIN personal_finance.categories c ON c.account_id=e.account_id AND c.id=e.category_id WHERE e.account_id=$1 AND e.id=$2 AND e.deleted_at IS NULL${lock ? ' FOR UPDATE OF e' : ''}`, [accountId, id]);
    if (!result.rows[0]) return null;
    const items = await client.query<ItemRow>('SELECT * FROM personal_finance.expense_items WHERE account_id=$1 AND expense_id=$2 ORDER BY id', [accountId, id]);
    return mapExpense(result.rows[0], items.rows.map(mapItem));
  }

  private async getDraftRow(client: Pick<Pool, 'query'> | PoolClient, accountId: string, id: string) {
    const result = await client.query<DraftRow>('SELECT * FROM personal_finance.expense_drafts WHERE account_id=$1 AND id=$2', [accountId, id]);
    return result.rows[0] ?? null;
  }

  private async loadDraftWithClient(client: Pick<Pool, 'query'> | PoolClient, accountId: string, row: DraftRow): Promise<ExpenseDraft> {
    const [items, receipts] = await Promise.all([
      client.query<ItemRow>('SELECT * FROM personal_finance.expense_draft_items WHERE account_id=$1 AND draft_id=$2 ORDER BY id', [accountId, row.id]),
      client.query<ReceiptRow>('SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND draft_id=$2 ORDER BY created_at', [accountId, row.id]),
    ]);
    return {
      id: row.id, accountId: row.account_id, status: row.status, date: row.expense_date ? isoDate(row.expense_date) : null,
      amount: row.amount === null ? null : decimalString(row.amount), currency: row.currency?.trim() || null,
      merchantName: row.merchant_name, category: row.category, description: row.description, tags: row.tags ?? [],
      items: items.rows.map(({ id: _id, ...item }) => mapItem(item as ItemRow)),
      receipts: receipts.rows.map(mapReceipt),
      sourceKind: row.source_kind, sourceId: row.source_id, extractionProvider: row.extraction_provider, extractionModel: row.extraction_model,
      createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at),
    };
  }

  private async listDraftItems(client: PoolClient, accountId: string, draftId: string): Promise<ExpenseItem[]> {
    const result = await client.query<ItemRow>('SELECT * FROM personal_finance.expense_draft_items WHERE account_id=$1 AND draft_id=$2 ORDER BY id', [accountId, draftId]);
    return result.rows.map(mapItem);
  }

  private async listReceipts(client: PoolClient, accountId: string, draftId: string): Promise<ReceiptMetadata[]> {
    const result = await client.query<ReceiptRow>('SELECT * FROM personal_finance.receipts WHERE account_id=$1 AND draft_id=$2 ORDER BY created_at', [accountId, draftId]);
    return result.rows.map(mapReceipt);
  }

  private assertReceiptsReconcile(items: ExpenseItem[], receipts: ReceiptMetadata[], expenseAmount: string, expenseCurrency: string) {
    for (const receipt of receipts) {
      if (!receipt.userReviewedAt) throw new Error('Review the receipt details and confirm its itemization before saving');
      const total = receipt.reviewedTotal ?? receipt.extractedTotals?.total;
      const currency = receipt.reviewedCurrency ?? receipt.extractedTotals?.currency;
      if (receipt.status === 'failed') throw new Error('A failed receipt cannot be confirmed');
      const attachedItems = items.filter((item) => item.sourceReceiptId === receipt.id);
      if (!total || !currency) {
        if (receipt.reviewedAsTotalOnly) continue;
        if (!attachedItems.length) throw new Error('Add receipt items or explicitly choose to save the receipt as total-only');
        if (attachedItems.some((item) => item.currency.toUpperCase() !== expenseCurrency.toUpperCase())) throw new Error('Receipt item currency does not match the expense currency');
        const calculated = receipt.extraction ? itemTotalWithIncludedAdjustments(attachedItems, receipt.reviewedAdjustments ?? receipt.extraction.adjustments) : attachedItems.reduce((sum, item) => addDecimal(sum, item.lineTotal), '0');
        const scale = currencyMinorUnits(expenseCurrency);
        if (compareDecimal(roundDecimal(calculated, scale), roundDecimal(expenseAmount, scale)) !== 0) throw new Error('Receipt items do not reconcile to the entered expense total');
        continue;
      }
      if (!receipt.reviewedAsTotalOnly) {
        if (!attachedItems.length) throw new Error('Add the receipt items or explicitly choose to save the receipt as total-only');
        const calculated = receipt.extraction ? itemTotalWithIncludedAdjustments(attachedItems, receipt.reviewedAdjustments ?? receipt.extraction.adjustments) : attachedItems.reduce((sum, item) => addDecimal(sum, item.lineTotal), '0');
        const calculatedRounded = roundDecimal(calculated, currencyMinorUnits(currency));
        const receiptRounded = roundDecimal(total, currencyMinorUnits(currency));
        if (compareDecimal(calculatedRounded, receiptRounded) !== 0) throw new Error(`Receipt items total ${calculatedRounded} ${currency} does not match receipt total ${receiptRounded} ${currency}`);
      }
      const receiptAmount = reconcileItemsAgainstTotal([], total, currency).receiptTotal;
      if (currency.toUpperCase() !== expenseCurrency.toUpperCase())
        throw new Error(`Receipt currency ${currency} does not match expense currency ${expenseCurrency}`);
      if (compareDecimal(receiptAmount, expenseAmount) !== 0)
        throw new Error(`Expense amount ${expenseAmount} ${expenseCurrency} does not match receipt total ${receiptAmount} ${currency}`);
    }
    for (const item of items) {
      if (item.sourceReceiptId && !receipts.some((receipt) => receipt.id === item.sourceReceiptId)) throw new Error('An expense item references a receipt outside its draft');
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve original transaction failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  private missingDraft(): never { throw new Error('Expense draft could not be loaded after write'); }
}

function mapExpense(row: ExpenseRow, items: ExpenseItem[]): ExpenseRecord {
  return {
    id: row.id, accountId: row.account_id, revision: row.revision, date: isoDate(row.expense_date), amount: decimalString(row.amount), currency: row.currency.trim(),
    amountEur: row.amount_eur === null ? null : decimalString(row.amount_eur),
    fx: row.fx_rate ? { rate: decimalString(row.fx_rate), convention: 'currency_units_per_eur', source: row.fx_source ?? 'unknown', effectiveAt: row.fx_effective_at ? isoTimestamp(row.fx_effective_at) : null, provider: row.fx_provider } : null,
    merchantId: row.merchant_id, merchantName: row.merchant_name, category: row.category, categoryId: row.category_id ?? null, description: row.description, tags: row.tags ?? [], items,
    liters: row.liters === null ? null : decimalString(row.liters), sourceKind: row.source_kind, sourceId: row.source_id,
    ...(row.legacy_record_id ? { legacyRecordId: row.legacy_record_id } : {}),
    sourceCreatedAt: row.source_created_at ? isoTimestamp(row.source_created_at) : null,
    sourceUpdatedAt: row.source_updated_at ? isoTimestamp(row.source_updated_at) : null,
    createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at),
    confirmedBy: row.confirmed_by, confirmedAt: isoTimestamp(row.confirmed_at),
  };
}

function mapCategory(row: CategoryRow): FinanceCategory {
  return { id: row.id, accountId: row.account_id, name: row.name, description: row.description, parentId: row.parent_id,
    status: row.archived_at ? 'archived' : 'active', createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at),
    archivedAt: row.archived_at ? isoTimestamp(row.archived_at) : null };
}

function mapItem(row: ItemRow): ExpenseItem {
  return { id: row.id, description: row.description, productCode: row.product_code, quantity: decimalString(row.quantity), unit: row.unit, unitPrice: decimalString(row.unit_price), discount: decimalString(row.discount), tax: decimalString(row.tax), lineTotal: decimalString(row.line_total), currency: row.currency.trim(), sourceReceiptId: row.source_receipt_id, normalizedDescription: row.normalized_description, packaging: row.packaging, taxIncluded: row.tax_included, categoryId: row.category_id, extractionProvenance: row.extraction_provenance ?? {} };
}

function mapReceipt(row: ReceiptRow): ReceiptMetadata {
  return { id: row.id, accountId: row.account_id, draftId: row.draft_id, expenseId: row.expense_id, contentHash: row.content_hash.trim(), mediaType: row.media_type, byteLength: Number(row.byte_length), storageKey: row.storage_key, status: row.status, extractedTotals: row.extracted_totals, parserProvider: row.parser_provider, parserModel: row.parser_model, extraction: row.extraction_result ?? null, userReviewedAt: row.user_reviewed_at ? isoTimestamp(row.user_reviewed_at) : null, reviewedAsTotalOnly: row.reviewed_as_total_only ?? false, reviewedTotal: row.reviewed_total === null || row.reviewed_total === undefined ? null : decimalString(row.reviewed_total), reviewedCurrency: row.reviewed_currency?.trim() ?? null, documentDeletedAt: row.document_deleted_at ? isoTimestamp(row.document_deleted_at) : null, reviewedAdjustments: row.reviewed_adjustments ?? null, createdAt: isoTimestamp(row.created_at) };
}

export function itemTotalWithIncludedAdjustments(items: ExpenseItem[], adjustments: NonNullable<ReceiptMetadata['reviewedAdjustments']>) {
  return adjustments.reduce((sum, adjustment) => {
    if (adjustment.includedInTotal === null) throw new Error(`Receipt adjustment “${adjustment.label}” needs review`);
    if (adjustment.includedInTotal !== true) return sum;
    if (adjustment.includedInLineTotal === null) throw new Error(`Receipt adjustment “${adjustment.label}” needs review to determine whether it is already included in a purchase line`);
    if (adjustment.includedInLineTotal === true) return sum;
    if (adjustment.signedAmount !== undefined && adjustment.signedAmount !== null) return addDecimal(sum, financeDecimal(adjustment.signedAmount));
    if (adjustment.amount === null) throw new Error(`Receipt adjustment “${adjustment.label}” needs an amount`);
    const amount = financeDecimal(adjustment.amount);
    const signed = adjustment.kind === 'discount' || adjustment.kind === 'return'
      ? `-${amount}`
      : adjustment.kind === 'other' ? null : amount;
    if (signed === null) throw new Error('A receipt has an unresolved adjustment that requires review');
    return addDecimal(sum, signed);
  }, items.reduce((sum, item) => addDecimal(sum, item.lineTotal), '0'));
}

export function isoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // node-postgres parses SQL DATE values as local midnight. Converting that
  // instant to UTC shifts the calendar date back in east-of-UTC time zones.
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function isoTimestamp(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}
