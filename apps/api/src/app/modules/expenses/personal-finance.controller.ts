import { BadRequestException, Body, Controller, Delete, Get, Header, HttpException, NotFoundException, Param, Patch, Post, Query, Req, ServiceUnavailableException, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AccessJwtGuard, requirePrincipal } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PersonalFinanceApplication } from './application/personal-finance.application';
import { ReceiptIntelligenceApplication } from './application/receipt-intelligence.application';
import { PersonalExpenseStore } from './personal-expense.store';
import { addDecimal, compareDecimal, decimalString, divideDecimalByInteger, financeDecimal } from './domain/decimal';
import { euroValue, normalizeCurrency } from './domain/expense-rules';
import type { ExpenseItem, ExpenseQuery, ExpenseRecord, ExpenseSourceKind } from './domain/personal-finance.types';
import type { ExpenseDraftReviewWrite, ExpenseImportRow, ExpenseWrite } from './application/ports/personal-finance.repository';

@Controller('personal-finance')
@UseGuards(AccessJwtGuard)
export class PersonalFinanceController {
  constructor(private readonly finance: PersonalFinanceApplication, private readonly legacy: PersonalExpenseStore, private readonly receipts: ReceiptIntelligenceApplication) {}

  @Post('receipts/extract')
  @UseInterceptors(FileInterceptor('receipt', { limits: { files: 1, fileSize: 10 * 1024 * 1024 } }))
  async extractReceipt(@UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined, @Body('cloudDataConsent') consent: unknown, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    if (consent !== 'true') throw new BadRequestException('Explicitly consent to cloud receipt processing before uploading.');
    if (!file?.buffer?.length) throw new BadRequestException('Choose a JPEG or PNG receipt image.');
    try {
      const result = await this.receipts.extract({ accountId, actorId: accountId }, file.buffer, file.mimetype, true);
      return { ...result, draft: result.draft ? publicDraft(result.draft) : null, receipt: result.receipt ? publicReceipt(result.receipt) : undefined };
    }
    catch (error) { if (error instanceof HttpException) throw error; throw new BadRequestException(message(error)); }
  }

  @Post('receipts/:id/re-extract')
  async reextractReceipt(@Param('id') id: string, @Body('cloudDataConsent') consent: unknown, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    if (consent !== true) throw new BadRequestException('Explicitly consent to sending this saved receipt to the cloud provider again.');
    try {
      const result = await this.receipts.reextract({ accountId, actorId: accountId }, id, true);
      return { ...result, draft: publicDraft(result.draft), receipt: publicReceipt(result.receipt) };
    } catch (error) { if (error instanceof HttpException) throw error; throw new BadRequestException(message(error)); }
  }

  @Patch('drafts/:id')
  async reviewReceiptDraft(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    try {
      const result = await this.receipts.reviewDraft({ accountId, actorId: accountId }, id, normalizeDraftReview(body));
      if (!result) throw new NotFoundException('Reviewable expense draft not found');
      return { draft: publicDraft(result) };
    } catch (error) { if (error instanceof HttpException) throw error; throw new BadRequestException(message(error)); }
  }

  @Get('receipts/:id/content')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async receiptContent(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    const result = await this.receipts.getImage({ accountId, actorId: accountId }, id);
    if (!result) throw new NotFoundException('Receipt not found');
    return new StreamableFile(Buffer.from(result.bytes), { type: result.receipt.mediaType, length: result.receipt.byteLength });
  }

  @Delete('receipts/:id/content')
  async deleteReceiptContent(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    const receipt = await this.receipts.deleteImage({ accountId, actorId: accountId }, id);
    if (!receipt) throw new NotFoundException('Receipt not found');
    return { deleted: true };
  }

  @Post('receipts/:id/attach')
  async attachReceipt(@Param('id') id: string, @Body() body: { expenseId?: unknown }, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    if (typeof body?.expenseId !== 'string' || !body.expenseId.trim()) throw new BadRequestException('expenseId is required');
    const receipt = await this.receipts.attachToExpense({ accountId, actorId: accountId }, id, body.expenseId.trim());
    if (!receipt) throw new NotFoundException('Receipt or expense not found');
    return { receipt: publicReceipt(receipt) };
  }

