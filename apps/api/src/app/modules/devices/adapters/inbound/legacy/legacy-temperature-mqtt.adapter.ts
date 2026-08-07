import type {
  DeviceMqttAdapterResult,
  DeviceMqttMessage,
  DeviceMqttMessageAdapter,
} from '../../../mqtt/device-mqtt-message-adapter';

export interface LegacyTemperatureTopicConfig {
  topic: string;
  deviceId: string;
  zoneName: string;
  displayName: string;
}

export class LegacyTemperatureMqttAdapter implements DeviceMqttMessageAdapter {
  readonly id = 'legacy-temperature';

  subscriptions(): string[] {
    return legacyTemperatureTopicConfigs().map((config) => config.topic);
  }

  topicConfigs(): LegacyTemperatureTopicConfig[] {
    return legacyTemperatureTopicConfigs();
  }

  handle(message: DeviceMqttMessage): DeviceMqttAdapterResult | null {
    const config = legacyTemperatureTopicConfigs().find(
      (candidate) => candidate.topic === message.topic,
    );

    if (!config) return null;
    if (!message.payload || typeof message.payload !== 'object') return null;

    const raw = message.payload as Record<string, unknown>;
    const temperature = numericValue(raw.temperature ?? raw.value);
    const humidity = numericValue(raw.humidity);

    if (temperature == null) {
      return {
        reason: 'legacy temperature without numeric value',
        effects: [],
      };
    }

    const values: Record<string, number> = { temperature };
    if (humidity != null) values.humidity = humidity;

    const observedAt =
      stringValue(raw.timestamp) ||
      stringValue(raw.observedAt) ||
      new Date().toISOString();

    return {
      reason: 'legacy temperature',
      effects: [
        {
          kind: 'registry',
          payload: {
            tenantId: process.env.PORTAL_TENANT_ID,
            siteId: process.env.PORTAL_SITE_ID,
            siteName: process.env.PORTAL_SITE_NAME,
            gatewayId: process.env.HOME_GATEWAY_ID,
            devices: [
              {
                deviceId: config.deviceId,
                name: config.displayName,
                kind: 'physical',
                origin: 'mqtt',
                protocol: 'mqtt',
                transport: 'mqtt',
                driver: 'legacy-arduino-temperature',
                target: config.topic,
                location: config.zoneName,
                zoneName: config.zoneName,
                capabilities:
                  humidity == null
                    ? ['temperature']
                    : ['temperature', 'humidity'],
                values,
                observedAt,
                metadata: {
                  legacyTopic: config.topic,
                },
              },
            ],
            observedAt,
          },
        },
      ],
    };
  }
}

export function legacyTemperatureTopicConfigs(): LegacyTemperatureTopicConfig[] {
  const configured =
    process.env.HOME_MQTT_LEGACY_TEMPERATURE_TOPICS ||
    'sensors/arduino/temp|kitchen_temperature|Kitchen|Kitchen temperature,sensors/arduino/temp2|garage_temperature|Garage|Garage temperature';

  return configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [topic, deviceId, zoneName, displayName] = entry
        .split('|')
        .map((part) => part.trim());

      const fallbackId = topicPart(topic.split('/').filter(Boolean).join('_'));

      return {
        topic,
        deviceId: deviceId || fallbackId,
        zoneName: zoneName || 'Home',
        displayName: displayName || deviceId || fallbackId,
      };
    })
    .filter((config) => !!config.topic);
}

function numericValue(value: unknown): number | null {
  if (value && typeof value === 'object' && 'value' in value) {
    return numericValue((value as { value?: unknown }).value);
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function topicPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
