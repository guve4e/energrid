import { estimateResidential } from './residential-estimate';
import { answerResidentialFollowup } from './residential-followup';
import { RESIDENTIAL_TEMPLATE } from './residential-template';
import { ResidentialTemplateRepository, validateResidentialTemplate } from './residential-template.repository';
import { validateEstimateDraft } from './validate-estimate-draft';
const catalog = Object.entries({power_point_up_to_3m:20,power_line_extra_meter_after_3m:10,socket_or_switch_concealed:10,panel_modern:50,panel_full_protection:80}).map(([code,base_price])=>({code,base_price,unit:'бр.',labor_included:true,materials_included:false}));
const studio = {tenantSlug:'energrid',jobType:'residential_installation' as const,propertyType:'studio' as const,roomCount:1,corridorCount:1,bathroomCount:1,separateKitchen:true,terraceCount:1};
test('listed studio layout has five lighting points after draft round trip',()=>{
  const saved=validateEstimateDraft(studio,'energrid')!;
  const result=estimateResidential(saved,catalog);
  expect(result.reply).toContain('5 осветителни извода');
  expect(result.reply).toContain('1 стая');
  expect(result.circuitProposal!.circuits.filter(c=>c.id.startsWith('lighting-'))).toHaveLength(5);
  expect(result.rangePreview).toMatchObject({min:560,max:1130});
});
test('database rules and catalog changes alter estimate and explanation without code changes',async()=>{
  const query=jest.fn().mockResolvedValue({rows:[{version:'bg-basic-v2',config:{...RESIDENTIAL_TEMPLATE,socketsPerRoom:4,routeMax:7,defaultPanelCode:'panel_full_protection'}}]});
  const rules=await new ResidentialTemplateRepository({query} as any).get();
  const result=estimateResidential(studio,catalog,'',undefined,rules);
  expect(result.draft.templateVersion).toBe('bg-basic-v2');
  expect(result.reply).toContain('9 контактни точки');
  expect(result.rangePreview!.lines.find(l=>l.code==='panel_full_protection')?.min).toBe(80);
  const reply=answerResidentialFollowup('panel',studio,catalog,rules).reply;
  expect(reply).toContain('80.00 EUR');
  expect(reply).toContain('защита от пренапрежение');
  expect(reply).not.toMatch(/MCB|RCD|SPD|Shelly/);
});
test('bad config cannot silently quote a price',()=>{
  expect(()=>validateResidentialTemplate('v2',{...RESIDENTIAL_TEMPLATE,routeMax:2})).toThrow();
  expect(()=>validateResidentialTemplate('v2',{...RESIDENTIAL_TEMPLATE,socketsPerRoom:-1})).toThrow();
});
