import { DeviceInvestigationService } from './device-investigation.service';

describe('DeviceInvestigationService', () => {

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
