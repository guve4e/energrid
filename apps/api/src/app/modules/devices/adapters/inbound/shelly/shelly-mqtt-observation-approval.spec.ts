import { configuredShellyMqttBroker, isSafeShellyMqttEventTopic, isShellyMqttObservationApproval, shellyMqttObservationApproval } from './shelly-mqtt-observation-approval';

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
      broker: configuredShellyMqttBroker(),
    });
  });

  it.each(['shellyplus1-aabbccddeeff:switch:32', 'shellyplus1-aabbccddeeff:temperature:0', 'not-a-device:switch:0'])
    ('rejects unsupported or malformed Shelly component IDs: %s', value => {
      expect(() => shellyMqttObservationApproval(value)).toThrow('Expected a Shelly physical component identity');
    });

  it('supports an exact operator-reviewed custom topic without treating it as identity proof', () => {
    const authority = shellyMqttObservationApproval(
      'shellypro2pm-ec6260888084:switch:1', ['power', 'energy_import_total'], 'shelly/washer@other/events/rpc',
    );
    expect(authority.bindings[0].selector).toBe('shelly/washer@other/events/rpc');
    expect(isSafeShellyMqttEventTopic('shelly/washer@other/events/rpc')).toBe(true);
    expect(isSafeShellyMqttEventTopic('shelly/+/events/rpc')).toBe(false);
    expect(isSafeShellyMqttEventTopic('shelly/#/events/rpc')).toBe(false);
    expect(isSafeShellyMqttEventTopic('shelly//events/rpc')).toBe(false);
  });

  it('requires a persisted exact broker endpoint as part of the approved source binding', () => {
    const deviceId = 'shellypro2pm-ec6260888084:switch:0';
    const authority = shellyMqttObservationApproval(deviceId, ['power'], 'shelly/washer@other/events/rpc');
    expect(authority.broker).toBe(configuredShellyMqttBroker());
    expect(isShellyMqttObservationApproval(authority, deviceId)).toBe(true);
    expect(isShellyMqttObservationApproval({ ...authority, broker: 'different-broker.example:1883' }, deviceId)).toBe(false);
    expect(isShellyMqttObservationApproval({ ...authority, broker: undefined }, deviceId)).toBe(false);
  });
});