  @Get('categories')
  async listCategories(@Query('includeArchived') includeArchived: string, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    return { categories: await this.finance.listCategories({ accountId, actorId: accountId }, includeArchived === 'true') };
  }

  @Post('categories')
  async createCategory(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    try { return { category: await this.finance.createCategory({ accountId, actorId: accountId }, normalizeCategoryBody(body)) }; }
    catch (error) { throw new BadRequestException(message(error)); }
  }

  @Patch('categories/:id')
  async renameCategory(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    try {
      const category = await this.finance.renameCategory({ accountId, actorId: accountId }, id, normalizeCategoryBody(body));
      if (!category) throw new NotFoundException('Category not found or archived');
      return { category };
    } catch (error) { if (error instanceof NotFoundException) throw error; throw new BadRequestException(message(error)); }
  }

  @Post('categories/:id/archive')
  async archiveCategory(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    const category = await this.finance.archiveCategory({ accountId, actorId: accountId }, id);
    if (!category) throw new NotFoundException('Category not found or already archived');
    return { category };
  }

  private async readLegacy(accountId: string) {
    try {
      return { records: await this.legacy.list(accountId), available: true };
    } catch {
      // PostgreSQL remains useful during a LevelDB outage, but callers must
      // expose that the combined historical view is incomplete.
      return { records: [], available: false };
    }
  }

  private async requireLegacy(accountId: string) {
    const legacy = await this.readLegacy(accountId);
    if (!legacy.available) {
      throw new ServiceUnavailableException(
        'Legacy expenses are unavailable; duplicate checks cannot be completed safely.',
      );
    }
    return legacy.records;
  }

  @Post('drafts/propose')
  async propose(@Body() body: { text?: unknown; sourceId?: unknown }, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    if (typeof body?.text !== 'string') throw new BadRequestException('text is required');
    try {
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim().slice(0, 240) || null : null;
      return { draft: await this.finance.proposeExpenseDraft({ accountId, text: body.text, cloudDataConsent: false, sourceId }) };
    }
    catch (error) { throw new BadRequestException(message(error)); }
  }

  @Get('drafts/:id')
  async getDraft(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const draft = await this.finance.getExpenseDraft(requirePrincipal(request).userId, id);
    if (!draft) throw new NotFoundException('Expense draft not found');
    return { draft: publicDraft(draft) };
  }

  @Post('drafts/:id/confirm')
  async confirm(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const actorId = requirePrincipal(request).userId;
    try {
      const expense = await this.finance.confirmExpense({ accountId: actorId, actorId, draftId: id });
      if (!expense) throw new NotFoundException('Expense draft not found');
      return { expense };
    } catch (error) { if (error instanceof NotFoundException) throw error; throw new BadRequestException(message(error)); }
  }

  @Post('drafts/:id/reject')
  async reject(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const actorId = requirePrincipal(request).userId;
    const draft = await this.finance.rejectExpenseDraft({ accountId: actorId, actorId, draftId: id });
    if (!draft) throw new NotFoundException('Reviewable expense draft not found');
    return { draft };
  }

