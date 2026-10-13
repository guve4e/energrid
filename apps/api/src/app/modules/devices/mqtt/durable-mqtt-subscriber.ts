import { Logger } from '@nestjs/common';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';

export function durableMqttOptions(env: NodeJS.ProcessEnv): IClientOptions {
  const clientId = env.HOME_MQTT_CLIENT_ID?.trim();
  if (!clientId || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(clientId))
    throw new Error(
      'A stable, unique HOME_MQTT_CLIENT_ID is required for durable telemetry',
    );
  const port = Number(env.HOME_MQTT_PORT || 1883);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid HOME_MQTT_PORT');
  return {
    host: env.HOME_MQTT_HOST || '127.0.0.1',
    port,
    protocol: env.HOME_MQTT_TLS === 'true' ? 'mqtts' : 'mqtt',
    username: env.HOME_MQTT_USERNAME,
    password: env.HOME_MQTT_PASSWORD,
    clientId,
    clean: false,
    protocolVersion: 4,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    resubscribe: false,
    manualConnect: true,
  };
}

/** QoS 1 PUBACK is released by handleMessage only after local durable admission. */
export class DurableMqttSubscriber {
  private readonly logger = new Logger(DurableMqttSubscriber.name);
  private client?: MqttClient;
  private retry?: NodeJS.Timeout;
  private closing = false;
  private subscribed = false;
  private qosZeroMessages = 0;
  private generation = 0;

  constructor(
    private readonly options: IClientOptions,
    private readonly topics: string[],
    private readonly receive: (topic: string, payload: string) => Promise<void>,
  ) {}

  status() {
    return {
      connected: Boolean(this.client?.connected && this.subscribed),
      qosZeroMessages: this.qosZeroMessages,
    };
  }

  start() {
    const client = (this.client = connect(this.options));
    client.handleMessage = (packet, done) => {
      const generation = this.generation;
      if (packet.qos === 0) this.qosZeroMessages++;
      void Promise.resolve()
        .then(() => {
          if (this.closing) throw new Error('Subscriber closing');
          return this.receive(packet.topic, packet.payload.toString('utf8'));
        })
        .then(
          () => {
            // Never send an old packet's PUBACK through a replacement connection.
            if (generation !== this.generation)
              done(new Error('MQTT connection changed during admission'));
            else done();
          },
          () => {
            // Close without PUBACK. The persistent broker session can redeliver QoS 1.
            if (generation === this.generation) this.pause();
            done(new Error('MQTT reading not durably accepted'));
          },
        );
    };
    client.on('connect', () => {
      this.generation++;
      const generation = this.generation;
      client.subscribe(this.topics, { qos: 1 }, (error, granted) => {
        if (this.closing || generation !== this.generation) return;
        if (
          error ||
          granted?.length !== this.topics.length ||
          granted.some((g) => g.qos !== 1)
        ) {
          this.logger.error(
            'Durable MQTT subscriptions require QoS 1; capture paused.',
          );
          this.pause();
          return;
        }
        this.subscribed = true;
      });
    });
    client.on('close', () => {
      this.subscribed = false;
      this.generation++;
    });
    client.on('error', () =>
      this.logger.warn(
        'MQTT connection or delivery failed; check broker and telemetry buffer.',
      ),
    );
    client.connect();
  }

  private pause() {
    this.subscribed = false;
    this.logger.error(
      'MQTT capture paused without acknowledging the reading; retrying after storage recovers.',
    );
    this.client!.end(true, {}, () => {
      if (this.closing || this.retry) return;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        if (!this.closing) this.client!.reconnect();
      }, 5000);
      this.retry.unref();
    });
  }

  async stop() {
    this.closing = true;
    this.subscribed = false;
    if (this.retry) clearTimeout(this.retry);
    await new Promise<void>((resolve) => {
      if (this.client) this.client.end(true, {}, () => resolve());
      else resolve();
    });
  }
}
