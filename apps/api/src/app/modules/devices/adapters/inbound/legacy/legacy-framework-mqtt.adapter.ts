import type { DeviceCapabilityKind } from '../../../device-registry.types';
import type {
  DeviceMqttAdapterResult,
  DeviceMqttMessage,
  DeviceMqttMessageAdapter,
} from '../../../mqtt/device-mqtt-message-adapter';

type LegacyFrameworkTopicKind = 'status' | 'state' | 'telemetry' | 'online';

interface LegacyFrameworkTopic {
  deviceId: string;
  kind: LegacyFrameworkTopicKind;
}

export class LegacyFrameworkMqttAdapter implements DeviceMqttMessageAdapter {
  readonly id = 'legacy-framework';

  subscriptions(): string[] {
    return legacyDeviceTopicPatterns();
  }

  handle(message: DeviceMqttMessage): DeviceMqttAdapterResult | null {
    const parsedTopic = parseLegacyFrameworkTopic(message.topic);
    if (!parsedTopic) return null;

    if (parsedTopic.kind === 'online') {
      const status = legacyOnlineStatus(message.payload);
      if (!status) return null;

      return {
        reason: 'legacy framework device',
        effects: [
          {
            kind: 'status',
            payload: {
              deviceId: parsedTopic.deviceId,
              status,
              observedAt: new Date().toISOString(),
            },
          },
        ],
      };
    }

    if (!message.payload || typeof message.payload !== 'object') {
      return null;
    }

    const raw = message.payload as Record<string, unknown>;
    const deviceId = topicPart(
      stringValue(raw.deviceId) || parsedTopic.deviceId,
    );

    if (!deviceId) return null;

    const values = legacyReadingValues(raw);
    const capabilities = legacyDeviceCapabilities(deviceId, raw, values);
    const observedAt = legacyObservedAt(raw);

    if (Object.keys(values).length === 0) {
      const status = legacyOnlineStatus(raw.online ?? raw.status);

      return {
        reason: 'legacy framework device',
        effects: status
          ? [
              {
                kind: 'status',
                payload: {
                  deviceId,
                  status,
                  observedAt,
                },
              },
            ]
          : [],
      };
    }

    if (capabilities.length === 0) {
      return {
        reason: 'legacy framework device without known readings',
        effects: [],
      };
    }

    const zoneName = legacyZoneName(deviceId, raw);

    return {
      reason: 'legacy framework device',
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
                deviceId,
                name:
                  stringValue(raw.name) ||
                  stringValue(raw.displayName) ||
                  legacyDisplayName(deviceId),
                kind: 'physical',
                origin: 'legacy',
                protocol: 'mqtt',
                transport: 'mqtt',
                driver: 'legacy-framework-device',
                target: message.topic,
                location: zoneName,
                zoneName,
                capabilities,
                values,
                observedAt,
                status:
                  legacyOnlineStatus(raw.online ?? raw.status) || 'online',
                metadata: cleanLegacyMetadata({
                  legacyTopic: message.topic,
                  legacyType: stringValue(raw.type),
                  firmwareVersion: stringValue(raw.firmwareVersion),
                  app: stringValue(raw.app),
                }),
              },
            ],
            observedAt,
          },
        },
      ],
    };
  }
}