  @Get('expenses')
  async query(@Query() query: Record<string, string | undefined>, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    const parsed: ExpenseQuery = {
      fromDate: query.fromDate, toDate: query.toDate, category: query.category, categoryId: query.categoryId,
      merchantId: query.merchantId, text: query.text,
      limit: query.limit === undefined ? undefined : Number(query.limit), before: query.before,
    };
    try {
      const [current, legacyRead] = await Promise.all([this.finance.queryExpenses({ accountId, query: { ...parsed, limit: 1000 } }), this.readLegacy(accountId)]);
      const old = legacyRead.records;
      const seenIds = new Set(await this.finance.findImportedLegacyIds(accountId, old.map((record) => record.legacyRecordId).filter((id): id is string => Boolean(id))));
      const legacy = old.filter((record) => (!record.legacyRecordId || !seenIds.has(record.legacyRecordId))
        && (!parsed.fromDate || record.date >= parsed.fromDate) && (!parsed.toDate || record.date <= parsed.toDate)
        && (!parsed.before || record.date < parsed.before)
        && (!parsed.category || record.category === parsed.category)
        && (!parsed.text || `${record.description} ${record.category} ${record.tags.join(' ')}`.toLowerCase().includes(parsed.text.toLowerCase())))
        .map((record) => legacyRecord(accountId, record));
      return {
        expenses: [...current, ...legacy].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, parsed.limit ?? 200),
        legacyCoverage: legacyRead.available ? 'leveldb-available' : 'leveldb-unavailable',
      };
    } catch (error) { throw new BadRequestException(message(error)); }
  }

  @Post('expenses')
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const actorId = requirePrincipal(request).userId;
    try { return { expense: await this.finance.createExpense(actorId, actorId, normalizeExpenseBody(body)) }; }
    catch (error) { throw new BadRequestException(message(error)); }
  }

  @Patch('expenses/:id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const actorId = requirePrincipal(request).userId;
    try {
      const old = await this.finance.getExpense(actorId, id);
      if (!old) throw new NotFoundException('Expense not found');
      const updated = await this.finance.updateExpense(actorId, actorId, id, normalizeExpenseBody(body, old));
      if (!updated) throw new NotFoundException('Expense not found');
      return { expense: updated };
    } catch (error) { if (error instanceof NotFoundException) throw error; throw new BadRequestException(message(error)); }
  }

  @Delete('expenses/:id')
  async delete(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const actorId = requirePrincipal(request).userId;
    try {
      const deleted = await this.finance.deleteExpense(actorId, actorId, id);
      if (!deleted) throw new NotFoundException('Expense not found');
      return { deleted: true };
    } catch (error) { if (error instanceof NotFoundException) throw error; throw new BadRequestException(message(error)); }
  }

  @Post('expenses/import/preview')
  async previewImport(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    try {
      const raw = Array.isArray(body) ? body : body && typeof body === 'object'
        ? (body as Record<string, unknown>).records ?? (body as Record<string, unknown>).expenses : null;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10000) throw new Error('Import requires 1–10000 records');
      const records: ExpenseImportRow[] = [];
      const errors: string[] = [];
      raw.forEach((record, index) => { try { records.push(normalizeV2Import(record, index)); } catch (error) { errors.push(message(error)); } });
      const ids = records.flatMap((row) => [row.legacyRecordId, row.source.id].filter((id): id is string => Boolean(id)));
      const [stored, legacy] = await Promise.all([this.finance.findImportedLegacyIds(accountId, ids), this.requireLegacy(accountId)]);
      const seen = new Set([...stored, ...legacy.map((item) => item.legacyRecordId).filter((id): id is string => Boolean(id))]);
      const ready: ExpenseImportRow[] = [];
      let duplicateCount = 0;
      for (const row of records) {
        const rowIds = [row.legacyRecordId, row.source.id].filter((id): id is string => Boolean(id));
        if (rowIds.some((id) => seen.has(id))) { duplicateCount++; continue; }
        ready.push(row);
        rowIds.forEach((id) => seen.add(id));
      }
      return { records: ready, total: raw.length, valid: ready.length, duplicates: duplicateCount, errors };
    } catch (error) { if (error instanceof ServiceUnavailableException) throw error; throw new BadRequestException(message(error)); }
  }

  @Post('expenses/import')
  async import(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const actorId = requirePrincipal(request).userId;
    try {
      const raw = Array.isArray(body) ? body : body && typeof body === 'object'
        ? (body as Record<string, unknown>).records ?? (body as Record<string, unknown>).expenses
        : null;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10000) throw new Error('Import requires 1–10000 records');
      const rows = raw.map((record, index) => normalizeV2Import(record, index));
      const ids = rows.flatMap((row) => [row.legacyRecordId, row.source.id].filter((id): id is string => Boolean(id)));
      const [stored, legacy] = await Promise.all([this.finance.findImportedLegacyIds(actorId, ids), this.requireLegacy(actorId)]);
      const seen = new Set([...stored, ...legacy.map((item) => item.legacyRecordId).filter((id): id is string => Boolean(id))]);
      const ready: ExpenseImportRow[] = [];
      let alreadyPresent = 0;
      for (const row of rows) {
        const rowIds = [row.legacyRecordId, row.source.id].filter((id): id is string => Boolean(id));
        if (rowIds.some((id) => seen.has(id))) { alreadyPresent++; continue; }
        ready.push(row);
        rowIds.forEach((id) => seen.add(id));
      }
      if (!ready.length) return { imported: 0, duplicates: alreadyPresent };
      const result = await this.finance.importExpenses(actorId, actorId, ready);
      return { imported: result.imported, duplicates: result.duplicates + alreadyPresent };
    } catch (error) { if (error instanceof ServiceUnavailableException) throw error; throw new BadRequestException(message(error)); }
  }

  @Get('summary')
  async summary(@Query() query: Record<string, string | undefined>, @Req() request: AuthenticatedRequest) {
    try {
      const accountId = requirePrincipal(request).userId;
      const [summary, legacyRead] = await Promise.all([
        this.finance.summarizeSpending({ accountId, query: { fromDate: query.fromDate, toDate: query.toDate } }),
        this.readLegacy(accountId),
      ]);
      const old = legacyRead.records;
      const migrated = new Set(await this.finance.findImportedLegacyIds(accountId, old.map((record) => record.legacyRecordId).filter((id): id is string => Boolean(id))));
      const legacy = old.filter((item) => (!item.legacyRecordId || !migrated.has(item.legacyRecordId))
        && (!query.fromDate || item.date >= query.fromDate) && (!query.toDate || item.date <= query.toDate));
      const totals = new Map(summary.byCategory.map((item) => [categorySummaryKey(item.categoryId, item.category), item]));
      const monthlyTotals = new Map((summary.byMonth ?? []).map((item) => [item.month, item]));
      let total = summary.total;
      let excludedUnconvertedCount = summary.excludedUnconvertedCount;
      for (const item of legacy) {
        const value = item.amountEur === null ? null : decimalString(item.amountEur);
        if (value === null) excludedUnconvertedCount++;
        else total = addDecimal(total, value);
        const monthKey = item.date.slice(0, 7);
        const monthly = monthlyTotals.get(monthKey) ?? { month: monthKey, total: '0', count: 0 };
        if (value !== null) monthly.total = addDecimal(monthly.total, value);
        monthly.count++;
        monthlyTotals.set(monthKey, monthly);
        const key = categorySummaryKey(null, item.category);
        const category = totals.get(key) ?? { categoryId: null, category: item.category, total: '0', count: 0 };
        if (value !== null) category.total = addDecimal(category.total, value);
        category.count++;
        totals.set(key, category);
      }
      const paceDays = monthlyPaceDays(query.fromDate, query.toDate);
      return { ...summary, total, dailyAverage: paceDays ? divideDecimalByInteger(total, paceDays, 2) : null,
        transactionCount: summary.transactionCount + legacy.length, excludedUnconvertedCount,
        legacyCoverage: legacyRead.available ? 'leveldb-available' : 'leveldb-unavailable',
        byMonth: [...monthlyTotals.values()].sort((a, b) => a.month.localeCompare(b.month)),
        byCategory: [...totals.values()].sort((a, b) => compareDecimal(b.total, a.total) || a.category.localeCompare(b.category)) };
    }
    catch (error) { throw new BadRequestException(message(error)); }
  }
}

