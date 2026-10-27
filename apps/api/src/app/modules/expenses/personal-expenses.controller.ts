import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessJwtGuard, requirePrincipal } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  normalizeExpenseInput,
  PersonalExpenseStore,
  previewExpenseImport,
} from './personal-expense.store';
import { PersonalExpenseCaptureService } from './personal-expense-capture.service';

@Controller('personal-expenses')
@UseGuards(AccessJwtGuard)
export class PersonalExpensesController {
  constructor(
    private readonly store: PersonalExpenseStore,
    private readonly capture: PersonalExpenseCaptureService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const principal = requirePrincipal(request);
    return { expenses: await this.store.list(principal.userId) };
  }

  @Get('ai/status')
  aiStatus() {
    return this.capture.availability();
  }

  @Post('parse')
  async parseDescription(
    @Body() body: { text?: unknown; cloudDataConsent?: unknown },
  ) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 1200)
      throw new BadRequestException(
        'Describe one expense in 1–1200 characters.',
      );
    if (body?.cloudDataConsent !== true)
      throw new ForbiddenException(
        'Confirm AI processing before sending this description.',
      );
    return { draft: await this.capture.parse(text, true) };
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const principal = requirePrincipal(request);
    const normalized = normalizeExpenseInput(
      body && typeof body === 'object' ? body : {},
    );
    if (!normalized.expense)
      throw new BadRequestException(normalized.error || 'Expense is invalid');
    return {
      expense: await this.store.save(principal.userId, normalized.expense),
    };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const principal = requirePrincipal(request);
    const normalized = normalizeExpenseInput(
      body && typeof body === 'object' ? body : {},
    );
    if (!normalized.expense)
      throw new BadRequestException(normalized.error || 'Expense is invalid');
    const expense = await this.store.update(
      principal.userId,
      id,
      normalized.expense,
    );
    if (!expense) throw new BadRequestException('Expense not found');
    return { expense };
  }

  @Post('import/preview')
  async preview(
    @Body() body: { records?: unknown },
    @Req() request: AuthenticatedRequest,
  ) {
    const principal = requirePrincipal(request);
    return previewExpenseImport(principal.userId, body?.records, this.store);
  }

  @Post('import')
  async import(
    @Body() body: { records?: unknown },
    @Req() request: AuthenticatedRequest,
  ) {
    const principal = requirePrincipal(request);
    const preview = await previewExpenseImport(
      principal.userId,
      body?.records,
      this.store,
    );
    const imported = [];
    for (const expense of preview.records)
      imported.push(await this.store.save(principal.userId, expense));
    return {
      imported: imported.length,
      skippedDuplicates: preview.duplicates,
      rejected: preview.total - preview.valid - preview.duplicates,
      errors: preview.errors,
    };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const principal = requirePrincipal(request);
    if (!(await this.store.remove(principal.userId, id)))
      throw new BadRequestException('Expense not found');
    return { deleted: true };
  }
}
