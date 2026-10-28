import { addDecimal, compareDecimal, decimalString } from '../domain/decimal';

export type ReconciliationSource = 'mongo' | 'postgres' | 'leveldb';

/** A database-independent snapshot row. Callers must export each source through its supported access path. */
export interface ReconciliationRecord {
  ownerId: string;
  date: string;
  amount: string | number;
  currency: string;
  category: string;
  description: string;
  tags?: readonly string[];
  liters?: string | number | null;
  sourceKind: string;
  sourceId: string | null;
  legacyRecordId?: string | null;
}

export interface HistoricalReconciliationInput {
  targetAccountId: string;
  mongoOwnerId: string;
  mongo: readonly ReconciliationRecord[];
  postgres: readonly ReconciliationRecord[];
  leveldb: readonly ReconciliationRecord[];
}

export interface HistoricalReconciliationReport {
  targetAccountId: string;
  counts: {
    mongo: number;
    postgres: number;
    leveldb: number;
    confirmedSourceDuplicates: number;
    possibleDuplicates: number;
    ownershipMismatches: number;
    validationErrors: number;
    duplicateMongoSourceIds: number;
  };
  totalsByOriginalCurrency: Record<ReconciliationSource, Record<string, string>>;
  monthlyTotalsByOriginalCurrency: Record<ReconciliationSource, Record<string, Record<string, string>>>;
  dateRanges: Record<ReconciliationSource, { earliest: string | null; latest: string | null }>;
  confirmedDuplicates: Array<{ mongoSourceId: string; matchedSource: 'postgres' | 'leveldb'; matchedId: string }>;
  possibleDuplicates: Array<{ mongoSourceId: string; matchedSource: 'postgres' | 'leveldb'; matchedId: string; reasons: string[] }>;
  duplicateMongoSourceIds: string[];
  ownershipMismatches: Array<{ source: ReconciliationSource; sourceId: string | null; ownerId: string; expectedOwnerId: string }>;
  validationErrors: Array<{ source: ReconciliationSource; sourceId: string | null; index: number; reason: string }>;
  readyToImport: boolean;
}

/**
 * Reconciles an exported snapshot without opening stores or performing writes.
 * Only an identical, namespaced Mongo source identity is a confirmed duplicate.
 * Similar transaction data is always a review candidate; it is never auto-dropped.
 */