function normalizeExpenseBody(raw: unknown, existing?: ExpenseRecord): ExpenseWrite {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expense body must be an object');
  const body = raw as Record<string, unknown>;
  const date = typeof body.date === 'string' ? body.date : existing?.date;
  const amount = decimalInput(body.amount, 'amount');
  const currency = normalizeCurrency(typeof body.currency === 'string' ? body.currency : existing?.currency ?? 'EUR');
  const fxRate = body.fxRate == null ? existing?.fx?.rate ?? null : financeDecimal(decimalInput(body.fxRate, 'fxRate'));
  const fx = currency === 'EUR' ? null : fxRate ? { rate: fxRate, convention: 'currency_units_per_eur' as const, source: existing?.fx?.source ?? 'user-entered', effectiveAt: existing?.fx?.effectiveAt ?? null, provider: existing?.fx?.provider ?? null } : null;
  const amountEur = currency === 'EUR' ? amount : fx ? euroValue(amount, currency, null, fx).amountEur : null;
  const category = typeof body.category === 'string' ? body.category : existing?.category ?? '';
  const categoryId = Object.prototype.hasOwnProperty.call(body, 'categoryId')
    ? typeof body.categoryId === 'string' ? body.categoryId : null
    : existing?.categoryId ?? null;
  const description = typeof body.description === 'string' ? body.description : existing?.description ?? '';
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : existing?.tags ?? [];
  const liters = body.liters == null || body.liters === '' ? null : decimalInput(body.liters, 'liters');
  return {
    date: date ?? '', amount, currency, amountEur, fx, merchantName: typeof body.merchantName === 'string' ? body.merchantName : existing?.merchantName ?? null,
    category, categoryId, description, tags, items: existing?.items ?? [], liters,
    source: existing ? { kind: existing.sourceKind, id: existing.sourceId } : {
      kind: body.sourceKind === 'assistant-text' ? 'assistant-text' : 'manual',
      id: typeof body.sourceId === 'string' ? body.sourceId.trim().slice(0, 240) || null : null,
    },
  };
}

