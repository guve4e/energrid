import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { promisify } from 'node:util';
import { Subject } from 'rxjs';
import { DeviceRegistryService } from './device-registry.service';
import { OperationalLogService } from './operational-log.service';
import type { DeviceCapabilityKind } from './device-registry.types';

const execFileAsync = promisify(execFile);

export interface MqttDebugMessage {
  topic: string;
  payloadPreview: string;
  payloadBytes: number;
  observedAt: string;
  validJson: boolean;
  handled: boolean;
  reason: string;
}

export interface MqttDebugState {
  enabled: boolean;
  status: 'disabled' | 'running' | 'stopped';
  broker: {
    host: string;
    port: string;
  };
  prefix: string;
  subscriptions: string[];
  legacyTemperatureTopics: string[];
  legacyDeviceTopics: string[];
  recentMessages: MqttDebugMessage[];
}

export interface MqttDebugPublishResult {
  topic: string;
  payloadBytes: number;
  publishedAt: string;
}

@Injectable()
export class DeviceMqttIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceMqttIngestService.name);
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private recentMessages: MqttDebugMessage[] = [];
  private readonly debugMessages = new Subject<MqttDebugMessage>();

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly operationalLog?: OperationalLogService,
  ) {}

  onModuleInit(): void {
    if (!mqttIngestEnabled()) return;

    const prefix = mqttPrefix();
    const legacyTemperatureTopics = legacyTemperatureTopicConfigs();
    const legacyDeviceTopics = legacyDeviceTopicPatterns();
    const debugTopics = mqttDebugTopics(prefix);
    const args = [
      '-h',
      process.env.HOME_MQTT_HOST || '127.0.0.1',
      '-p',
      process.env.HOME_MQTT_PORT || '1883',
    ];

    for (const topic of debugTopics) {
      args.push('-t', topic);
    }
    args.push('-v');

    if (process.env.HOME_MQTT_USERNAME) {
      args.push('-u', process.env.HOME_MQTT_USERNAME);
    }
    if (process.env.HOME_MQTT_PASSWORD) {
      args.push('-P', process.env.HOME_MQTT_PASSWORD);
    }

    this.logger.log(
      `[DEVICE MQTT INGEST] subscribing topics=${debugTopics.length} legacyTemperatureTopics=${legacyTemperatureTopics.length} legacyDeviceTopics=${legacyDeviceTopics.length}`,
    );
    this.operationalLog?.record({
      level: 'info',
      source: 'mqtt-ingest',
      event: 'mqtt.subscribe',
      message: `MQTT ingest subscribed to ${debugTopics.length} topic pattern(s).`,
      details: {
        broker: `${args[1]}:${args[3]}`,
        subscriptions: debugTopics.length,
      },
    });
    this.process = spawn(
      process.env.HOME_MQTT_SUB_COMMAND || 'mosquitto_sub',
      args,
    );

    this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk) => {
      this.logger.warn(`[DEVICE MQTT INGEST] ${String(chunk).trim()}`);
      this.operationalLog?.record({
        level: 'warn',
        source: 'mqtt-ingest',
        event: 'mqtt.stderr',
        message: String(chunk).trim(),
      });
    });
    this.process.on('exit', (code, signal) => {
      this.logger.warn(
        `[DEVICE MQTT INGEST] stopped code=${code ?? '-'} signal=${signal ?? '-'}`,
      );
      this.operationalLog?.record({
        level: 'warn',
        source: 'mqtt-ingest',
        event: 'mqtt.stopped',
        message: `MQTT ingest stopped code=${code ?? '-'} signal=${signal ?? '-'}.`,
        status: 'stopped',
      });
      this.process = null;
    });
    this.process.on('error', (error) => {
      this.logger.warn(
        `[DEVICE MQTT INGEST] failed to start: ${error.message}`,
      );
      this.operationalLog?.record({
        level: 'error',
        source: 'mqtt-ingest',
        event: 'mqtt.start_failed',
        message: error.message,
        status: 'failed',
      });
      this.process = null;
    });
  }

  onModuleDestroy(): void {
    this.process?.kill();
    this.process = null;
    this.debugMessages.complete();
  }

  getDebugState(): MqttDebugState {
    const prefix = mqttPrefix();
    const legacyTemperatureTopics = legacyTemperatureTopicConfigs().map(
      (config) => config.topic,
    );
    const legacyDeviceTopics = legacyDeviceTopicPatterns();
    const subscriptions = mqttDebugTopics(prefix);

    return {
      enabled: mqttIngestEnabled(),
      status: !mqttIngestEnabled()
        ? 'disabled'
        : this.process
          ? 'running'
          : 'stopped',
      broker: mqttBroker(),
      prefix,
      subscriptions,
      legacyTemperatureTopics,
      legacyDeviceTopics,
      recentMessages: [...this.recentMessages].reverse(),
    };
  }

  streamDebugMessages() {
    return this.debugMessages.asObservable();
  }

  async publishDebugMessage(
    topic: unknown,
    payload: unknown,
  ): Promise<MqttDebugPublishResult> {
    const topicText = typeof topic === 'string' ? topic.trim() : '';
    if (!topicText) throw new BadRequestException('MQTT topic is required.');

    const prefix = mqttPrefix();
    if (
      !mqttDebugAllowAnyTopic() &&
      topicText !== prefix &&
      !topicText.startsWith(`${prefix}/`)
    ) {
      throw new BadRequestException(`Debug publish is limited to ${prefix}/#.`);
    }

    const payloadText = normalizePayloadText(payload);
    const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
    const maxBytes = Number(
      process.env.HOME_MQTT_DEBUG_MAX_PAYLOAD_BYTES || 8192,
    );
    if (payloadBytes > maxBytes) {
      throw new BadRequestException(
        `Payload is too large. Max ${maxBytes} bytes.`,
      );
    }

    await publishMqtt(topicText, payloadText);
    const publishedAt = new Date().toISOString();
    this.recordDebugMessage(
      topicText,
      payloadText,
      true,
      true,
      'published by portal',
    );
    this.operationalLog?.record({
      level: 'info',
      source: 'portal',
      event: 'mqtt.debug_publish',
      message: `Portal published ${payloadBytes} byte(s) to ${topicText}.`,
      topic: topicText,
      details: {
        payloadBytes,
      },
    });

    return {
      topic: topicText,
      payloadBytes,
      publishedAt,
    };
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    const separator = line.indexOf(' ');
    if (separator <= 0) return;

    const topic = line.slice(0, separator);
    const payloadText = line.slice(separator + 1);

    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      this.recordDebugMessage(
        topic,
        payloadText,
        false,
        false,
        'ignored non-json',
      );
      this.logger.warn(`[DEVICE MQTT INGEST] ignored non-json topic=${topic}`);
      if (!topic.startsWith('$SYS/')) {
        this.operationalLog?.record({
          level: 'warn',
          source: 'mqtt-ingest',
          event: 'mqtt.ignored_non_json',
          message: `Ignored non-JSON MQTT payload on ${topic}.`,
          topic,
          details: {
            payloadBytes: Buffer.byteLength(payloadText, 'utf8'),
          },
        });
      }
      return;
    }

    if (topic.endsWith('/registry/devices')) {
      this.registry.ingestRegistryPayload(payload);
      this.recordDebugMessage(
        topic,
        payloadText,
        true,
        true,
        'registry devices',
      );
      this.logger.log(`[DEVICE MQTT INGEST] registry topic=${topic}`);
      this.operationalLog?.record({
        level: 'info',
        source: 'mqtt-ingest',
        event: 'mqtt.registry',
        message: `Device registry update received on ${topic}.`,
        topic,
      });
      return;
    }

    const legacyTemperatureTopic = legacyTemperatureTopicConfigs().find(
      (config) => config.topic === topic,
    );
    if (legacyTemperatureTopic) {
      this.ingestLegacyTemperature(legacyTemperatureTopic, payload);
      this.recordDebugMessage(
        topic,
        payloadText,
        true,
        true,
        'legacy temperature',
      );
      return;
    }

    if (this.ingestLegacyFrameworkDevice(topic, payload)) {
      this.recordDebugMessage(
        topic,
        payloadText,
        true,
        true,
        'legacy framework device',
      );
      return;
    }

    if (topic.endsWith('/telemetry') || topic.endsWith('/state')) {
      this.registry.ingestDeviceTelemetry(payload);
      this.recordDebugMessage(
        topic,
        payloadText,
        true,
        true,
        'device telemetry',
      );
      this.operationalLog?.record({
        level: 'debug',
        source: 'mqtt-ingest',
        event: 'mqtt.telemetry',
        message: `Device telemetry handled from ${topic}.`,
        topic,
      });
      return;
    }

    if (topic.endsWith('/status')) {
      this.registry.ingestDeviceStatus(payload);
      this.recordDebugMessage(topic, payloadText, true, true, 'device status');
      this.operationalLog?.record({
        level: 'debug',
        source: 'mqtt-ingest',
        event: 'mqtt.status',
        message: `Device status handled from ${topic}.`,
        topic,
      });
      return;
    }

    this.recordDebugMessage(
      topic,
      payloadText,
      true,
      false,
      'json topic outside known handlers',
    );
  }

  private ingestLegacyTemperature(
    config: LegacyTemperatureTopicConfig,
    payload: unknown,
  ): void {
    if (!payload || typeof payload !== 'object') return;

    const raw = payload as Record<string, unknown>;
    const temperature = numericValue(raw.temperature ?? raw.value);
    const humidity = numericValue(raw.humidity);
    if (temperature == null) {
      this.logger.warn(
        `[DEVICE MQTT INGEST] ignored legacy temperature without numeric value topic=${config.topic}`,
      );
      this.operationalLog?.record({
        level: 'warn',
        source: 'mqtt-ingest',
        event: 'mqtt.ignored_legacy_temperature',
        message: `Ignored legacy temperature payload without numeric value on ${config.topic}.`,
        topic: config.topic,
      });
      return;
    }

    const values: Record<string, number> = { temperature };
    if (humidity != null) values.humidity = humidity;

    const observedAt =
      stringValue(raw.timestamp) ||
      stringValue(raw.observedAt) ||
      new Date().toISOString();
    const capabilities =
      humidity == null ? ['temperature'] : ['temperature', 'humidity'];

    this.registry.ingestRegistryPayload({
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
          capabilities,
          values,
          observedAt,
          metadata: {
            legacyTopic: config.topic,
          },
        },
      ],
      observedAt,
    });
  }

  private ingestLegacyFrameworkDevice(
    topic: string,
    payload: unknown,
  ): boolean {
    const parsedTopic = parseLegacyFrameworkTopic(topic);
    if (!parsedTopic) return false;

    if (parsedTopic.kind === 'online') {
      const status = legacyOnlineStatus(payload);
      if (!status) return false;

      this.registry.ingestDeviceStatus({
        deviceId: parsedTopic.deviceId,
        status,
        observedAt: new Date().toISOString(),
      });
      return true;
    }

    if (!payload || typeof payload !== 'object') return false;

    const raw = payload as Record<string, unknown>;
    const deviceId = topicPart(
      stringValue(raw.deviceId) || parsedTopic.deviceId,
    );
    if (!deviceId) return false;

    const values = legacyReadingValues(raw);
    const capabilities = legacyDeviceCapabilities(deviceId, raw, values);
    if (Object.keys(values).length === 0) {
      const status = legacyOnlineStatus(raw.online ?? raw.status);
      if (status) {
        this.registry.ingestDeviceStatus({
          deviceId,
          status,
          observedAt: legacyObservedAt(raw),
        });
      }
      this.logger.warn(
        `[DEVICE MQTT INGEST] ignored legacy device without readings topic=${topic}`,
      );
      this.operationalLog?.record({
        level: 'debug',
        source: 'mqtt-ingest',
        event: 'mqtt.ignored_legacy_empty',
        message: `Ignored legacy device payload without readings on ${topic}.`,
        topic,
        deviceId,
      });
      return true;
    }
    if (capabilities.length === 0) {
      this.logger.warn(
        `[DEVICE MQTT INGEST] ignored legacy device without known readings topic=${topic}`,
      );
      this.operationalLog?.record({
        level: 'warn',
        source: 'mqtt-ingest',
        event: 'mqtt.ignored_legacy_unknown',
        message: `Ignored legacy device payload without known readings on ${topic}.`,
        topic,
        deviceId,
      });
      return true;
    }

    const zoneName = legacyZoneName(deviceId, raw);
    const observedAt = legacyObservedAt(raw);

    this.registry.ingestRegistryPayload({
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
          target: topic,
          location: zoneName,
          zoneName,
          capabilities,
          values,
          observedAt,
          status: legacyOnlineStatus(raw.online ?? raw.status) || 'online',
          metadata: cleanLegacyMetadata({
            legacyTopic: topic,
            legacyType: stringValue(raw.type),
            firmwareVersion: stringValue(raw.firmwareVersion),
            app: stringValue(raw.app),
          }),
        },
      ],
      observedAt,
    });
    return true;
  }

  private recordDebugMessage(
    topic: string,
    payloadText: string,
    validJson: boolean,
    handled: boolean,
    reason: string,
  ): void {
    const message = {
      topic,
      payloadPreview: previewPayload(payloadText),
      payloadBytes: Buffer.byteLength(payloadText, 'utf8'),
      observedAt: new Date().toISOString(),
      validJson,
      handled,
      reason,
    };

    this.recentMessages.push(message);
    this.debugMessages.next(message);

    const maxMessages = Number(process.env.HOME_MQTT_DEBUG_MAX_MESSAGES || 200);
    if (this.recentMessages.length > maxMessages) {
      this.recentMessages.splice(0, this.recentMessages.length - maxMessages);
    }
  }
}