export function legacyDeviceTopicPatterns(): string[] {
  const configured = process.env.HOME_MQTT_LEGACY_DEVICE_TOPICS || 'devices/#';

  return configured
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function parseLegacyFrameworkTopic(topic: string): LegacyFrameworkTopic | null {
  const parts = topic.split('/').filter(Boolean);
  if (parts[0] !== 'devices' || parts.length < 3) return null;

  const kind = parts[parts.length - 1];

  if (!['status', 'state', 'telemetry', 'online'].includes(kind)) {
    return null;
  }

  const deviceId = topicPart(parts.slice(1, -1).join('_'));
  if (!deviceId) return null;

  return {
    deviceId,
    kind: kind as LegacyFrameworkTopicKind,
  };
}

function legacyReadingValues(
  raw: Record<string, unknown>,
): Record<string, number | boolean | string | null> {
  const values: Record<string, number | boolean | string | null> = {};

  const keys = [
    'temperature',
    'humidity',
    'power',
    'current',
    'voltage',
    'energy',
    'energy_delta',
    'motion',
    'on',
    'output',
  ];

  for (const key of keys) {
    const normalized = legacyPrimitiveValue(raw[key]);

    if (normalized !== undefined) {
      values[key === 'output' ? 'on' : key] = normalized;
    }
  }

  return values;
}

function legacyPrimitiveValue(
  value: unknown,
): number | boolean | string | null | undefined {
  if (value && typeof value === 'object' && 'value' in value) {
    return legacyPrimitiveValue((value as { value?: unknown }).value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'boolean') return value;
  if (value == null) return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : trimmed;
  }

  return undefined;
}

function legacyDeviceCapabilities(
  deviceId: string,
  raw: Record<string, unknown>,
  values: Record<string, unknown>,
): DeviceCapabilityKind[] {
  const capabilities = new Set<DeviceCapabilityKind>();

  const readings =
    raw.config && typeof raw.config === 'object'
      ? (
          raw.config as {
            readings?: Record<string, { enabled?: boolean }>;
          }
        ).readings || {}
      : {};

  for (const key of Object.keys(readings)) {
    if (readings[key]?.enabled === false) continue;

    if (key === 'temperature') capabilities.add('temperature');
    if (key === 'humidity') capabilities.add('humidity');

    if (
      ['power', 'current', 'voltage', 'energy', 'energy_delta'].includes(key)
    ) {
      capabilities.add('power');
    }
  }

  if ('temperature' in values) capabilities.add('temperature');
  if ('humidity' in values) capabilities.add('humidity');

  if (
    ['power', 'current', 'voltage', 'energy', 'energy_delta'].some(
      (key) => key in values,
    )
  ) {
    capabilities.add('power');
  }

  if ('motion' in values) capabilities.add('motion');

  const text = `${deviceId} ${stringValue(raw.name) || ''} ${
    stringValue(raw.type) || ''
  }`.toLowerCase();

  if (text.includes('temp')) capabilities.add('temperature');
  if (text.includes('humid')) capabilities.add('humidity');

  if (
    text.includes('power') ||
    text.includes('energy') ||
    text.includes('meter')
  ) {
    capabilities.add('power');
  }

  if (text.includes('motion') || text.includes('presence')) {
    capabilities.add('motion');
  }

  if (text.includes('pump')) capabilities.add('pump');

  if (
    (text.includes('light') ||
      text.includes('lamp') ||
      text.includes('switch')) &&
    'on' in values
  ) {
    capabilities.add(
      text.includes('light') || text.includes('lamp') ? 'light' : 'switch',
    );
  }

  return [...capabilities];
}

function legacyOnlineStatus(
  value: unknown,
): 'online' | 'offline' | 'unknown' | null {
  if (typeof value === 'boolean') {
    return value ? 'online' : 'offline';
  }

  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();

  if (['online', 'true', '1', 'ok'].includes(normalized)) {
    return 'online';
  }

  if (['offline', 'false', '0', 'down'].includes(normalized)) {
    return 'offline';
  }

  return 'unknown';
}

function legacyZoneName(
  deviceId: string,
  raw: Record<string, unknown>,
): string {
  const text = `${deviceId} ${stringValue(raw.name) || ''}`.toLowerCase();

  const knownZones: Array<[string, string]> = [
    ['kitchen', 'Kitchen'],
    ['garage', 'Garage'],
    ['boiler', 'Boiler room'],
    ['hall', 'Hall'],
    ['bath', 'Bathroom'],
    ['bedroom', 'Bedroom'],
    ['living', 'Living room'],
    ['utility', 'Utility'],
    ['pump', 'Utility'],
  ];

  const inferred = knownZones.find(([token]) => text.includes(token));

  if (inferred) return inferred[1];

  return (
    stringValue(raw.location) ||
    stringValue(raw.room) ||
    stringValue(raw.zone) ||
    'Home'
  );
}

function legacyObservedAt(raw: Record<string, unknown>): string {
  const observedAt = stringValue(raw.observedAt) || stringValue(raw.lastSeen);

  if (observedAt) return observedAt;

  const timestamp = raw.timestamp;

  if (typeof timestamp === 'string' && timestamp.trim()) {
    return timestamp;
  }

  if (typeof timestamp === 'number' && timestamp > 1_000_000_000_000) {
    return new Date(timestamp).toISOString();
  }

  return new Date().toISOString();
}

function legacyDisplayName(deviceId: string): string {
  return deviceId
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ''}${part.slice(1)}`)
    .join(' ');
}

function cleanLegacyMetadata(
  metadata: Record<string, string | null>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      (entry): entry is [string, string] => !!entry[1],
    ),
  );
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
