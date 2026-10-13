import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  diagnoseDeviceConnection,
  privateShellyBaseUrl,
  type DeviceConnectionEvidence,
  type DeviceConnectionReport,
  type DiagnosticProbe,
  type DeviceControlBinding,
} from '@energrid/domain-devices';
import { ShellyHttpControl } from './adapters/outbound/shelly-http-control';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceLanDiscoveryService } from './device-lan-discovery.service';
import { DeviceMqttIngestService } from './device-mqtt-ingest.service';
import type { RegisteredDevice } from './device-registry.types';

type HttpRoute = Extract<DeviceControlBinding, { kind: 'shelly-http' }>;

@Injectable()
export class DeviceDiagnosticsService {
  private readonly http = new ShellyHttpControl();
  private readonly running = new Map<string, Promise<DeviceConnectionReport>>();

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly lan: DeviceLanDiscoveryService,
    private readonly mqtt: DeviceMqttIngestService,
  ) {}

  check(deviceId: string): Promise<DeviceConnectionReport> {
    const devices = this.registry.getDevices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device) throw new NotFoundException('Device not found.');
    if (
      device.trustStatus !== 'approved' ||
      device.tenantId !== (process.env.PORTAL_TENANT_ID || 'tenant-demo') ||
      device.siteId !==
        (process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home')
    )
      throw new ForbiddenException(
        'Connection checks are limited to approved devices in this site.',
      );
    const pending = this.running.get(deviceId);
    if (pending) return pending;
    if (this.running.size >= 4)
      throw new HttpException(
        'Connection checks are busy. Please try again shortly.',
        429,
      );
    const request = this.inspect(device, devices).finally(() =>
      this.running.delete(deviceId),
    );
    this.running.set(deviceId, request);
    return request;
  }

  private async inspect(
    device: RegisteredDevice,
    devices: RegisteredDevice[],
  ): Promise<DeviceConnectionReport> {
    const skipped = <T>(): DiagnosticProbe<T> => ({
      status: 'skipped',
      checkedAt: new Date().toISOString(),
    });
    const binding = device.control?.binding;
    const trace = this.registry.getLatestExecutionTrace(device.id);
    const debug = this.mqtt.getDebugState();
    const evidence: DeviceConnectionEvidence = {
      deviceId: device.id,
      checkedAt: new Date().toISOString(),
      transport:
        binding?.kind === 'shelly-http' ? 'http' : binding ? 'mqtt' : 'none',
      controlEnabled: device.control?.status === 'ready',
      readingsSource: device.adapter.protocol.toUpperCase(),
      lastTelemetryAt: device.state.observedAt,
      identity: skipped(),
      relay: skipped(),
      mqttConfig: skipped(),
      mqttStatus: skipped(),
      expectedTopic: binding && 'topic' in binding ? binding.topic : null,
      expectedBroker:
        safeBroker(
          `${process.env.HOME_MQTT_HOST || process.env.MQTT_HOST || 'localhost'}:${process.env.HOME_MQTT_PORT || process.env.MQTT_PORT || '1883'}`,
        ) || 'not configured',
      listener: debug.status,
      sharedTopic:
        binding?.kind === 'shelly-mqtt' &&
        devices.some(
          (other) =>
            other.id !== device.id &&
            other.trustStatus === 'approved' &&
            other.tenantId === device.tenantId &&
            other.siteId === device.siteId &&
            other.control?.binding?.kind === 'shelly-mqtt' &&
            other.control.binding.enabled &&
            other.control.binding.topic === binding.topic &&
            other.control.binding.physicalId !== binding.physicalId,
        ),
      lastCommand: trace
        ? {
            action: trace.action,
            outcome: trace.outcome,
            requestedAt: trace.requestedAt,
            completedAt: trace.completedAt,
            publishedAt:
              trace.stages.find(
                (s) => s.stage === 'published' && s.status === 'complete',
              )?.observedAt || null,
          }
        : device.state.command
          ? {
              action: device.state.command.action,
              outcome: device.state.command.status,
              requestedAt: device.state.command.requestedAt,
              publishedAt: null,
              completedAt: null,
            }
          : null,
    };
    const route = this.httpRoute(device);
    if (route) {
      evidence.identity = await this.read(
        route,
        'Shelly.GetDeviceInfo',
        (payload) =>
          typeof payload.id === 'string'
            ? { matches: payload.id === route.physicalId }
            : null,
      );
      // Never read component/configuration data from hardware whose identity did not match.
      if (evidence.identity.value?.matches === true) {
        evidence.relay = await this.read(
          route,
          'Switch.GetStatus',
          (payload) =>
            payload.id === route.channel && typeof payload.output === 'boolean'
              ? { on: payload.output }
              : null,
        );
        if (evidence.transport === 'mqtt') {
          evidence.mqttConfig = await this.read(
            route,
            'MQTT.GetConfig',
            (payload) => ({
              enabled: booleanOrNull(payload.enable),
              rpcEnabled: booleanOrNull(payload.enable_rpc),
              notificationsEnabled:
                payload.rpc_ntf === true || payload.status_ntf === true
                  ? true
                  : payload.rpc_ntf === false && payload.status_ntf === false
                    ? false
                    : null,
              topic:
                typeof payload.topic_prefix === 'string' &&
                payload.topic_prefix.length <= 250 &&
                !/[\x00-\x1f+#]/.test(payload.topic_prefix)
                  ? `${payload.topic_prefix}/rpc`
                  : payload.topic_prefix === null
                    ? `${route.physicalId}/rpc`
                    : null,
              broker: safeBroker(payload.server),
            }),
          );
          evidence.mqttStatus = await this.read(
            route,
            'MQTT.GetStatus',
            (payload) => ({ connected: booleanOrNull(payload.connected) }),
          );
        }
      }
    }
    evidence.checkedAt = new Date().toISOString();
    return diagnoseDeviceConnection(evidence);
  }

  private httpRoute(device: RegisteredDevice): HttpRoute | null {
    if (
      device.kind !== 'physical' ||
      device.adapter.protocol === 'simulated' ||
      device.metadata?.simulated === true ||
      !device.adapter.driver.includes('shelly')
    )
      return null;
    const physicalId = device.metadata?.physicalId;
    const channel = device.metadata?.channel;
    if (
      typeof physicalId !== 'string' ||
      !/^shelly[a-z0-9-]*-[a-f0-9]{12}$/i.test(physicalId) ||
      !Number.isInteger(channel) ||
      Number(channel) < 0 ||
      Number(channel) > 31 ||
      device.metadata?.component !== `switch:${channel}`
    )
      return null;
    const binding = device.control?.binding;
    const network = this.lan.getLastScan().find((d) => d.id === physicalId);
    let baseUrl =
      binding?.kind === 'shelly-http'
        ? binding.baseUrl
        : device.metadata?.httpBaseUrl;
    if (typeof baseUrl !== 'string' && network)
      baseUrl = `http://${network.ipAddress}`;
    if (typeof baseUrl !== 'string') return null;
    try {
      return {
        kind: 'shelly-http',
        enabled: false,
        physicalId,
        channel: Number(channel),
        baseUrl: privateShellyBaseUrl(baseUrl),
        ...(binding?.kind === 'shelly-http' && binding.credentialRef
          ? { credentialRef: binding.credentialRef }
          : {}),
      };
    } catch {
      return null;
    }
  }

  private async read<T>(
    route: HttpRoute,
    method: Parameters<ShellyHttpControl['readOnly']>[1],
    select: (payload: Record<string, unknown>) => T | null,
  ): Promise<DiagnosticProbe<T>> {
    try {
      const value = select(await this.http.readOnly(route, method));
      return value === null
        ? { status: 'unavailable', checkedAt: new Date().toISOString() }
        : { status: 'observed', checkedAt: new Date().toISOString(), value };
    } catch (error) {
      return {
        status:
          error instanceof Error &&
          error.message.includes('authentication failed')
            ? 'auth-required'
            : 'unavailable',
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function safeBroker(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 250) return null;
  try {
    const url = new URL(value.includes('://') ? value : `mqtt://${value}`);
    if (
      !['mqtt:', 'mqtts:', 'ssl:'].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname && url.pathname !== '/') ||
      url.search ||
      url.hash
    )
      return null;
    return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'mqtt:' ? '1883' : '8883')}`;
  } catch {
    return null;
  }
}