function mqttIngestEnabled(): boolean {
  return ['1', 'true', 'yes'].includes(
    String(process.env.HOME_MQTT_INGEST_ENABLED).toLowerCase(),
  );
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

function mqttBroker(): { host: string; port: string } {
  return {
    host: process.env.HOME_MQTT_HOST || process.env.MQTT_HOST || '127.0.0.1',
    port: process.env.HOME_MQTT_PORT || process.env.MQTT_PORT || '1883',
  };
}

function mqttDebugAllowAnyTopic(): boolean {
  return ['1', 'true', 'yes'].includes(
    String(process.env.HOME_MQTT_DEBUG_ALLOW_ANY_TOPIC).toLowerCase(),
  );
}

function mqttDebugTopics(prefix: string): string[] {
  const configured = process.env.HOME_MQTT_DEBUG_TOPICS;
  const defaults = [
    `${prefix}/#`,
    ...legacyDeviceTopicPatterns(),
    ...legacyTemperatureTopicConfigs().map((config) => config.topic),
    'shelly/#',
    '$SYS/#',
  ];
  const topics = configured
    ? configured
        .split(',')
        .map((topic) => topic.trim())
        .filter(Boolean)
    : [];

  return [...new Set([...topics, ...defaults])];
}

function legacyDeviceTopicPatterns(): string[] {
  const configured = process.env.HOME_MQTT_LEGACY_DEVICE_TOPICS || 'devices/#';
  return configured
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function normalizePayloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload == null) return '';
  return JSON.stringify(payload);
}

