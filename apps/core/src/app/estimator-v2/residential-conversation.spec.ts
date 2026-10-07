import { estimateResidential } from './residential-estimate';
import { mergeEstimateDraft } from './estimate-draft.utils';
import { validateEstimateDraft } from './validate-estimate-draft';
import { EstimatorV2Service } from './estimator-v2.service';

test('explanation output cannot add devices or switch an existing job', async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  try {
    const service = new EstimatorV2Service({getActiveCatalog: async () => catalog} as any, {extractEstimateUpdate: async () => ({userIntent: 'explanation', jobType: 'panel', scopeSwitch: true, updates: {smartRelayCount: 1}})} as any, {} as any, {} as any, {} as any, {} as any);
    const result = await service.step({tenantSlug: 'energrid', message: 'Обяснете тази допълнителна възможност', draft: initial});
    expect(result.draft.jobType).toBe('residential_installation');
    expect(result.draft.smartRelayCount).toBeUndefined();
    expect(result.rangePreview).toMatchObject({min: 780, max: 1590});
  } finally { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
});

const catalog = Object.entries({ power_point_up_to_3m: 20, power_line_extra_meter_after_3m: 10, socket_or_switch_concealed: 10, panel_modern: 50, smart_relay_single: 25 }).map(([code, base_price]) => ({ code, base_price, unit: 'бр.', labor_included: true, materials_included: false }));
const initial = { tenantSlug: 'energrid', jobType: 'residential_installation' as const, roomCount: 3, areaSqm: 110 };

test('basic price is available from room count; no inspection or technical quiz is required', () => {
  const result = estimateResidential({ ...initial, areaSqm: undefined }, catalog);
  expect(result.status).toBe('preview');
  expect(result.rangePreview).toMatchObject({ min: 780, max: 1590 });
  expect(result.reply).toContain('само за труд');
  expect(result.reply).toContain('допускания');
  expect(result.reply.length).toBeLessThan(1000);
  expect(result.reply.match(/\?/g)).toHaveLength(1);
});
test('correction, approximate-price follow-up and breakdown preserve the same four ACs and totals', () => {
  let draft = mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft: initial, update: { updates: { acCount: 4, hasAc: true } }, rawMessage: 'Da, 4 klimatika' });
  const corrected = estimateResidential(draft, catalog);
  expect(corrected.rangePreview).toMatchObject({ min: 800, max: 1640 });
  draft = mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft: validateEstimateDraft(draft, 'energrid'), update: { updates: {} }, rawMessage: 'GOre doulu÷' });
  const detail = estimateResidential(draft, catalog, 'pokaji razbivkata');
  expect(detail.rangePreview).toEqual(corrected.rangePreview);
  expect(detail.reply).toContain('климатици × 4');
  expect(detail.reply).toContain('800.00–1640.00');
  expect(draft.acCount).toBe(4);
});
test('why questions get an explanation and no new price', () => {
  const result = estimateResidential({ ...initial, currentIntent: 'explain' }, catalog);
  expect(result.reply.startsWith('Уредите определят')).toBe(true);
  expect(result.rangePreview).toEqual(estimateResidential(initial, catalog).rangePreview);
});
test('explicit counts replace defaults; optional controls only add their catalog labour', () => {
  const basic = estimateResidential(initial, catalog).rangePreview!;
  const smart = estimateResidential({ ...initial, smartRelayCount: 2 }, catalog).rangePreview!;
  expect(smart.min - basic.min).toBe(50);
  expect(smart.max - basic.max).toBe(50);
  expect(estimateResidential({ ...initial, socketCount: 0 }, catalog).rangePreview!.lines[0].quantity).toBe(13);
});
test('missing rates cannot become a zero or fabricated price', () => {
  expect(() => estimateResidential(initial, [])).toThrow();
  expect(() => estimateResidential(initial, catalog.map(r => ({ ...r, materials_included: true })))).toThrow();
});
test('follow-up acknowledgements do not repeat the full estimate', () => {
  const corrected = { ...initial, acCount: 4, hasAc: true };
  const reply = estimateResidential(corrected, catalog, 'Da, 4 klimatika', initial).reply;
  expect(reply).toContain('Добре, смятам 4 климатика');
  expect(reply.length).toBeLessThan(400);
  const rough = estimateResidential(corrected, catalog, 'GOre doulu÷', corrected).reply;
  expect(rough).toContain('Да — приблизително 800.00–1640.00');
  expect(rough).not.toContain('Искате ли');
});
