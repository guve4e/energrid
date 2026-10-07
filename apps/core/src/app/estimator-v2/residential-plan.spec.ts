import { residentialPlan } from './residential-plan';
import { mergeEstimateDraft } from './estimate-draft.utils';
import type { EstimateConversationDraft } from './estimate-draft.types';

const studio: EstimateConversationDraft = { tenantSlug: 'energrid', jobType: 'residential_installation', propertyType: 'studio', areaSqm: 30, buildingStage: 'new', hasBoiler: true, hasAc: true };
test('30m² studio with boiler and AC receives an explicitly provisional circuit plan', () => {
  const result = residentialPlan(studio);
  expect(result.status).toBe('proposal');
  expect(result.plan?.circuits.map(c => c.id)).toEqual(['lighting', 'living-sockets', 'kitchen-sockets', 'cooker', 'washer', 'boiler', 'ac']);
  expect(result.plan?.circuits.filter(c => c.basis === 'customer-confirmed-appliance')).toHaveLength(2);
  expect(result.plan?.assumptions.join(' ')).toContain('не завършен електрически проект');
  expect(result.reply).toContain('Предвиждате ли и печка и пералня?');
  expect(result.reply).not.toContain('Приемам плана');
  expect(result.reply.length).toBeLessThan(600);
  expect(result).not.toHaveProperty('preview');
});
test('does not assume boiler or AC; respects explicit absence', () => {
  expect(residentialPlan({ ...studio, hasBoiler: undefined }).draft.currentQuestionField).toBe('hasBoiler');
  const plan = residentialPlan({ ...studio, hasBoiler: false, hasAc: false }).plan!;
  expect(plan.circuits).toHaveLength(5);
  expect(plan.assumptions.join(' ')).not.toContain('RCBO');
});
test('larger homes are not silently assigned a studio layout', () => {
  expect(residentialPlan({ ...studio, areaSqm: 90, propertyType: 'house' }).status).toBe('needs_inspection');
});
test('the customer can remove a suggested cooker or washing machine', () => {
  expect(residentialPlan({ ...studio, hasCooker: false, hasWashingMachine: false }).plan?.circuits).toHaveLength(5);
});
test('changing a residential fact requires confirming the new plan', () => {
  const draft = mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft: { ...studio, planAccepted: true }, update: { updates: { hasAc: false } } });
  expect(draft.planAccepted).toBe(false);
});
test('acknowledges new appliance facts before asking the remaining question', () => {
  const result = residentialPlan({ ...studio, areaSqm: undefined }, { tenantSlug: 'energrid', jobType: 'residential_installation' });
  expect(result.reply).toBe('Добре, включвам и бойлера и климатика. Колко квадратни метра е жилището?');
});
test('110m² scope limitation is disclosed before asking about appliances', () => {
  const result = residentialPlan({ tenantSlug: 'energrid', propertyType: 'apartment', areaSqm: 110 });
  expect(result.status).toBe('needs_inspection');
  expect(result.reply).not.toContain('Предвиждате ли');
});
test('answers why appliances were requested instead of repeating scope fallback', () => {
  const result = residentialPlan({ ...studio, propertyType: 'apartment', areaSqm: 110, acCount: 4, currentIntent: 'explain' });
  expect(result.reply).toContain('Питам за бойлера');
  expect(result.reply).toContain('4 климатика');
  expect(result.status).toBe('needs_input');
});
test('AC count survives subsequent turns and clears when AC is removed', () => {
  const draft = mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft: studio, update: { updates: { acCount: 4 } } });
  expect(mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft: draft, update: { updates: {} } }).acCount).toBe(4);
  expect(mergeEstimateDraft({ tenantSlug: 'energrid', currentDraft: draft, update: { updates: { hasAc: false } } }).acCount).toBeUndefined();
});
