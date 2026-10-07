import { computeMissingFields, mergeEstimateDraft } from './estimate-draft.utils';
import { estimateAppliance } from './appliance-estimate';
import { EstimateQuestionService } from './estimate-question.service';
import { mapDraftToEstimateRequest } from './estimate-mapper';
import { EstimateIntakeService } from './estimate-intake.service';
import { EstimatorV2Service } from './estimator-v2.service';
import { BoilerStrategy } from './strategies/boiler.strategy';
import { StoveStrategy } from './strategies/stove.strategy';
import { EstimateExplanationService } from './estimate-explanation.service';
import { validateEstimateDraft } from './validate-estimate-draft';
import { EstimatorController } from '../estimator/estimator.controller';

const prices: Record<string, number> = {
  stove_existing_cable_min: 60, stove_existing_cable_max: 90,
  stove_new_line_base_min: 80, stove_new_line_base_max: 120,
  stove_new_line_extra_meter_min: 10, stove_new_line_extra_meter_max: 15,
  boiler_replacement_existing_cable_min: 80, boiler_replacement_existing_cable_max: 120,
  boiler_new_line_base_min: 120, boiler_new_line_base_max: 160,
  boiler_new_line_extra_meter_min: 10, boiler_new_line_extra_meter_max: 15,
  chasing_brick_per_meter: 10, chasing_concrete_per_meter: 10,
};
const catalog = { getManyByCodes: jest.fn(async (codes: string[]) => Object.fromEntries(codes.map(code => {
  if (!(code in prices)) throw new Error('Missing catalog row');
  return [code, { code, base_price: prices[code], unit: code.includes('meter') ? 'м' : 'бр.' }];
}))) } as any;
const questions = new EstimateQuestionService();

