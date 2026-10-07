import { residentialEducation,RESIDENTIAL_EDUCATION } from './residential-education';
test('template education overrides text without altering calculation defaults',()=>{
 expect(residentialEducation({education:{panelScope:'Configured panel scope'}}).panelScope).toBe('Configured panel scope');
 expect(residentialEducation({education:{protection:17}}).protection).toBe(RESIDENTIAL_EDUCATION.protection);
 expect(residentialEducation({}).futureEquipment).toContain('не включва');
});
