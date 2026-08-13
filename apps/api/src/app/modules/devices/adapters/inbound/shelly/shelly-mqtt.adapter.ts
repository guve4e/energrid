import { DeviceRegistryService } from '../../../device-registry.service';
import type {
  DeviceMqttAdapterResult,
  DeviceMqttMessage,
  DeviceMqttMessageAdapter,
} from '../../../mqtt/device-mqtt-message-adapter';

interface ShellyComponentTelemetry {
  physicalId: string;
  component: string;
  channel: number | null;
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
    const telemetry = parseShellyComponentTelemetry(
      message.topic,
      message.payload,
    );

    if (!telemetry) return null;

    const deviceId = this.registry.findApprovedDeviceIdByPhysicalChannel(
      telemetry.physicalId,
      telemetry.component,
      telemetry.channel,
    );

    if (!deviceId) {
      this.registry.registerDiscoveredShellyDevice(
        telemetry.physicalId,
        telemetry.component,
        telemetry.channel,
      );

      return {
        reason: 'shelly device discovered',
        effects: [],
      };
    }

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

function parseShellyComponentTelemetry(
  topic: string,
  payload: unknown,
): ShellyComponentTelemetry | null {
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

  const componentEntry = params
    ? Object.entries(params).find(
        ([key, value]) =>
          /^(switch|em1|em1data):\d+$/.test(key) &&
          !!value &&
          typeof value === 'object',
      )
    : undefined;

  const topicComponent = topicParts.find((part) =>
    /^(switch|em1|em1data):\d+$/.test(part),
  );

  let componentName: string | null = null;
  let component: Record<string, unknown> | null = null;

  if (componentEntry) {
    componentName = componentEntry[0];
    component = componentEntry[1] as Record<string, unknown>;
  } else if (topicComponent) {
    componentName = topicComponent;
    component =
      raw.params && typeof raw.params === 'object'
        ? (raw.params as Record<string, unknown>)
        : raw;
  }

  if (!componentName || !component) return null;

  const channelPart = componentName.split(':')[1];
  const channel = channelPart ? Number(channelPart) : null;

  if (channel !== null && (!Number.isInteger(channel) || channel < 0)) {
    return null;
  }

  const values: Record<string, number | boolean | string | null> = {};

  const output = shellyBooleanValue(component.output);

  if (output != null) {
    values.on = output;
  }

  const power =
    finiteNumber(component.apower) ?? finiteNumber(component.act_power);

  const current = finiteNumber(component.current);
  const voltage = finiteNumber(component.voltage);

  const totalEnergy = finiteNumber(component.total_act_energy);

  const returnedEnergy = finiteNumber(component.total_act_ret_energy);

  if (power != null) {
    values.power = power;
  }

  if (current != null) {
    values.current = current;
  }

  if (voltage != null) {
    values.voltage = voltage;
  }

  if (totalEnergy != null) {
    values.energy = totalEnergy;
  }

  if (returnedEnergy != null) {
    values.returnedEnergy = returnedEnergy;
  }

  if (Object.keys(values).length === 0) return null;

  return {
    physicalId,
    component: componentName,
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
