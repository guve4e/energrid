import type { ElectricalReading } from '@energrid/domain-telemetry';
import type {
  DeviceMqttAdapterResult,
  DeviceMqttMessage,
  DeviceMqttMessageAdapter,
} from '../../../mqtt/device-mqtt-message-adapter';
import type { PhysicalDeviceDiscovery } from '../../../enrollment/physical-device-inventory.repository';

interface ShellyComponentTelemetry {
  physicalId: string;
  component: string;
  channel: number | null;
  values: Record<string, number | boolean | string | null>;
  observedAt: string;
  readings: Array<
    Pick<
      ElectricalReading,
      | 'schemaVersion'
      | 'channel'
      | 'metric'
      | 'value'
      | 'unit'
      | 'quality'
      | 'observedAt'
      | 'timestampBasis'
    >
  >;
}

export class ShellyMqttAdapter implements DeviceMqttMessageAdapter {
  readonly id = 'shelly';

  subscriptions(): string[] {
    // Gen2+ defaults put the device ID at the root, not under a shared "shelly" prefix.
    return ['shelly/#', '+/events/rpc', '+/status/+'];
  }

  handle(message: DeviceMqttMessage): DeviceMqttAdapterResult | null {
    const raw = normalizeShellyPayload(message.topic, message.payload);
    const params =
      raw &&
      typeof raw === 'object' &&
      raw.params &&
      typeof raw.params === 'object'
        ? (raw.params as Record<string, unknown>)
        : null;
    const entries = params
      ? Object.entries(params).filter(([key]) =>
          /^(switch|em1|em1data):\d+$/.test(key),
        )
      : [];
    if (entries.length > 1) {
      if (entries.length > 32) return null;
      const results = entries
        .map(([key, value]) =>
          this.handle({
            ...message,
            payload: { ...raw, params: { ts: params?.ts, [key]: value } },
          }),
        )
        .filter((result) => result !== null);
      if (!results.length) return null;
      return {
        reason: 'shelly telemetry',
        effects: results.flatMap((result) => result.effects),
        physicalDiscoveries: results.flatMap((result) => result.physicalDiscoveries ?? []),
      };
    }
    const telemetry = parseShellyComponentTelemetry(message.topic, raw);

    if (!telemetry) return null;

    const componentKey = telemetry.component.replace('em1data:', 'em1:');
    const discovery = discoveredShellyComponent(
      message.topic,
      telemetry,
      componentKey,
    );

    return {
      reason: 'shelly telemetry',
      effects: [
        { kind: 'discovery', payload: discovery },
        {
          kind: 'telemetry',
          payload: {
            target: {
              identity: {
                namespace: 'mqtt:shelly-protocol-id',
                value: telemetry.physicalId,
              },
              componentKey,
              channel: telemetry.channel,
            },
            values: telemetry.values,
            ...(telemetry.readings.length
              ? { readings: telemetry.readings }
              : {}),
            observedAt: telemetry.observedAt,
            origin: 'shelly-mqtt',
            protocol: 'mqtt',
            status: 'online',
          },
        },
      ],
      physicalDiscoveries: [physicalDiscovery(message, telemetry)],
    };
  }
}

function normalizeShellyPayload(
  topic: string,
  payload: unknown,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const raw = payload as Record<string, unknown>;
  const snapshotId = /^shelly\/status\/([^/]+)$/.exec(topic)?.[1];
  if (!snapshotId) return raw;
  if (
    (raw.id !== undefined && raw.id !== snapshotId) ||
    (raw.src !== undefined && raw.src !== snapshotId)
  )
    return null;
  if (raw.params && typeof raw.params === 'object') return raw;

  // The existing status publisher puts all components at the payload root.
  return { ...raw, src: snapshotId, params: raw };
}

