import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { connect, type MqttClient, type IPublishPacket } from 'mqtt';
import {
  DurableMqttSubscriber,
  durableMqttOptions,
} from './durable-mqtt-subscriber';

jest.mock('mqtt', () => ({ connect: jest.fn() }));
const options = durableMqttOptions({ HOME_MQTT_CLIENT_ID: 'unit-test-only' });
const setup = () => {
  const client = Object.assign(new EventEmitter(), {
    connected: false,
    subscribe: jest.fn(),
    connect: jest.fn(),
    reconnect: jest.fn(),
    handleMessage: jest.fn() as unknown as MqttClient['handleMessage'],
    end: jest.fn((_force, _options, callback) => callback()),
  });
  (connect as jest.Mock).mockReturnValue(client);
  const receive = jest
    .fn<Promise<void>, [string, string]>()
    .mockResolvedValue(undefined);
  const subscriber = new DurableMqttSubscriber(
    options,
    ['unit/telemetry'],
    receive,
  );
  const deliver = (qos: 0 | 1 = 1) => {
    const done = jest.fn();
    client.handleMessage(
      {
        topic: 'unit/telemetry',
        payload: Buffer.from('{\n"value":1\n}'),
        qos,
      } as IPublishPacket,
      done,
    );
    return done;
  };
  return { client, receive, subscriber, deliver };
};
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('MQTT durable admission transport', () => {
  it('uses a persistent named session, subscribes at QoS 1 and exposes connection health', async () => {
    const { subscriber, client } = setup();
    subscriber.start();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        clean: false,
        protocolVersion: 4,
        clientId: 'unit-test-only',
        manualConnect: true,
      }),
    );
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(subscriber.status().connected).toBe(false);
    client.connected = true;
    client.emit('connect');
    expect(client.subscribe.mock.calls[0].slice(0, 2)).toEqual([
      ['unit/telemetry'],
      { qos: 1 },
    ]);
    client.subscribe.mock.calls[0][2](null, [
      { topic: 'unit/telemetry', qos: 1 },
    ]);
    expect(subscriber.status().connected).toBe(true);
    client.emit('close');
    expect(subscriber.status().connected).toBe(false);
    await subscriber.stop();
  });
  it('withholds the QoS 1 acknowledgment until buffering has resolved', async () => {
    const { subscriber, receive, deliver } = setup();
    let commit!: () => void;
    receive.mockReturnValue(
      new Promise((resolve) => {
        commit = resolve;
      }),
    );
    subscriber.start();
    const done = deliver();
    await settle();
    expect(receive).toHaveBeenCalledWith('unit/telemetry', '{\n"value":1\n}');
    expect(done).not.toHaveBeenCalled();
    commit();
    await settle();
    expect(done).toHaveBeenCalledWith();
    await subscriber.stop();
  });
  it('closes without PUBACK on buffering failure, then reconnects for broker redelivery', async () => {
    const { subscriber, receive, client, deliver } = setup();
    receive.mockRejectedValue(new Error('private-path secret'));
    subscriber.start();
    const done = deliver();
    await settle();
    expect(done).toHaveBeenCalledWith(expect.any(Error));
    expect(client.end).toHaveBeenCalledWith(true, {}, expect.any(Function));
    expect(subscriber.status().connected).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify((Logger.prototype.error as jest.Mock).mock.calls),
    ).not.toContain('secret');
    await subscriber.stop();
  });
  it('counts QoS 0 messages without pretending they can be redelivered', async () => {
    const { subscriber, deliver } = setup();
    subscriber.start();
    const done = deliver(0);
    await settle();
    expect(done).toHaveBeenCalledWith();
    expect(subscriber.status().qosZeroMessages).toBe(1);
    await subscriber.stop();
  });
  it.each([true, false])(
    'never acknowledges an old delivery on a new connection (success=%s)',
    async (success) => {
      const { subscriber, receive, client, deliver } = setup();
      let finish!: () => void;
      receive.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          finish = () =>
            success ? resolve() : reject(new Error('buffer failed'));
        }),
      );
      subscriber.start();
      const done = deliver();
      await settle();
      client.emit('close');
      client.emit('connect');
      finish();
      await settle();
      expect(done).toHaveBeenCalledWith(expect.any(Error));
      expect(client.end).not.toHaveBeenCalled();
      await subscriber.stop();
    },
  );
  it.each([
    [new Error('denied'), undefined],
    [null, []],
    [null, undefined],
    [null, [{ topic: 'unit/telemetry', qos: 0 }]],
    [null, [{ topic: 'unit/telemetry', qos: 128 }]],
  ])(
    'does not claim readiness for failed/downgraded subscriptions',
    async (error, granted) => {
      const { subscriber, client } = setup();
      subscriber.start();
      client.emit('connect');
      client.subscribe.mock.calls[0][2](error, granted);
      expect(subscriber.status().connected).toBe(false);
      expect(client.end).toHaveBeenCalled();
      await subscriber.stop();
      await jest.advanceTimersByTimeAsync(5000);
      expect(client.reconnect).not.toHaveBeenCalled();
    },
  );

  it('ignores stale subscription callbacks from an old connection or after shutdown', async () => {
    const { subscriber, client } = setup();
    subscriber.start();
    client.connected = true;
    client.emit('connect');
    const old = client.subscribe.mock.calls[0][2];
    client.emit('close');
    client.emit('connect');
    old(null, [{ topic: 'unit/telemetry', qos: 1 }]);
    expect(subscriber.status().connected).toBe(false);
    old(new Error('old failure'), undefined);
    expect(client.end).not.toHaveBeenCalled();
    await subscriber.stop();
    client.subscribe.mock.calls[1][2](null, [
      { topic: 'unit/telemetry', qos: 1 },
    ]);
    expect(subscriber.status().connected).toBe(false);
  });
  it('stops timers and rejects late deliveries during shutdown', async () => {
    const { subscriber, receive, client, deliver } = setup();
    subscriber.start();
    await subscriber.stop();
    const done = deliver();
    await settle();
    expect(receive).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(expect.any(Error));
    await jest.advanceTimersByTimeAsync(5000);
    expect(client.reconnect).not.toHaveBeenCalled();
  });
  it('can stop before starting and logs connection errors without broker credentials', async () => {
    const { subscriber, client } = setup();
    await subscriber.stop();
    const next = setup();
    next.subscriber.start();
    next.client.emit('error', new Error('password=secret'));
    expect(
      JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls),
    ).not.toContain('secret');
    await next.subscriber.stop();
    expect(client.end).not.toHaveBeenCalled();
  });
});

describe('durable MQTT configuration', () => {
  it.each([undefined, '', 'contains spaces', 'x'.repeat(121)])(
    'requires a stable unique client ID %s',
    (id) => {
      expect(() => durableMqttOptions({ HOME_MQTT_CLIENT_ID: id })).toThrow(
        'CLIENT_ID',
      );
    },
  );
  it.each(['0', '65536', 'bad', '1.2'])('rejects invalid ports %s', (port) => {
    expect(() =>
      durableMqttOptions({ HOME_MQTT_CLIENT_ID: 'unit', HOME_MQTT_PORT: port }),
    ).toThrow('PORT');
  });
  it('accepts private broker settings and verified TLS without disabling certificate checks', () => {
    expect(
      durableMqttOptions({
        HOME_MQTT_CLIENT_ID: 'unit',
        HOME_MQTT_HOST: 'broker',
        HOME_MQTT_PORT: '8883',
        HOME_MQTT_TLS: 'true',
        HOME_MQTT_USERNAME: 'u',
        HOME_MQTT_PASSWORD: 'p',
      }),
    ).toEqual(
      expect.objectContaining({
        host: 'broker',
        port: 8883,
        protocol: 'mqtts',
        username: 'u',
        password: 'p',
      }),
    );
  });
});
