import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ClassicLevel } from 'classic-level';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BGN_PER_EUR } from './personal-expense.types';
import type {
  ExpenseImportPreview,
  ExpenseInput,
  PersonalExpense,
} from './personal-expense.types';

export const PERSONAL_EXPENSE_DIRECTORY =
  'ENERGRID_PERSONAL_EXPENSES_DIRECTORY';
export const PERSONAL_EXPENSE_STORE_DIRECTORY =
  'PERSONAL_EXPENSE_STORE_DIRECTORY';

function defaultDirectory(): string {
  return (
    process.env[PERSONAL_EXPENSE_DIRECTORY]?.trim() ||
    join(homedir(), '.energrid', 'personal-expenses')
  );
}

function ownerKey(ownerId: string): string {
  return encodeURIComponent(ownerId);
}
function recordKey(ownerId: string, id: string): string {
  return `record:${ownerKey(ownerId)}:${id}`;
}
function indexPrefix(ownerId: string): string {
  return `index:${ownerKey(ownerId)}:`;
}
function sourceKey(ownerId: string, sourceId: string): string {
  return `source:${ownerKey(ownerId)}:${encodeURIComponent(sourceId)}`;
}

@Injectable()
export class PersonalExpenseStore implements OnModuleDestroy {
  private readonly db: ClassicLevel<string, unknown>;