export function reconcileHistoricalExpenses(input: HistoricalReconciliationInput): HistoricalReconciliationReport {
  if (!input.targetAccountId.trim() || !input.mongoOwnerId.trim()) throw new Error('Both target and approved Mongo owner IDs are required');
  const ownershipMismatches: HistoricalReconciliationReport['ownershipMismatches'] = [];
  const validationErrors: HistoricalReconciliationReport['validationErrors'] = [];
  const expected: Record<ReconciliationSource, string> = {
    mongo: input.mongoOwnerId,
    postgres: input.targetAccountId,
    leveldb: input.targetAccountId,
  };
  const sources: Record<ReconciliationSource, readonly ReconciliationRecord[]> = {
    mongo: input.mongo,
    postgres: input.postgres,
    leveldb: input.leveldb,
  };
  for (const source of Object.keys(sources) as ReconciliationSource[]) {
    for (const [index, record] of sources[source].entries()) {
      if (!record || typeof record !== 'object') {
        validationErrors.push({ source, sourceId: null, index, reason: 'record must be an object' });
        continue;
      }
      if (record.ownerId !== expected[source]) {
        ownershipMismatches.push({ source, sourceId: record.sourceId, ownerId: record.ownerId, expectedOwnerId: expected[source] });
      }
      const validationError = validateRecord(record, source);
      if (validationError) validationErrors.push({ source, sourceId: record.sourceId, index, reason: validationError });
    }
  }

  const invalidIndex = new Set(validationErrors.map((issue) => `${issue.source}:${issue.index}`));
  const scoped = (source: ReconciliationSource) => sources[source].filter((record, index) => record.ownerId === expected[source] && !invalidIndex.has(`${source}:${index}`));
  const mongo = scoped('mongo');
  const postgres = scoped('postgres');
  const leveldb = scoped('leveldb');
  const confirmedDuplicates: HistoricalReconciliationReport['confirmedDuplicates'] = [];
  const possibleDuplicates: HistoricalReconciliationReport['possibleDuplicates'] = [];
  const idCounts = new Map<string, number>();
  for (const record of mongo) {
    const identity = mongoIdentity(record);
    if (identity) idCounts.set(identity, (idCounts.get(identity) ?? 0) + 1);
  }
  const duplicateMongoSourceIds = [...idCounts].filter(([, count]) => count > 1).map(([identity]) => identity);

  for (const sourceRecord of mongo) {
    const mongoId = mongoIdentity(sourceRecord);
    if (!mongoId) continue;
    for (const [matchedSource, rows] of [['postgres', postgres], ['leveldb', leveldb]] as const) {
      for (const target of rows) {
        if (sameMongoIdentity(sourceRecord, target)) {
          confirmedDuplicates.push({ mongoSourceId: mongoId, matchedSource, matchedId: target.sourceId ?? target.legacyRecordId ?? '(missing id)' });
        } else {
          const reasons = similarityReasons(sourceRecord, target);
          if (reasons.length) {
            possibleDuplicates.push({ mongoSourceId: mongoId, matchedSource, matchedId: target.sourceId ?? target.legacyRecordId ?? '(missing id)', reasons });
          }
        }
      }
    }
  }

  return {
    targetAccountId: input.targetAccountId,
    counts: {
      mongo: mongo.length, postgres: postgres.length, leveldb: leveldb.length,
      confirmedSourceDuplicates: confirmedDuplicates.length, possibleDuplicates: possibleDuplicates.length,
      ownershipMismatches: ownershipMismatches.length, validationErrors: validationErrors.length,
      duplicateMongoSourceIds: duplicateMongoSourceIds.length,
    },
    totalsByOriginalCurrency: {
      mongo: totals(mongo), postgres: totals(postgres), leveldb: totals(leveldb),
    },
    monthlyTotalsByOriginalCurrency: {
      mongo: monthlyTotals(mongo), postgres: monthlyTotals(postgres), leveldb: monthlyTotals(leveldb),
    },
    dateRanges: { mongo: dateRange(mongo), postgres: dateRange(postgres), leveldb: dateRange(leveldb) },
    confirmedDuplicates,
    possibleDuplicates,
    duplicateMongoSourceIds,
    ownershipMismatches,
    validationErrors,
    readyToImport: ownershipMismatches.length === 0 && validationErrors.length === 0 && possibleDuplicates.length === 0 && duplicateMongoSourceIds.length === 0,
  };
}

function validateRecord(record: ReconciliationRecord, source: ReconciliationSource): string | null {
  if (!record || typeof record !== 'object') return 'record must be an object';
  if (typeof record.ownerId !== 'string' || !record.ownerId.trim()) return 'owner ID is missing';
  if (typeof record.sourceKind !== 'string' || !record.sourceKind.trim()) return 'source kind is missing';
  if (typeof record.sourceId !== 'string' || !record.sourceId.trim()) return 'stable source ID is missing';
  if (source === 'mongo' && record.sourceKind !== 'legacy-mongo') return 'Mongo row must have legacy-mongo provenance';
  if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || Number.isNaN(Date.parse(`${record.date}T00:00:00Z`)) || new Date(`${record.date}T00:00:00Z`).toISOString().slice(0, 10) !== record.date) return 'date must be a valid ISO calendar date';
  if (typeof record.currency !== 'string' || !/^[A-Z]{3}$/.test(record.currency.trim().toUpperCase())) return 'currency must be an ISO 4217 code';
  if (typeof record.category !== 'string' || !record.category.trim()) return 'category is missing';
  if (typeof record.description !== 'string' || !record.description.trim()) return 'description is missing';
  try {
    if (compareDecimal(decimalString(record.amount), '0') <= 0) return 'amount must be greater than zero';
  } catch { return 'amount must be a valid exact decimal'; }
  return null;
}

