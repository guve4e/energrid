import { EstimatorV2Service } from './estimator-v2.service';
import { RESIDENTIAL_TEMPLATE } from './residential-template';

test('pilot uses the catalogue and configured template without model extraction',async()=>{
 const catalog=Object.entries({power_point_up_to_3m:20,power_line_extra_meter_after_3m:10,socket_or_switch_concealed:10,panel_modern:50,smart_relay_single:25}).map(([code,base_price])=>({code,base_price,unit:'бр.',labor_included:true,materials_included:false}));
 const extraction=jest.fn();
 const service=new EstimatorV2Service({getActiveCatalog:async()=>catalog} as any,{extractEstimateUpdate:extraction} as any,{} as any,{} as any,{} as any,{} as any,{get:async()=>RESIDENTIAL_TEMPLATE} as any);
 const result=await service.calculateResidential({propertyType:'studio',roomCount:1,separateKitchen:true,bathroomCount:1,corridorCount:1,terraceCount:1});
 expect(result.estimate).toMatchObject({min:560,max:1130});
 expect(extraction).not.toHaveBeenCalled();
 catalog.find(row=>row.code==='panel_modern')!.base_price=70;
 const revised=await service.calculateResidential({propertyType:'studio',roomCount:1,separateKitchen:true,bathroomCount:1,corridorCount:1,terraceCount:1});
 expect(revised.estimate!.min-result.estimate!.min).toBe(20);
 expect(revised.estimate!.max-result.estimate!.max).toBe(20);
});