  constructor(
    @Optional() @Inject(PERSONAL_EXPENSE_STORE_DIRECTORY) directory?: string,
  ) {
    const root = directory?.trim() || defaultDirectory();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(root, 0o700);
    } catch {
      /* Keep startup portable when directory permissions are managed externally. */
    }
    this.db = new ClassicLevel(root, { valueEncoding: 'json' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.close();
  }

  async list(ownerId: string): Promise<PersonalExpense[]> {
    const ids: string[] = [];
    const prefix = indexPrefix(ownerId);
    for await (const [, id] of this.db.iterator({
      gte: prefix,
      lt: `${prefix}\uffff`,
      reverse: true,
      limit: 10000,
    })) {
      if (typeof id === 'string') ids.push(id);
    }
    const records = await Promise.all(ids.map((id) => this.get(ownerId, id)));
    return records.filter((record): record is PersonalExpense =>
      Boolean(record),
    );
  }

  async get(ownerId: string, id: string): Promise<PersonalExpense | null> {
    try {
      const value = await this.db.get(recordKey(ownerId, id));
      return value && typeof value === 'object'
        ? (value as PersonalExpense)
        : null;
    } catch (error) {
      if (isMissingKey(error)) return null;
      throw error;
    }
  }

  async hasLegacyId(ownerId: string, legacyId: string): Promise<boolean> {
    try {
      await this.db.get(sourceKey(ownerId, legacyId));
      return true;
    } catch (error) {
      if (isMissingKey(error)) return false;
      throw error;
    }
  }

  async save(
    ownerId: string,
    values: Omit<PersonalExpense, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PersonalExpense> {
    const now = new Date().toISOString();
    const id = values.legacyRecordId
      ? createHash('sha256')
          .update(`${ownerId}\u0000${values.legacyRecordId}`)
          .digest('hex')
      : randomUUID();
    const record: PersonalExpense = {
      ...values,
      id,
      createdAt: now,
      updatedAt: now,
    };
    const batch: Array<{ type: 'put'; key: string; value: unknown }> = [
      { type: 'put', key: recordKey(ownerId, record.id), value: record },
      {
        type: 'put',
        key: `${indexPrefix(ownerId)}${record.date}:${record.id}`,
        value: record.id,
      },
    ];
    if (record.legacyRecordId)
      batch.push({
        type: 'put',
        key: sourceKey(ownerId, record.legacyRecordId),
        value: record.id,
      });
    await this.db.batch(batch);
    return record;
  }

  async update(
    ownerId: string,
    id: string,
    values: Omit<PersonalExpense, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PersonalExpense | null> {
    const existing = await this.get(ownerId, id);
    if (!existing) return null;
    const record: PersonalExpense = {
      ...values,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      ...(existing.legacyRecordId
        ? {
            legacyRecordId: existing.legacyRecordId,
            legacyCreatedAt: existing.legacyCreatedAt,
            legacyUpdatedAt: existing.legacyUpdatedAt,
          }
        : {}),
    };
    await this.db.batch([
      { type: 'del', key: `${indexPrefix(ownerId)}${existing.date}:${id}` },
      { type: 'put', key: recordKey(ownerId, id), value: record },
      {
        type: 'put',
        key: `${indexPrefix(ownerId)}${record.date}:${id}`,
        value: id,
      },
    ]);
    return record;
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    const record = await this.get(ownerId, id);
    if (!record) return false;
    await this.db.batch([
      { type: 'del', key: recordKey(ownerId, id) },
      { type: 'del', key: `${indexPrefix(ownerId)}${record.date}:${id}` },
      ...(record.legacyRecordId
        ? [
            {
              type: 'del' as const,
              key: sourceKey(ownerId, record.legacyRecordId),
            },
          ]
        : []),
    ]);
    return true;
  }
}

export function collectExpenseInputs(input: unknown): ExpenseInput[] {
  if (Array.isArray(input)) return input.filter(isObject) as ExpenseInput[];
  if (!isObject(input)) return [];
  for (const key of ['expenses', 'records', 'data']) {
    if (Array.isArray(input[key]))
      return (input[key] as unknown[]).filter(isObject) as ExpenseInput[];
  }
  return [input as ExpenseInput];
}

export function normalizeExpenseInput(input: ExpenseInput): {
  expense?: Omit<PersonalExpense, 'id' | 'createdAt' | 'updatedAt'>;
  error?: string;
} {
  const date = normalizeDate(input.date);
  const amount = finite(input.amount);
  const category =
    typeof input.category === 'string'
      ? input.category.trim().slice(0, 80)
      : '';
  const description =
    typeof input.description === 'string'
      ? input.description.trim().slice(0, 500)
      : '';
  const currencyRaw =
    typeof input.currency === 'string'
      ? input.currency.trim().toUpperCase()
      : 'BGN';
  const currency = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : '';
  if (!date) return { error: 'date is missing or invalid' };
  if (amount === null || amount <= 0)
    return { error: 'amount must be greater than zero' };
  if (!currency) return { error: 'currency must be a three-letter code' };
  if (!category) return { error: 'category is missing' };
  if (!description) return { error: 'description is missing' };
  const tags = Array.isArray(input.tags)
    ? input.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 30)
    : [];
  const amountEurInput = finite(input.amountEur);
  const fxRate = finite(input.fxRate);
  let amountEur: number | null =
    amountEurInput !== null && amountEurInput >= 0 ? amountEurInput : null;
  if (amountEur === null) {
    if (currency === 'EUR') amountEur = amount;
    else if (fxRate !== null && fxRate > 0) amountEur = amount / fxRate;
    else if (currency === 'BGN') amountEur = amount / BGN_PER_EUR;
  }
  const legacyRecordId = normalizeLegacyId(input.legacyRecordId ?? input._id);
  return {
    expense: {
      date,
      amount,
      currency,
      amountEur,
      ...(fxRate !== null && fxRate > 0 ? { fxRate } : {}),
      category,
      description,
      tags,
      ...(finite(input.liters) !== null && finite(input.liters)! > 0
        ? { liters: finite(input.liters)! }
        : {}),
      ...(legacyRecordId ? { legacyRecordId } : {}),
      ...(normalizeDateTime(input.createdAt)
        ? { legacyCreatedAt: normalizeDateTime(input.createdAt)! }
        : {}),
      ...(normalizeDateTime(input.updatedAt)
        ? { legacyUpdatedAt: normalizeDateTime(input.updatedAt)! }
        : {}),
    },
  };
}

export async function previewExpenseImport(
  ownerId: string,
  raw: unknown,
  store: PersonalExpenseStore,
): Promise<ExpenseImportPreview> {
  const inputs = collectExpenseInputs(raw);
  const records: ExpenseImportPreview['records'] = [];
  const errors: string[] = [];
  const seenLegacyIds = new Set<string>();
  let duplicates = 0;
  for (let index = 0; index < inputs.length; index++) {
    const normalized = normalizeExpenseInput(inputs[index]);
    if (!normalized.expense) {
      if (errors.length < 30)
        errors.push(
          `Record ${index + 1}: ${normalized.error || 'invalid record'}`,
        );
      continue;
    }
    if (normalized.expense.legacyRecordId) {
      if (
        seenLegacyIds.has(normalized.expense.legacyRecordId) ||
        (await store.hasLegacyId(ownerId, normalized.expense.legacyRecordId))
      ) {
        duplicates++;
        continue;
      }
      seenLegacyIds.add(normalized.expense.legacyRecordId);
    }
    records.push(normalized.expense);
  }
  if (!inputs.length)
    errors.push(
      'No expense records found. Choose an array, a MongoDB export, or an object containing an expenses array.',
    );
  return {
    records,
    total: inputs.length,
    valid: records.length,
    duplicates,
    errors,
  };
}

function normalizeDate(value: unknown): string | null {
  if (isObject(value) && '$date' in value) value = value.$date;
  const parsed =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeDateTime(value: unknown): string | undefined {
  if (isObject(value) && '$date' in value) value = value.$date;
  const parsed =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString()
    : undefined;
}

function normalizeLegacyId(value: unknown): string | undefined {
  if (isObject(value) && '$oid' in value && typeof value.$oid === 'string')
    return value.$oid.slice(0, 120);
  if (typeof value === 'string' && value.trim())
    return value.trim().slice(0, 120);
  return undefined;
}

function finite(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isMissingKey(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'LEVEL_NOT_FOUND'
  );
}
