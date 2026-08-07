import { DeviceRegistryService } from '../../../device-registry.service';
import type {
  DeviceMqttAdapterResult,
  DeviceMqttMessage,
  DeviceMqttMessageAdapter,
} from '../../../mqtt/device-mqtt-message-adapter';

interface ShellySwitchTelemetry {
  physicalId: string;
  channel: number;
  values: Record<string, number | boolean | string | null>;
  observedAt: string;
}

export class ShellyMqttAdapter implements DeviceMqttMessageAdapter {
  readonly id = 'shelly';

  constructor(private readonly registry: DeviceRegistryService) {}

  subscriptions(): string[] {
    return ['shelly/#'];
  }

  handle(message: DeviceMqttMessage): DeviceMqttAdapterResult | null {
    const telemetry = parseShellySwitchTelemetry(
      message.topic,
      message.payload,
    );

    if (!telemetry) return null;

    const deviceId = this.registry.findApprovedDeviceIdByPhysicalChannel(
      telemetry.physicalId,
      telemetry.channel,
    );

    if (!deviceId) return null;

    return {
      reason: 'shelly telemetry',
      effects: [
        {
          kind: 'telemetry',
          payload: {
            deviceId,
            values: telemetry.values,
            observedAt: telemetry.observedAt,
            origin: 'shelly-mqtt',
            protocol: 'mqtt',
            status: 'online',
          },
        },
      ],
    };
  }
}

function parseShellySwitchTelemetry(
  topic: string,
  payload: unknown,
): ShellySwitchTelemetry | null {
  if (!payload || typeof payload !== 'object') return null;

  const raw = payload as Record<string, unknown>;
  const topicParts = topic.split('/').filter(Boolean);

  const physicalId =
    stringValue(raw.src) || shellyPhysicalIdFromTopic(topicParts);

  if (!physicalId) return null;

  const params =
    raw.params && typeof raw.params === 'object'
      ? (raw.params as Record<string, unknown>)
      : null;

  const nestedSwitch = params
    ? Object.entries(params).find(
        ([key, value]) =>
          /^switch:\d+$/.test(key) && !!value && typeof value === 'object',
      )
    : undefined;

  const topicComponent = topicParts.find((part) => /^switch:\d+$/.test(part));

  let componentName: string | null = null;
  let component: Record<string, unknown> | null = null;

  if (nestedSwitch) {
    componentName = nestedSwitch[0];
    component = nestedSwitch[1] as Record<string, unknown>;
  } else if (topicComponent) {
    componentName = topicComponent;
    component =
      raw.params && typeof raw.params === 'object'
        ? (raw.params as Record<string, unknown>)
        : raw;
  }

  if (!componentName || !component) return null;

  const channel = Number(componentName.split(':')[1]);
  if (!Number.isInteger(channel) || channel < 0) return null;

  const output = shellyBooleanValue(component.output);
  if (output == null) return null;

  const values: Record<string, number | boolean | string | null> = {
    on: output,
  };

  const power = finiteNumber(component.apower);
  const current = finiteNumber(component.current);
  const voltage = finiteNumber(component.voltage);

  if (power != null) values.power = power;
  if (current != null) values.current = current;
  if (voltage != null) values.voltage = voltage;

  return {
    physicalId,
    channel,
    values,
    observedAt: shellyObservedAt(raw, params),
  };
}

function shellyPhysicalIdFromTopic(parts: string[]): string | null {
  const eventsIndex = parts.indexOf('events');
  if (eventsIndex > 0) return parts[eventsIndex - 1];

  const statusIndex = parts.indexOf('status');
  if (statusIndex > 0) return parts[statusIndex - 1];

  return null;
}

function shellyBooleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'on'].includes(normalized)) return true;
    if (['false', '0', 'off'].includes(normalized)) return false;
  }

  return null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function shellyObservedAt(
  raw: Record<string, unknown>,
  params: Record<string, unknown> | null,
): string {
  const direct = stringValue(raw.observedAt) || stringValue(raw.timestamp);

  if (direct) return direct;

  const timestamp = finiteNumber(params?.ts) ?? finiteNumber(raw.ts);

  if (timestamp != null) {
    const milliseconds =
      timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;

    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return new Date().toISOString();
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
