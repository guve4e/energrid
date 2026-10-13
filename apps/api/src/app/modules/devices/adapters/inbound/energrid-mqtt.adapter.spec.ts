import { EnergridMqttAdapter } from './energrid-mqtt.adapter';

describe('typed native readings topic boundary', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, HOME_MQTT_TOPIC_PREFIX: 'energrid/home/site' };
  });
  afterEach(() => {
    process.env = original;
  });
  const message = (topic: string, deviceId: string) => ({
    topic,
    payload: { deviceId, readings: [] },
    payloadText: '{}',
  });
  it('routes matching device identity on the configured site bus', () => {
    expect(
      new EnergridMqttAdapter().handle(
        message('energrid/home/site/devices/meter/telemetry', 'meter'),
      )?.effects,
    ).toHaveLength(1);
  });
  it.each([
    'energrid/home/site/devices/other/telemetry',
    'energrid/home/site/debug/telemetry',
    'energrid/home/site/devices/meter/extra/telemetry',
  ])('does not forward typed readings from mismatched topic %s', (topic) => {
    expect(
      new EnergridMqttAdapter().handle(message(topic, 'meter'))?.effects,
    ).toEqual([]);
  });
  it('ignores other sites', () => {
    expect(
      new EnergridMqttAdapter().handle(
        message('energrid/home/other/devices/meter/telemetry', 'meter'),
      ),
    ).toBeNull();
  });
});