function normalizeCategoryBody(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Category body must be an object');
  const body = raw as Record<string, unknown>;
  if (typeof body.name !== 'string') throw new Error('Category name is required');
  const description = body.description === undefined || body.description === null ? null : typeof body.description === 'string' ? body.description : null;
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') throw new Error('Category description must be text or null');
  const parentId = body.parentId === undefined || body.parentId === null || body.parentId === '' ? null : typeof body.parentId === 'string' ? body.parentId : null;
  if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '' && typeof body.parentId !== 'string') throw new Error('Category parentId must be an ID or null');
  return { name: body.name, description, parentId };
}

function legacyRecord(accountId: string, value: Awaited<ReturnType<PersonalExpenseStore['list']>>[number]): ExpenseRecord {
  return {
    id: value.id, accountId, date: value.date, amount: decimalString(value.amount), currency: value.currency,
    amountEur: value.amountEur === null ? null : decimalString(value.amountEur),
    fx: value.fxRate ? { rate: decimalString(value.fxRate), convention: 'currency_units_per_eur', source: 'legacy-leveldb', effectiveAt: null, provider: null } : null,
    merchantId: null, merchantName: null, category: value.category, description: value.description, tags: value.tags,
    items: [], liters: value.liters == null ? null : decimalString(value.liters), sourceKind: 'legacy-leveldb',
    sourceId: value.legacyRecordId ?? value.id, legacyRecordId: value.legacyRecordId,
    createdAt: value.legacyCreatedAt ?? value.createdAt, updatedAt: value.legacyUpdatedAt ?? value.updatedAt,
    confirmedBy: accountId, confirmedAt: value.createdAt, legacyReadOnly: true,
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'Personal finance request failed'; }

function publicReceipt<T extends { storageKey: string }>(receipt: T) {
  const { storageKey: _privateStorageKey, ...safe } = receipt;
  return safe;
}

function publicDraft<T extends { receipts: Array<{ storageKey: string }> }>(draft: T) {
  return { ...draft, receipts: draft.receipts.map(publicReceipt) };
}

function normalizeDraftReview(raw: unknown): ExpenseDraftReviewWrite {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Draft review must be an object');
  const body = raw as Record<string, unknown>;
  const nullableText = (key: string, max: number) => {
    const value = body[key];
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || value.length > max) throw new Error(`${key} must be text or null`);
    return value;
  };
  if (!Array.isArray(body.items) || body.items.length > 1000) throw new Error('items must be an array of at most 1000 receipt lines');
  if (!Array.isArray(body.adjustments) || body.adjustments.length > 100) throw new Error('adjustments must be an array of at most 100 receipt adjustments');
  const adjustments = body.adjustments.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Receipt adjustment ${index + 1} is invalid`);
    const adjustment = value as Record<string, unknown>;
    if (typeof adjustment.label !== 'string' || adjustment.label.length > 160 || !['tax', 'discount', 'deposit', 'return', 'rounding', 'other'].includes(String(adjustment.kind))) throw new Error(`Receipt adjustment ${index + 1} is invalid`);
    if (adjustment.amount !== null && typeof adjustment.amount !== 'string') throw new Error(`Receipt adjustment ${index + 1} amount must be text or null`);
    if (adjustment.includedInTotal !== null && typeof adjustment.includedInTotal !== 'boolean') throw new Error(`Receipt adjustment ${index + 1} inclusion must be true, false, or null`);
    return { label: adjustment.label, kind: adjustment.kind as 'tax' | 'discount' | 'deposit' | 'return' | 'rounding' | 'other', amount: adjustment.amount as string | null, includedInTotal: adjustment.includedInTotal as boolean | null };
  });
  const items = body.items.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Receipt line ${index + 1} is invalid`);
    const item = value as Record<string, unknown>;
    const text = (key: string, max: number) => {
      if (typeof item[key] !== 'string' || (item[key] as string).length > max) throw new Error(`Receipt line ${index + 1}: ${key} is required`);
      return item[key] as string;
    };
    const decimal = (key: string) => {
      if (typeof item[key] !== 'string' || !(item[key] as string).trim()) throw new Error(`Receipt line ${index + 1}: ${key} is required`);
      return item[key] as string;
    };
    const optional = (key: string, max: number) => item[key] == null || item[key] === '' ? null : typeof item[key] === 'string' ? (item[key] as string).slice(0, max) : null;
    if (typeof item.taxIncluded !== 'boolean') throw new Error(`Receipt line ${index + 1}: taxIncluded must be explicit`);
    return {
      description: text('description', 240), productCode: optional('productCode', 100),
      quantity: decimal('quantity'), unit: text('unit', 40), unitPrice: decimal('unitPrice'),
      discount: decimal('discount'), tax: decimal('tax'), lineTotal: decimal('lineTotal'),
      currency: text('currency', 3), sourceReceiptId: optional('sourceReceiptId', 80),
      normalizedDescription: optional('normalizedDescription', 240), packaging: optional('packaging', 160),
      taxIncluded: item.taxIncluded, categoryId: optional('categoryId', 80),
      extractionProvenance: item.extractionProvenance && typeof item.extractionProvenance === 'object' ? item.extractionProvenance as Record<string, unknown> : null,
    } satisfies ExpenseItem;
  });
  if (typeof body.itemizationReviewed !== 'boolean') throw new Error('itemizationReviewed must be explicitly selected');
  if (typeof body.totalOnly !== 'boolean') throw new Error('totalOnly must be explicitly selected');
  const date = nullableText('date', 10);
  const amount = nullableText('amount', 64);
  const currency = nullableText('currency', 3);
  const categoryId = nullableText('categoryId', 80);
  return {
    date, amount, currency, merchantName: nullableText('merchantName', 180),
    category: nullableText('category', 80), categoryId, description: nullableText('description', 500),
    items, itemizationReviewed: body.itemizationReviewed, totalOnly: body.totalOnly, adjustments,
  };
}

