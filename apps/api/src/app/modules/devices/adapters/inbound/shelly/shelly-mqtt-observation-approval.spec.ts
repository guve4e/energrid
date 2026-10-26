import { shellyMqttObservationApproval } from './shelly-mqtt-observation-approval';

describe('Shelly MQTT observation approval contract', () => {
  it('binds one enrolled component to its physical device event topic and power only', () => {
    const authority = shellyMqttObservationApproval('shellypro2pm-aabbccddeeff:switch:1');
    expect(authority).toEqual({
      bindings: [{
        deviceId: 'shellypro2pm-aabbccddeeff:switch:1',
        sourceId: 'shelly-mqtt',
        selector: 'shellypro2pm-aabbccddeeff/events/rpc',
        fields: { power: { rawKey: 'power', type: 'number' } },
      }],
      policy: { deviceId: 'shellypro2pm-aabbccddeeff:switch:1', allowedSourcesByField: { power: ['shelly-mqtt'] } },
    });
  });

  it.each(['shellyplus1-aabbccddeeff:switch:32', 'shellyplus1-aabbccddeeff:temperature:0', 'not-a-device:switch:0'])
    ('rejects unsupported or malformed Shelly component IDs: %s', value => {
      expect(() => shellyMqttObservationApproval(value)).toThrow('Expected a Shelly physical component identity');
    });
});
