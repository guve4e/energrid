import type {
  DeviceMqttAdapterResult,
  DeviceMqttMessage,
  DeviceMqttMessageAdapter,
} from '../../mqtt/device-mqtt-message-adapter';

export class EnergridMqttAdapter implements DeviceMqttMessageAdapter {
  readonly id = 'energrid-native';

  subscriptions(prefix: string): string[] {
    return [`${prefix}/#`];
  }

  handle(message: DeviceMqttMessage): DeviceMqttAdapterResult | null {
    const prefix = mqttPrefix();

    if (message.topic !== prefix && !message.topic.startsWith(`${prefix}/`)) {
      return null;
    }

    if (message.topic.endsWith('/registry/devices')) {
      return {
        reason: 'registry devices',
        effects: [
          {
            kind: 'registry',
            payload: message.payload,
          },
        ],
      };
    }

    if (
      message.topic.endsWith('/telemetry') ||
      message.topic.endsWith('/state')
    ) {
      return {
        reason: 'device telemetry',
        effects: [
          {
            kind: 'telemetry',
            payload: message.payload,
          },
        ],
      };
    }

    if (message.topic.endsWith('/status')) {
      return {
        reason: 'device status',
        effects: [
          {
            kind: 'status',
            payload: message.payload,
          },
        ],
      };
    }

    return null;
  }
}

function mqttPrefix(): string {
  const configured = process.env.HOME_MQTT_TOPIC_PREFIX;
  if (configured) return configured.replace(/\/+$/g, '');

  const tenantId = topicPart(process.env.PORTAL_TENANT_ID || 'tenant-demo');
  const siteId = topicPart(
    process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home',
  );

  return `energrid/${tenantId}/${siteId}`;
}

function topicPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