function previewPayload(payload: string): string {
  const maxLength = Number(process.env.HOME_MQTT_DEBUG_PREVIEW_CHARS || 600);
  return payload.length > maxLength
    ? `${payload.slice(0, maxLength)}...`
    : payload;
}

async function publishMqtt(topic: string, payload: string): Promise<void> {
  const broker = mqttBroker();
  const args = [
    '-h',
    broker.host,
    '-p',
    broker.port,
    '-t',
    topic,
    '-m',
    payload,
  ];
  if (process.env.HOME_MQTT_USERNAME)
    args.push('-u', process.env.HOME_MQTT_USERNAME);
  if (process.env.HOME_MQTT_PASSWORD)
    args.push('-P', process.env.HOME_MQTT_PASSWORD);

  await execFileAsync(process.env.HOME_MQTT_PUB_BIN || 'mosquitto_pub', args, {
    timeout: Number(process.env.HOME_DEVICE_WRITE_TIMEOUT_MS || 2500),
  });
}

interface LegacyTemperatureTopicConfig {
  topic: string;
  deviceId: string;
  zoneName: string;
  displayName: string;
}

function legacyTemperatureTopicConfigs(): LegacyTemperatureTopicConfig[] {
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

type LegacyFrameworkTopicKind = 'status' | 'state' | 'telemetry' | 'online';

interface LegacyFrameworkTopic {
  deviceId: string;
  kind: LegacyFrameworkTopicKind;
}

function parseLegacyFrameworkTopic(topic: string): LegacyFrameworkTopic | null {
  const parts = topic.split('/').filter(Boolean);
  if (parts[0] !== 'devices' || parts.length < 3) return null;

  const kind = parts[parts.length - 1];
  if (!['status', 'state', 'telemetry', 'online'].includes(kind)) return null;

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
    if (normalized !== undefined)
      values[key === 'output' ? 'on' : key] = normalized;
  }

  return values;
}

function legacyPrimitiveValue(
  value: unknown,
): number | boolean | string | null | undefined {
  if (value && typeof value === 'object' && 'value' in value) {
    return legacyPrimitiveValue((value as { value?: unknown }).value);
  }
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
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
      ? (raw.config as { readings?: Record<string, { enabled?: boolean }> })
          .readings || {}
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

  const text =
    `${deviceId} ${stringValue(raw.name) || ''} ${stringValue(raw.type) || ''}`.toLowerCase();
  if (text.includes('temp')) capabilities.add('temperature');
  if (text.includes('humid')) capabilities.add('humidity');
  if (
    text.includes('power') ||
    text.includes('energy') ||
    text.includes('meter')
  )
    capabilities.add('power');
  if (text.includes('motion') || text.includes('presence'))
    capabilities.add('motion');
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
  if (typeof value === 'boolean') return value ? 'online' : 'offline';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['online', 'true', '1', 'ok'].includes(normalized)) return 'online';
  if (['offline', 'false', '0', 'down'].includes(normalized)) return 'offline';
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
  if (typeof timestamp === 'string' && timestamp.trim()) return timestamp;
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
