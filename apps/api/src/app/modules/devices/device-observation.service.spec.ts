import { DeviceObservationService } from './device-observation.service';

describe('DeviceObservationService', () => {

  it('creates memory when a device is observed for the first time', () => {
    const service = new DeviceObservationService();

    service.observe({
      deviceId: 'shelly-kitchen-wall',
      observedAt: '2026-08-07T12:00:00.000Z',
      source: 'shelly-mqtt',
      values: {
        on: true,
      },
    });

    expect(service.getDevice('shelly-kitchen-wall')).toEqual({
      deviceId: 'shelly-kitchen-wall',
      firstSeen: '2026-08-07T12:00:00.000Z',
      lastSeen: '2026-08-07T12:00:00.000Z',
      observations: 1,
      lastValues: {
        on: true,
      },
      source: 'shelly-mqtt',
    });
  });


  it('updates heartbeat when the same device reports again', () => {
    const service = new DeviceObservationService();

    service.observe({
      deviceId: 'shelly-kitchen-wall',
      observedAt: '2026-08-07T12:00:00.000Z',
      source: 'shelly-mqtt',
      values: {
        on: false,
      },
    });

    service.observe({
      deviceId: 'shelly-kitchen-wall',
      observedAt: '2026-08-07T12:05:00.000Z',
      source: 'shelly-mqtt',
      values: {
        on: true,
      },
    });


    expect(service.getDevice('shelly-kitchen-wall')).toEqual({
      deviceId: 'shelly-kitchen-wall',
      firstSeen: '2026-08-07T12:00:00.000Z',
      lastSeen: '2026-08-07T12:05:00.000Z',
      observations: 2,
      lastValues: {
        on: true,
      },
      source: 'shelly-mqtt',
    });
  });


  it('keeps device memories isolated', () => {
    const service = new DeviceObservationService();


    service.observe({
      deviceId: 'pump',
      observedAt: '2026-08-07T12:00:00.000Z',
      source: 'mqtt',
      values: {
        power: 100,
      },
    });


    service.observe({
      deviceId: 'temperature',
      observedAt: '2026-08-07T12:01:00.000Z',
      source: 'mqtt',
      values: {
        temperature: 22,
      },
    });


    expect(service.getAll()).toHaveLength(2);

    expect(service.getDevice('pump')?.lastValues)
      .toEqual({
        power:100,
      });

    expect(service.getDevice('temperature')?.lastValues)
      .toEqual({
        temperature:22,
      });
  });

});
