import { assertNewExpenseCurrency, normalizeCurrency, normalizeMerchantName, validateDraftProposal, validateExpenseItem } from '../domain/expense-rules';
import { compareDecimal, decimalString, financeDecimal } from '../domain/decimal';
import type { ExpenseDraftProposal, ExpenseQuery, ExpenseSource, ExpenseSourceKind, FinanceActorContext } from '../domain/personal-finance.types';
import type { ExpenseTextExtractionPort } from './ports/expense-extraction.port';
import type { CategoryWrite, ExpenseImportRow, ExpenseWrite, PersonalFinanceRepository } from './ports/personal-finance.repository';
import { previewFinancialDocument as createFinancialDocumentPreview } from '../domain/financial-document-preview';
import type { FinancialDocumentPreviewInput } from '../domain/financial-document-preview';

export interface ProposeExpenseDraftCommand {
  accountId: string;
  text: string;
  cloudDataConsent: boolean;
  sourceId?: string | null;
}

export interface ConfirmExpenseDraftCommand {
  accountId: string;
  actorId: string;
  draftId: string;
}

export interface QueryExpensesCommand {
  accountId: string;
  query: ExpenseQuery;
}

export class PersonalFinanceApplication {
  constructor(
    private readonly repository: PersonalFinanceRepository,
    private readonly textExtraction: ExpenseTextExtractionPort,
  ) {}

  listCategories(context: FinanceActorContext, includeArchived = false) {
    requireFinanceContext(context);
    return this.repository.listCategories(context.accountId, includeArchived);
  }

  createCategory(context: FinanceActorContext, input: CategoryWrite) {
    requireFinanceContext(context);
    return this.repository.createCategory(context.accountId, context.actorId, normalizeCategory(input));
  }

  renameCategory(context: FinanceActorContext, categoryId: string, input: CategoryWrite) {
    requireFinanceContext(context);
    return this.repository.renameCategory(context.accountId, context.actorId, categoryId, normalizeCategory(input));
  }

  archiveCategory(context: FinanceActorContext, categoryId: string) {
    requireFinanceContext(context);
    return this.repository.archiveCategory(context.accountId, context.actorId, categoryId);
  }

  /** Validates an evidence-linked financial document without touching persistence. */
  previewFinancialDocument(context: FinanceActorContext, input: FinancialDocumentPreviewInput) {
    requireFinanceContext(context);
    return createFinancialDocumentPreview(input);
  }

  async proposeExpenseDraft(command: ProposeExpenseDraftCommand) {
    const text = command.text.trim();
    if (!text || text.length > 1200) throw new Error('Describe one expense in 1–1200 characters');
    const extracted = await this.textExtraction.extract(text, { cloudDataConsent: command.cloudDataConsent });
    const proposal = validateDraftProposal({
      ...extracted,
      sourceKind: 'assistant-text',
      sourceId: command.sourceId ?? null,
    });
    return this.repository.createDraft(command.accountId, command.accountId, proposal);
  }

  async proposeExpenseDraftFromInput(accountId: string, proposal: ExpenseDraftProposal) {
    return this.repository.createDraft(accountId, accountId, validateDraftProposal(proposal));
  }

  getExpenseDraft(accountId: string, draftId: string) {
    return this.repository.getDraft(accountId, draftId);
  }

  findImportedLegacyIds(accountId: string, ids: readonly string[]) {
    return this.repository.findImportedLegacyIds(accountId, ids);
  }

  getExpense(accountId: string, expenseId: string) {
    return this.repository.getExpense(accountId, expenseId);
  }

  confirmExpense(command: ConfirmExpenseDraftCommand) {
    this.assertOwner(command.accountId, command.actorId);
    return this.repository.confirmDraft(command.accountId, command.draftId, command.actorId);
  }

  async rejectExpenseDraft(command: ConfirmExpenseDraftCommand) {
    this.assertOwner(command.accountId, command.actorId);
    const draft = await this.repository.rejectDraft(command.accountId, command.draftId, command.actorId);
    return draft;
  }

  async createExpense(accountId: string, actorId: string, input: ExpenseWrite) {
    this.assertOwner(accountId, actorId);
    const normalized = normalizeExpenseWrite(input);
    assertNewExpenseCurrency(normalized.currency);
    return this.repository.createExpense(accountId, actorId, normalized);
  }

  async updateExpense(accountId: string, actorId: string, expenseId: string, input: ExpenseWrite) {
    this.assertOwner(accountId, actorId);
    return this.repository.updateExpense(accountId, actorId, expenseId, normalizeExpenseWrite(input));
  }

  async deleteExpense(accountId: string, actorId: string, expenseId: string) {
    this.assertOwner(accountId, actorId);
    return this.repository.deleteExpense(accountId, actorId, expenseId);
  }

