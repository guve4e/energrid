import { DeviceInvestigationService } from './device-investigation.service';
import type { RegisteredDevice } from './device-registry.types';

describe('DeviceInvestigationService', () => {
  it('treats an approved physical channel as registered hardware without creating guessed switches', () => {
    const service = new DeviceInvestigationService();
    const registeredDevices = [{id:'shelly-meter:em1:0',trustStatus:'approved',metadata:{physicalId:'shelly-meter'}}] as RegisteredDevice[];
    const input = {networkDevices:[{
      id:'shelly-meter',vendor:'Shelly',ipAddress:'192.168.7.21',networkZoneId:'lan',networkZoneName:'LAN',
      protocol:'http' as const,confidence:0.9,status:'online' as const,discoveredAt:'now',reason:'Shelly',
    }],registeredDevices,memory:[],health:[]};
    expect(service.analyze(input)).toEqual([]);
    expect(service.analyze(input)).toEqual([]);
    expect(registeredDevices).toHaveLength(1);
    expect(registeredDevices[0].id).toBe('shelly-meter:em1:0');
  });

  it('detects discovered network device missing from registry', () => {

    const service = new DeviceInvestigationService();

    const result = service.analyze({
      networkDevices:[
        {
          id:'shelly-test',
          ipAddress:'192.168.1.20',
          networkZoneId:'lan',
          networkZoneName:'LAN',
          protocol:'http',
          confidence:0.9,
          status:'online',
          discoveredAt:new Date().toISOString(),
          reason:'Shelly',
        }
      ],
      registeredDevices:[],
      memory:[],
      health:[],
    });


    expect(result[0].category)
      .toBe('discovered_not_registered');

  });

});