describe('catalog-grounded estimates', () => {
  it('rejects malformed drafts and strips client-supplied prices', () => {
    expect(() => validateEstimateDraft({ quantity: -2 }, 'energrid')).toThrow('Invalid quantity');
    expect(() => validateEstimateDraft({ jobType: 'invented' }, 'energrid')).toThrow('Invalid jobType');
    expect(validateEstimateDraft({ tenantSlug: 'other', quantity: 2, subtotal: 1 }, 'energrid')).toEqual({ tenantSlug: 'energrid', quantity: 2 });
  });
  it('rejects empty public requests and fixes the public tenant', async () => {
    const step = jest.fn().mockResolvedValue({ status: 'needs_input' });
    const controller = new EstimatorController({} as any, { step } as any, {} as any, {} as any);
    await expect(controller.assistantStepV2({ message: ' ' })).rejects.toThrow('Message must');
    await controller.assistantStepV2({ message: ' 2 печки ' });
    expect(step).toHaveBeenCalledWith({ tenantSlug: 'energrid', message: '2 печки', draft: undefined });
  });
  it('requires point lengths, counts and wall details, not a guessed price', () => {
    expect(computeMissingFields({ tenantSlug: 'energrid', jobType: 'points' })).toEqual(['quantity', 'routeLengthMeters', 'wallType']);
    expect(computeMissingFields({ tenantSlug: 'energrid', jobType: 'panel', quantity: 1 })).toEqual(['panelKind']);
  });
  it('clears unrelated quantities and routes when switching jobs', () => {
    const next = mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft: { tenantSlug: 'energrid', jobType: 'points', quantity: 20, routeLengthMeters: 8, wallType: 'brick' }, update: { jobType: 'stove_installation', updates: {} } });
    expect(next.quantity).toBeUndefined();
    expect(next.routeLengthMeters).toBeUndefined();
  });
  it('preserves decimal metres and does not read numbers out of uncertain prose', () => {
    const currentDraft = { tenantSlug: 'energrid', jobType: 'points' as const, currentQuestionField: 'routeLengthMeters' as const };
    expect(mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft, update: { updates: {} }, rawMessage: '4,5 метра' }).routeLengthMeters).toBe(4.5);
    expect(mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft, update: { updates: {} }, rawMessage: 'не знам, може би 4' }).routeLengthMeters).toBeUndefined();
  });
  it('changing connection mode replaces conflicting old power source', () => {
    const next = mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft: { tenantSlug: 'energrid', jobType: 'stove_installation', powerSource: 'existing_line' }, update: { updates: { connectionMode: 'new_line_required' } } });
    expect(next.powerSource).toBe('panel');
    expect(computeMissingFields(next)).toContain('routeLengthMeters');
  });
  it('scales base and additional metres for two appliances', async () => {
    const result = await estimateAppliance({ tenantSlug: 'energrid', jobType: 'stove_installation', quantity: 2, connectionMode: 'new_line_required', routeLengthMeters: 5, wallType: 'none' }, catalog);
    expect([result.min, result.max]).toEqual([200, 300]);
    expect(result.lines.map(l => l.quantity)).toEqual([2, 4]);
  });
  it('accounts for requested chasing with catalog prices', async () => {
    const result = await estimateAppliance({ tenantSlug: 'energrid', jobType: 'boiler_installation', quantity: 2, connectionMode: 'new_line_required', routeLengthMeters: 5, wallType: 'brick' }, catalog);
    expect([result.min, result.max]).toEqual([380, 480]);
    expect(result.lines.at(-1)?.quantity).toBe(10);
  });
  it('scales replacement range and refuses negative catalog prices', async () => {
    const draft = { tenantSlug: 'energrid', jobType: 'boiler_replacement' as const, quantity: 2, connectionMode: 'existing_cable_only' as const };
    expect((await estimateAppliance(draft, catalog)).min).toBe(160);
    await expect(estimateAppliance(draft, { getManyByCodes: async (codes: string[]) => Object.fromEntries(codes.map(code => [code, { base_price: -1 }])) } as any)).rejects.toThrow('Invalid estimate catalog range');
  });
  it('does not issue an appliance preview until connection details are complete', async () => {
    const result = await new StoveStrategy(questions, catalog).handle({ draft: { tenantSlug: 'energrid', jobType: 'stove_installation', quantity: 2 } });
    expect(result.status).toBe('needs_input');
    expect(result.rangePreview).toBeUndefined();
    expect(result.draft.currentQuestionField).toBe('connectionMode');
  });
  it('keeps the same appliance quote when explaining it', async () => {
    const saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-only';
    try {
      const intake = { extractEstimateUpdate: async () => ({ updates: {}, askExplanation: true }) } as any;
      const service = new EstimatorV2Service({ getActiveCatalog: async () => [] } as any, intake, questions, new EstimateExplanationService(), new BoilerStrategy(questions, catalog), new StoveStrategy(questions, catalog));
      const result = await service.step({ tenantSlug: 'energrid', message: 'Защо?', draft: { tenantSlug: 'energrid', jobType: 'stove_installation', quantity: 2, connectionMode: 'existing_cable_only' } });
      expect(result.rangePreview?.min).toBe(120);
      expect(result.preview).toBeUndefined();
      expect(result.reply).toContain('120.00–180.00');
    } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
  });
  it('maps the requested number of catalog panels', () => {
    expect(mapDraftToEstimateRequest({ tenantSlug: 'energrid', jobType: 'panel', panelKind: 'panel_modern', quantity: 3 }).panels).toEqual([{ kind: 'panel_modern', quantity: 3 }]);
  });
});

describe('LLM intake transport', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  beforeEach(() => { process.env.OPENAI_API_KEY = 'test-only'; });
  afterEach(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });
  it('uses one bounded structured extraction with storage disabled', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ jobType: 'points', updates: { quantity: 3 }, askExplanation: false, scopeSwitch: false }) }] }] }) });
    const result = await new EstimateIntakeService().extractEstimateUpdate({ message: '3 точки' });
    expect(result.updates.quantity).toBe(3);
    const options = (global.fetch as jest.Mock).mock.calls[0][1];
    const body = JSON.parse(options.body);
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.input).toContain('3 точки');
    expect(options.signal).toBeDefined();
  });
  it('keeps numeric follow-ups on their current job', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ output_text: JSON.stringify({ jobType: null, updates: { routeLengthMeters: 4.5 } }) }) });
    const result = await new EstimateIntakeService().extractEstimateUpdate({ message: '4,5 метра', draft: { tenantSlug: 'energrid', jobType: 'stove_installation' } });
    expect(result.jobType).toBe('stove_installation');
    expect(result.updates.routeLengthMeters).toBe(4.5);
  });
  it('reports refusals and upstream failures instead of reusing a quote', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ output: [{ content: [{ type: 'refusal' }] }] }) });
    await expect(new EstimateIntakeService().extractEstimateUpdate({ message: 'test' })).rejects.toThrow('temporarily unavailable');
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(new EstimateIntakeService().extractEstimateUpdate({ message: 'test' })).rejects.toThrow('temporarily unavailable');
  });
});
