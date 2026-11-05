import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Header, HttpException, NotFoundException, Param, Patch, Post, Query, Req, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AccessJwtGuard, requirePrincipal } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PersonalFinanceApplication } from './application/personal-finance.application';
import { ReceiptIntelligenceApplication } from './application/receipt-intelligence.application';
import { compareDecimal, decimalString, financeDecimal } from './domain/decimal';
import { euroValue, normalizeCurrency } from './domain/expense-rules';
import type { ExpenseItem, ExpenseQuery, ExpenseRecord, ExpenseSourceKind } from './domain/personal-finance.types';
import { ExpenseVersionConflictError } from './application/ports/personal-finance.repository';
import type { ExpenseDraftReviewWrite, ExpenseImportRow, ExpenseWrite } from './application/ports/personal-finance.repository';

@Controller('personal-finance')
@UseGuards(AccessJwtGuard)
export class PersonalFinanceController {
  constructor(private readonly finance: PersonalFinanceApplication, private readonly receipts: ReceiptIntelligenceApplication) {}

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
      return { draft: publicDraft(result.draft), reconciliation: result.reconciliation };
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
    const accountId = requirePrincipal(request).userId;
    const result = await this.receipts.getDraft({ accountId, actorId: accountId }, id);
    if (!result) throw new NotFoundException('Expense draft not found');
    return { draft: publicDraft(result.draft), reconciliation: result.reconciliation, preview: result.preview };
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
      return { expenses: await this.finance.queryExpenses({ accountId, query: parsed }) };
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
      const revision = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).expectedRevision : undefined;
      if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new BadRequestException('expectedRevision must be a positive integer');
      const old = await this.finance.getExpense(actorId, id);
      if (!old) throw new NotFoundException('Expense not found');
      const updated = await this.finance.updateExpense(actorId, actorId, id, normalizeExpenseBody(body, old), revision as number);
      if (!updated) throw new NotFoundException('Expense not found');
      return { expense: updated };
    } catch (error) {
      if (error instanceof ExpenseVersionConflictError) throw new ConflictException(error.message);
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(message(error));
    }
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
      const stored = await this.finance.findImportedLegacyIds(accountId, ids);
      const seen = new Set(stored);
      const ready: ExpenseImportRow[] = [];
      let duplicateCount = 0;
      for (const row of records) {
        const rowIds = [row.legacyRecordId, row.source.id].filter((id): id is string => Boolean(id));
        if (rowIds.some((id) => seen.has(id))) { duplicateCount++; continue; }
        ready.push(row);
        rowIds.forEach((id) => seen.add(id));
      }
      return { records: ready, total: raw.length, valid: ready.length, duplicates: duplicateCount, errors };
    } catch (error) { throw new BadRequestException(message(error)); }
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
      const stored = await this.finance.findImportedLegacyIds(actorId, ids);
      const seen = new Set(stored);
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
    } catch (error) { throw new BadRequestException(message(error)); }
  }

  @Get('summary')
  async summary(@Query() query: Record<string, string | undefined>, @Req() request: AuthenticatedRequest) {
    const accountId = requirePrincipal(request).userId;
    try { return await this.finance.summarizeSpending({ accountId, query: { fromDate: query.fromDate, toDate: query.toDate } }); }
    catch (error) { throw new BadRequestException(message(error)); }
  }
}