function shellyCommandTopic(topic: string): string | undefined {
  const prefix =
    /^(.*)\/(?:events\/rpc|status\/(?:switch|em1|em1data):\d+)$/.exec(
      topic,
    )?.[1];
  return prefix ? `${prefix}/rpc` : undefined;
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

  const clock = shellyObservedAt(raw, params);
  const observedAt = clock.observedAt;
  const readings: ShellyComponentTelemetry['readings'] = [];
  const add = (
    metric: ElectricalReading['metric'],
    field: unknown,
    scale = 1,
  ) => {
    if (field === undefined) return;
    const number = finiteNumber(field);
    const value =
      number === null || (metric !== 'power' && number < 0)
        ? null
        : number * scale;
    readings.push({
      schemaVersion: 1,
      channel: componentName!.replace('em1data:', 'em1:'),
      metric,
      value,
      unit: metric === 'power' ? 'W' : 'kWh',
      quality: value === null ? 'invalid' : 'measured',
      observedAt,
      timestampBasis: clock.timestampBasis,
    });
  };
  add('power', 'apower' in component ? component.apower : component.act_power);
  const imported = component.aenergy as Record<string, unknown> | undefined;
  const exported = component.ret_aenergy as Record<string, unknown> | undefined;
  // Shelly cumulative energy fields are Wh; canonical totals are kWh.
  add(
    'energy_import_total',
    'total_act_energy' in component
      ? component.total_act_energy
      : imported?.total,
    1 / 1000,
  );
  add(
    'energy_export_total',
    'total_act_ret_energy' in component
      ? component.total_act_ret_energy
      : exported?.total,
    1 / 1000,
  );
  if (Object.keys(values).length === 0 && !readings.length) return null;

  return {
    physicalId,
    component: componentName,
    channel,
    values,
    observedAt,
    readings,
  };
}

function shellyPhysicalIdFromTopic(parts: string[]): string | null {
  const eventsIndex = parts.indexOf('events');
  if (eventsIndex > 0 && looksLikeShellyHardwareId(parts[eventsIndex - 1])) return parts[eventsIndex - 1];

  const statusIndex = parts.indexOf('status');
  if (statusIndex > 0 && looksLikeShellyHardwareId(parts[statusIndex - 1])) return parts[statusIndex - 1];

  return null;
}

function looksLikeShellyHardwareId(value: string | undefined): value is string {
  // A configured topic prefix is not identity evidence. Only accept the
  // canonical device-ID shape when protocol payload identity is absent.
  return !!value && /^shelly[a-z0-9]+-[0-9a-f]{12}$/i.test(value);
}

function physicalDiscovery(
  message: DeviceMqttMessage,
  telemetry: ShellyComponentTelemetry,
): Omit<PhysicalDeviceDiscovery, 'scope'> {
  const componentKey = telemetry.component.replace('em1data:', 'em1:');
  const capabilities = [
    ...(telemetry.values.power !== undefined || telemetry.values.energy !== undefined ? ['power' as const] : []),
    ...(telemetry.values.on !== undefined ? ['switch' as const] : []),
  ];
  return {
    identity: { namespace: 'mqtt:shelly-protocol-id', value: telemetry.physicalId },
    evidenceSource: 'mqtt_protocol_message',
    observedAt: telemetry.observedAt,
    components: [{ key: componentKey, capabilities }],
    endpoint: { protocol: 'mqtt', kind: 'telemetry', address: message.topic },
  };
}

function discoveredShellyComponent(
  topic: string,
  telemetry: ShellyComponentTelemetry,
  componentKey: string,
) {
  const capabilities = [
    ...(telemetry.values.power !== undefined || telemetry.values.energy !== undefined ? ['power' as const] : []),
    ...(telemetry.values.on !== undefined ? ['switch' as const] : []),
  ];
  return {
    id: `${telemetry.physicalId}:${componentKey}`,
    displayName: `${telemetry.physicalId} ${componentKey}`,
    suggestedName: `${telemetry.physicalId} ${componentKey}`,
    suggestedRoom: 'Unknown',
    protocol: 'mqtt' as const,
    transport: 'mqtt' as const,
    driver: 'shelly-discovered',
    target: telemetry.physicalId,
    capabilities,
    source: 'mqtt' as const,
    confidence: 0.8,
    reason: 'Discovered from Shelly MQTT telemetry',
    metadata: {
      physicalId: telemetry.physicalId,
      component: componentKey,
      ...(telemetry.channel === null ? {} : { channel: telemetry.channel }),
      ...(shellyCommandTopic(topic) ? { mqttCommandTopic: shellyCommandTopic(topic) } : {}),
    },
  };
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
): { observedAt: string; timestampBasis: ElectricalReading['timestampBasis'] } {
  const direct = stringValue(raw.observedAt) || stringValue(raw.timestamp);

  if (direct) return { observedAt: direct, timestampBasis: 'device-observed' };

  const timestamp = finiteNumber(params?.ts) ?? finiteNumber(raw.ts);

  if (timestamp != null) {
    const milliseconds =
      timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;

    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime()))
      return {
        observedAt: parsed.toISOString(),
        timestampBasis: 'device-observed',
      };
  }

  return {
    observedAt: new Date().toISOString(),
    timestampBasis: 'collector-received',
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
