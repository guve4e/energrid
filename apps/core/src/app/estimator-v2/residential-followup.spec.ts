import { residentialFollowup, answerResidentialFollowup } from './residential-followup';
import { estimateResidential } from './residential-estimate';
import { proposedCircuits } from './residential-template';
import { validateEstimateDraft } from './validate-estimate-draft';
const catalog = Object.entries({ power_point_up_to_3m:20, power_line_extra_meter_after_3m:10, socket_or_switch_concealed:10, panel_modern:50, smart_relay_single:25 }).map(([code,base_price]) => ({code,base_price,unit:'бр.',labor_included:true,materials_included:false}));
const draft = {tenantSlug:'energrid',jobType:'residential_installation' as const,roomCount:3};
test('replays point, panel, yes and price list without losing quote context',()=>{
  let result = estimateResidential(draft,catalog);
  const total = result.rangePreview;
  for(const [message,kind,expected] of [
    ['Moje da... kakvo ozna4ava to4ka','point','Монтажът на контакта'],
    ['Ami bu6onite? Tabloto?','panel','50.00 EUR'],
    ['Da','breakdown','Изводи:'],
    ['Imate li cenorazpis nqkude ?','catalog','20.00 EUR/точка'],
  ]) {
    const saved=validateEstimateDraft(result.draft,'energrid')!;
    expect(residentialFollowup(message,saved)).toBe(kind);
    result=answerResidentialFollowup(kind,saved,catalog);
    expect(result.reply).toContain(expected);
    expect(result.rangePreview).toEqual(total);
  }
  expect(result.draft.templateVersion).toBe('bg-basic-v1');
});
test('yes only accepts an actual pending offer; corrections are not explanation questions',()=>{
  expect(residentialFollowup('Da',draft)).toBeUndefined();
  expect(residentialFollowup('dobavi 2 kontakta',draft)).toBeUndefined();
  expect(residentialFollowup('смени таблото',draft)).toBeUndefined();
});
test('template assumptions are separate from facts and explicit absences win',()=>{
  const base=proposedCircuits(draft,3);
  expect(base.circuits.find(c=>c.id==='boiler-1')?.assumed).toBe(true);
  expect(base.circuits.some(c=>c.id==='kitchen-counter-1')).toBe(true);
  const changed=proposedCircuits({...draft,hasBoiler:false,hasOven:false,acCount:4,hasAc:true},3);
  expect(changed.circuits.some(c=>c.id==='boiler-1')).toBe(false);
  expect(changed.circuits.filter(c=>c.id.startsWith('ac-'))).toHaveLength(4);
  expect(draft).not.toHaveProperty('hasBoiler');
});
test('smart relay and leading yes chasing questions preserve all priced quantities',()=>{
  const current={...draft,hasDryer:true,acCount:2,hasAc:true,pendingOffer:'breakdown' as const};
  const original=estimateResidential(current,catalog);
  for(const [message,kind] of [['Umno rele, tova za kakvo e','smart_relay'],['Da... oba4e ne6to ne mi e qsno... trqbva li da se kurtqt stenite ?','chasing']]) {
    expect(residentialFollowup(message,current)).toBe(kind);
    const result=answerResidentialFollowup(kind,current,catalog);
    expect(result.rangePreview).toEqual(original.rangePreview);
    expect(result.draft.smartRelayCount).toBeUndefined();
    expect(result.draft.wallType).toBeUndefined();
    expect(result.reply).not.toContain('Ето разбивката');
  }
  expect(residentialFollowup('Da, dobavi 2 umni releta',current)).toBeUndefined();
  expect(residentialFollowup('Da, no imam drug vupros',current)).toBeUndefined();
});