function categorySummaryKey(categoryId: string | null, category: string): string {
  return categoryId ? `id:${categoryId}` : `text:${category}`;
}

function monthlyPaceDays(fromDate?: string, toDate?: string): number | null {
  if (!fromDate || !toDate || !/^\d{4}-\d{2}-01$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return null;
  const [year, month] = fromDate.split('-').map(Number);
  if (month < 1 || month > 12 || toDate !== new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)) return null;
  const now = new Date();
  if (now.getFullYear() === year && now.getMonth() + 1 === month) return now.getDate();
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function normalizeV2Import(raw: unknown, index = 0): ExpenseImportRow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Record ${index + 1} must be an object`);
  const row = raw as Record<string, unknown>;
  const date = legacyDate(row.date);
  if (!date) throw new Error(`Record ${index + 1}: date is missing or invalid`);
  const amount = financeDecimal(decimalInput(row.amount, `Record ${index + 1}: amount`));
  const currency = normalizeCurrency(typeof row.currency === 'string' ? row.currency : 'BGN');
  const category = typeof row.category === 'string' ? row.category.trim().slice(0, 80) : '';
  const description = typeof row.description === 'string' ? row.description.trim().slice(0, 500) : '';
  if (!category || !description) throw new Error(`Record ${index + 1}: category and description are required`);
  const suppliedSource = row.source && typeof row.source === 'object' ? row.source as Record<string, unknown> : null;
  const mongoNamespace = 'mongo:mono.expenses:';
  const suppliedMongoId = suppliedSource?.kind === 'legacy-mongo' ? objectId(suppliedSource.id) : null;
  const mongoCandidate = objectId(row._id) ?? suppliedMongoId;
  const mongoSourceId = mongoCandidate?.startsWith(mongoNamespace)
    ? mongoCandidate.slice(mongoNamespace.length)
    : mongoCandidate;
  const legacyRecordId = objectId(row.legacyRecordId) ?? mongoSourceId ?? (typeof row.id === 'string' && row.id.trim() ? row.id.trim().slice(0, 240) : objectId(suppliedSource?.id));
  const sourceId = mongoSourceId ? `${mongoNamespace}${mongoSourceId}` : legacyRecordId;
  if (!sourceId) throw new Error(`Record ${index + 1}: a legacy _id, legacyRecordId, or id is required for safe retries`);
  const suppliedFx = row.fx && typeof row.fx === 'object' ? row.fx as Record<string, unknown> : null;
  const fxRate = row.fxRate == null ? suppliedFx?.rate == null ? null : financeDecimal(decimalInput(suppliedFx.rate, `Record ${index + 1}: fx.rate`)) : financeDecimal(decimalInput(row.fxRate, `Record ${index + 1}: fxRate`));
  const fx = fxRate ? {
    rate: fxRate, convention: 'currency_units_per_eur' as const,
    source: typeof suppliedFx?.source === 'string' ? suppliedFx.source.slice(0, 100) : 'legacy-import',
    effectiveAt: typeof suppliedFx?.effectiveAt === 'string' ? suppliedFx.effectiveAt : null,
    provider: typeof suppliedFx?.provider === 'string' ? suppliedFx.provider.slice(0, 100) : null,
  } : null;
  const amountEur = row.amountEur == null ? null : financeDecimal(decimalInput(row.amountEur, `Record ${index + 1}: amountEur`));
  const converted = euroValue(amount, currency, amountEur, fx);
  const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim().slice(0, 60)).filter(Boolean).slice(0, 30) : [];
  const liters = row.liters == null ? null : financeDecimal(decimalInput(row.liters, `Record ${index + 1}: liters`));
  const sourceKind: ExpenseSourceKind = mongoSourceId || suppliedSource?.kind === 'legacy-mongo' ? 'legacy-mongo' : 'legacy-leveldb';
  const sourceCreatedAt = legacyTimestamp(row.sourceCreatedAt ?? row.createdAt);
  const sourceUpdatedAt = legacyTimestamp(row.sourceUpdatedAt ?? row.updatedAt);
  return {
    date, amount, currency, amountEur: converted.amountEur, fx: converted.fx,
    merchantName: typeof row.merchantName === 'string' ? row.merchantName.trim().slice(0, 180) : null,
    category, description, tags, items: [], liters,
    source: { kind: sourceKind, id: sourceId, provider: typeof suppliedSource?.provider === 'string' ? suppliedSource.provider.slice(0, 100) : 'historical-import', model: typeof suppliedSource?.model === 'string' ? suppliedSource.model.slice(0, 160) : null, contentHash: typeof suppliedSource?.contentHash === 'string' ? suppliedSource.contentHash.slice(0, 128) : null }, legacyRecordId,
    sourceCreatedAt, sourceUpdatedAt,
  };
}

function decimalInput(value: unknown, label: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label} must be a decimal value`);
  return decimalString(value);
}

function objectId(value: unknown): string | null {
  if (value && typeof value === 'object' && '$oid' in value && typeof (value as { $oid?: unknown }).$oid === 'string') return (value as { $oid: string }).$oid.slice(0, 120);
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
}

function legacyDate(value: unknown): string | null {
  if (value && typeof value === 'object' && '$date' in value) value = (value as { $date: unknown }).$date;
  const parsed = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function legacyTimestamp(value: unknown): string | null {
  if (value && typeof value === 'object' && '$date' in value) value = (value as { $date: unknown }).$date;
  const parsed = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}