  async importExpenses(accountId: string, actorId: string, rows: readonly ExpenseImportRow[]) {
    this.assertOwner(accountId, actorId);
    if (!rows.length || rows.length > 10000) throw new Error('Import must contain 1–10000 expenses');
    const normalized = rows.map((row) => {
      if (!row.source.id && !row.legacyRecordId) throw new Error('Each imported expense needs a stable source ID');
      return { ...normalizeExpenseWrite(row), legacyRecordId: row.legacyRecordId };
    });
    return this.repository.importExpenses(accountId, actorId, normalized);
  }

  queryExpenses(command: QueryExpensesCommand) {
    this.validateQuery(command.query);
    return this.repository.queryExpenses(command.accountId, command.query);
  }

  summarizeSpending(command: QueryExpensesCommand) {
    this.validateQuery(command.query);
    return this.repository.summarize(command.accountId, command.query);
  }

  addReceiptMetadata(accountId: string, draftId: string, receipt: Parameters<PersonalFinanceRepository['addReceiptMetadata']>[2]) {
    return this.repository.addReceiptMetadata(accountId, draftId, receipt);
  }

  private assertOwner(accountId: string, actorId: string) {
    if (!accountId || !actorId || accountId !== actorId) throw new Error('Finance mutations must be confirmed by the owning account');
  }

  private validateQuery(query: ExpenseQuery) {
    if (query.fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(query.fromDate)) throw new Error('fromDate must be YYYY-MM-DD');
    if (query.toDate && !/^\d{4}-\d{2}-\d{2}$/.test(query.toDate)) throw new Error('toDate must be YYYY-MM-DD');
    if (query.fromDate && query.toDate && query.fromDate > query.toDate) throw new Error('fromDate must not be after toDate');
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000)) throw new Error('limit must be from 1 to 1000');
  }
}

function requireFinanceContext(context: FinanceActorContext) {
  if (!context || typeof context.accountId !== 'string' || !context.accountId.trim() || typeof context.actorId !== 'string' || !context.actorId.trim())
    throw new Error('A verified finance account context is required');
}

function normalizeCategory(input: CategoryWrite): CategoryWrite {
  if (!input || typeof input.name !== 'string') throw new Error('Category name is required');
  const name = input.name.trim().normalize('NFKC');
  if (!name || name.length > 80) throw new Error('Category name must contain 1–80 characters');
  const description = input.description === null ? null : input.description?.trim().normalize('NFKC') || null;
  if (description && description.length > 500) throw new Error('Category description must be at most 500 characters');
  if (input.parentId !== null && typeof input.parentId !== 'string') throw new Error('Category parentId must be an ID or null');
  return { name, description, parentId: input.parentId?.trim() || null };
}

export function normalizeExpenseWrite(input: ExpenseWrite): ExpenseWrite {
  const amount = financeDecimal(input.amount);
  if (compareDecimal(amount, '0') <= 0) throw new Error('Amount must be greater than zero');
  const currency = normalizeCurrency(input.currency);
  const date = input.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new Error('Date must be a valid ISO calendar date');
  if (!input.category.trim()) throw new Error('Category is required');
  if (!input.description.trim()) throw new Error('Description is required');
  const fx = input.fx ? { ...input.fx, rate: decimalString(input.fx.rate), convention: 'currency_units_per_eur' as const } : null;
  if (input.amountEur !== null && compareDecimal(input.amountEur, '0') < 0) throw new Error('EUR amount cannot be negative');
  const merchantName = input.merchantName ? normalizeMerchantName(input.merchantName) : null;
  return {
    ...input,
    date,
    amount,
    currency,
    amountEur: input.amountEur === null ? null : financeDecimal(input.amountEur),
    fx,
    merchantName,
    category: input.category.trim().slice(0, 80),
    description: input.description.trim().slice(0, 500),
    tags: input.tags.map((tag) => tag.trim().slice(0, 60)).filter(Boolean).slice(0, 30),
    items: input.items.map((item) => validateExpenseItem(item)),
    liters: input.liters === null ? null : decimalString(input.liters),
    source: normalizeSource(input.source),
  };
}

function normalizeSource(source: ExpenseSource): ExpenseSource {
  const allowed: ExpenseSourceKind[] = ['manual', 'assistant-text', 'receipt', 'legacy-mongo', 'legacy-leveldb', 'bank'];
  if (!allowed.includes(source.kind)) throw new Error('Unsupported expense source');
  return {
    kind: source.kind,
    id: source.id?.trim().slice(0, 240) || null,
    provider: source.provider?.trim().slice(0, 100) || null,
    model: source.model?.trim().slice(0, 160) || null,
    contentHash: source.contentHash?.trim().slice(0, 128) || null,
  };
}
