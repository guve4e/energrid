import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProposal } from './benchmark_hybrid';

const fixturePath = path.resolve(__dirname, '../../apps/api/src/app/modules/expenses/domain/fixtures/lidl-2026-10-27.v1-1.redacted.fixture.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const evidenceText = collectValues(fixture).join(' ');
const evidence = { recognizer: 'synthetic-test', lines: [{ id: 0, order: 0, text: evidenceText, confidence: 0.9, box: [0, 0, 1, 1] }] };

const valid = modelProposal(fixture);
const accepted = normalizeProposal(valid, evidence);
assert.ok(accepted.extraction, accepted.issues.join('; '));
assert.equal(accepted.invalidReferenceCount, 0);
assert.equal(accepted.unsupportedAmountCount, 0);

const inventedReference = structuredClone(valid);
inventedReference.total.sourceLineIds = [900];
const rejectedReference = normalizeProposal(inventedReference, evidence);
assert.equal(rejectedReference.extraction, null);
assert.equal(rejectedReference.invalidReferenceCount, 1);

const unsupportedAmount = structuredClone(valid);
unsupportedAmount.total.value = '999.98';
const rejectedAmount = normalizeProposal(unsupportedAmount, evidence);
assert.equal(rejectedAmount.extraction, null);
assert.ok(rejectedAmount.unsupportedAmountCount > 0);

console.log('Hybrid benchmark validation utility: 3 scenarios passed.');

function collectValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectValues);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, 'value')) return object.value === null ? [] : [String(object.value)];
    return Object.values(object).flatMap(collectValues);
  }
  return [];
}

function modelProposal(source: any): any {
  const modelField = (field: any) => ({ value: field.value, confidence: field.confidence, uncertainty: field.uncertainty, sourceLineIds: field.value === null ? [] : [0] });
  const keys = ['documentType', 'merchant', 'date', 'time', 'currency', 'subtotal', 'taxTotal', 'discountTotal', 'depositTotal', 'total', 'reportedArticleCount'];
  const proposal: Record<string, unknown> = { schemaVersion: source.schemaVersion };
  for (const key of keys) proposal[key] = modelField(source[key]);
  proposal.entries = source.entries.map((entry: Record<string, unknown>) => Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, modelField(value)])));
  proposal.warnings = source.warnings;
  return proposal;
}