function mongoIdentity(record: ReconciliationRecord): string | null {
  if (record.sourceKind !== 'legacy-mongo' || !record.sourceId) return null;
  return record.sourceId.startsWith('mongo:mono.expenses:') ? record.sourceId : `mongo:mono.expenses:${record.sourceId}`;
}

function sameMongoIdentity(mongo: ReconciliationRecord, candidate: ReconciliationRecord): boolean {
  const identity = mongoIdentity(mongo);
  if (!identity) return false;
  if (candidate.sourceKind === 'legacy-mongo' && mongoIdentity(candidate) === identity) return true;
  // A raw legacy ID is supporting evidence, but does not prove the original Mongo collection.
  return false;
}

function similarityReasons(left: ReconciliationRecord, right: ReconciliationRecord): string[] {
  const reasons: string[] = [];
  const rawMongoId = mongoIdentity(left)?.slice('mongo:mono.expenses:'.length);
  const otherIds = [right.sourceId, right.legacyRecordId].filter((value): value is string => typeof value === 'string');
  if (rawMongoId && otherIds.some((id) => id === rawMongoId || id === `mongo:mono.expenses:${rawMongoId}`)) reasons.push('same-raw-source-id-review');
  const sameDate = left.date.slice(0, 10) === right.date.slice(0, 10);
  const sameCurrency = left.currency.trim().toUpperCase() === right.currency.trim().toUpperCase();
  let sameAmount = false;
  try { sameAmount = decimalString(left.amount) === decimalString(right.amount); } catch { /* malformed snapshot is reported separately by import validation */ }
  if (sameDate) reasons.push('same-date');
  if (sameCurrency) reasons.push('same-currency');
  if (sameAmount) reasons.push('same-amount');
  if (canonical(left.description) && canonical(left.description) === canonical(right.description)) reasons.push('same-description');
  if (canonical(left.category) && canonical(left.category) === canonical(right.category)) reasons.push('same-category');
  const tagSet = (record: ReconciliationRecord) => (record.tags ?? []).map(canonical).filter(Boolean).sort().join('|');
  if (tagSet(left) && tagSet(left) === tagSet(right)) reasons.push('same-tags');
  if (left.liters != null && right.liters != null) {
    try { if (decimalString(left.liters) === decimalString(right.liters)) reasons.push('same-liters'); } catch { /* validation reports malformed values */ }
  }
  if (reasons.includes('same-raw-source-id-review')) return reasons;
  // Date, amount, and currency alone are too weak to flag a candidate.
  return sameDate && sameCurrency && sameAmount && reasons.length > 3 ? reasons : [];
}

function canonical(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, ' '); }

function totals(records: readonly ReconciliationRecord[]): Record<string, string> {
  const byCurrency: Record<string, string> = {};
  for (const record of records) {
    const currency = record.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    try { byCurrency[currency] = addDecimal(byCurrency[currency] ?? '0', record.amount); } catch { /* invalid rows remain subject to import validation */ }
  }
  return byCurrency;
}

function monthlyTotals(records: readonly ReconciliationRecord[]): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const record of records) {
    const month = record.date.slice(0, 7);
    const currency = record.currency.trim().toUpperCase();
    if (!/^\d{4}-\d{2}$/.test(month) || !/^[A-Z]{3}$/.test(currency)) continue;
    result[month] ??= {};
    try { result[month][currency] = addDecimal(result[month][currency] ?? '0', record.amount); } catch { /* invalid rows are surfaced in validationErrors */ }
  }
  return result;
}

function dateRange(records: readonly ReconciliationRecord[]): { earliest: string | null; latest: string | null } {
  const dates = records.map((record) => record.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  return { earliest: dates[0] ?? null, latest: dates[dates.length - 1] ?? null };
}