function normalizeExpenseBody(raw: unknown, existing?: ExpenseRecord): ExpenseWrite {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expense body must be an object');
  const body = raw as Record<string, unknown>;
  const date = typeof body.date === 'string' ? body.date : existing?.date;
  const amount = body.amount === undefined && existing ? existing.amount : decimalInput(body.amount, 'amount');
  const currency = normalizeCurrency(typeof body.currency === 'string' ? body.currency : existing?.currency ?? 'EUR');
  const fxRate = body.fxRate === undefined ? existing?.fx?.rate ?? null
    : body.fxRate === null || body.fxRate === '' ? null : financeDecimal(decimalInput(body.fxRate, 'fxRate'));
  const fxUnchanged = fxRate === null ? existing?.fx == null
    : existing?.fx != null && compareDecimal(fxRate, existing.fx.rate) === 0;
  const fx = currency === 'EUR' ? null : fxRate ? {
    rate: fxRate, convention: 'currency_units_per_eur' as const,
    source: body.fxRate !== undefined && !fxUnchanged ? 'user-entered' : existing?.fx?.source ?? 'user-entered',
    effectiveAt: body.fxRate !== undefined && !fxUnchanged ? null : existing?.fx?.effectiveAt ?? null,
    provider: body.fxRate !== undefined && !fxUnchanged ? null : existing?.fx?.provider ?? null,
  } : null;
  // A metadata-only edit must not discard historical EUR values stored independently of FX.
  const financialValuesUnchanged = existing && currency === existing.currency
    && compareDecimal(amount, existing.amount) === 0 && fxUnchanged;
  const amountEur = existing && financialValuesUnchanged ? existing.amountEur
    : currency === 'EUR' ? amount : fx ? euroValue(amount, currency, null, fx).amountEur : null;
  const category = typeof body.category === 'string' ? body.category : existing?.category ?? '';
  const categoryId = Object.prototype.hasOwnProperty.call(body, 'categoryId')
    ? typeof body.categoryId === 'string' ? body.categoryId : null
    : existing?.categoryId ?? null;
  const description = typeof body.description === 'string' ? body.description : existing?.description ?? '';
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : existing?.tags ?? [];
  const liters = body.liters === undefined ? existing?.liters ?? null
    : body.liters === null || body.liters === '' ? null : decimalInput(body.liters, 'liters');
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

function message(error: unknown): string { return error instanceof Error ? error.message : 'Personal finance request failed'; }

function publicReceipt<T extends { storageKey: string }>(receipt: T) {
  const { storageKey: _privateStorageKey, ...safe } = receipt;
  const extraction = (safe as Record<string, any>).extraction;
  if (extraction?.ocrEvidence) {
    const { ocrEvidence: _privateOcrEvidence, ...publicExtraction } = extraction;
    return { ...safe, extraction: publicExtraction };
  }
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
    if (adjustment.signedAmount !== null && adjustment.signedAmount !== undefined && typeof adjustment.signedAmount !== 'string') throw new Error(`Receipt adjustment ${index + 1} signed amount must be text or null`);
    if (adjustment.includedInTotal !== null && typeof adjustment.includedInTotal !== 'boolean') throw new Error(`Receipt adjustment ${index + 1} inclusion must be true, false, or null`);
    if (adjustment.includedInLineTotal !== null && adjustment.includedInLineTotal !== undefined && typeof adjustment.includedInLineTotal !== 'boolean') throw new Error(`Receipt adjustment ${index + 1} line inclusion must be true, false, or null`);
    if (adjustment.relatedPurchaseIndex !== null && adjustment.relatedPurchaseIndex !== undefined && (!Number.isSafeInteger(adjustment.relatedPurchaseIndex) || Number(adjustment.relatedPurchaseIndex) < 0)) throw new Error(`Receipt adjustment ${index + 1} purchase reference is invalid`);
    return { label: adjustment.label, kind: adjustment.kind as 'tax' | 'discount' | 'deposit' | 'return' | 'rounding' | 'other', amount: adjustment.amount as string | null, signedAmount: adjustment.signedAmount as string | null | undefined, includedInTotal: adjustment.includedInTotal as boolean | null, includedInLineTotal: adjustment.includedInLineTotal as boolean | null | undefined, relatedPurchaseIndex: adjustment.relatedPurchaseIndex as number | null | undefined };
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
  if (body.financialFindingsAcknowledged !== undefined && typeof body.financialFindingsAcknowledged !== 'boolean') throw new Error('financialFindingsAcknowledged must be a boolean');
  if (typeof body.totalOnly !== 'boolean') throw new Error('totalOnly must be explicitly selected');
  const date = nullableText('date', 10);
  const amount = nullableText('amount', 64);
  const currency = nullableText('currency', 3);
  const categoryId = nullableText('categoryId', 80);
  return {
    date, amount, currency, merchantName: nullableText('merchantName', 180),
    category: nullableText('category', 80), categoryId, description: nullableText('description', 500),
    items, itemizationReviewed: body.itemizationReviewed, financialFindingsAcknowledged: body.financialFindingsAcknowledged === true, totalOnly: body.totalOnly, adjustments,
  };
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
