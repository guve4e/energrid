import {
  BadRequestException,
  Injectable,
  ForbiddenException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeviceRegistryService } from './device-registry.service';
import {
  parseDeviceControlBinding,
  deviceControlState,
  type DeviceControlBinding,
} from '@energrid/domain-devices';
import {
  ShellyHttpControl,
  shellyHttpCredentials,
} from './adapters/outbound/shelly-http-control';
import type {
  DeviceCapabilityAction,
  RegisteredDevice,
} from './device-registry.types';
import { DEVICE_ENROLLMENT_SERVICE } from './enrollment/device-enrollment.module';
import type { DeviceEnrollmentService } from './enrollment/device-enrollment.service';

const execFileAsync = promisify(execFile);

export interface DeviceActionResult {
  deviceId: string;
  action: DeviceCapabilityAction;
  status: 'success' | 'pending' | 'failed';
  adapter: 'mqtt' | 'http' | 'simulated' | 'none';
  message: string;
  affectedDeviceIds: string[];
  command?: RegisteredDevice['state']['command'];
}

@Injectable()
export class DeviceControlService {
  private readonly http = new ShellyHttpControl();

  constructor(
    private readonly registry: DeviceRegistryService,
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment: DeviceEnrollmentService,
  ) {}

  configure(deviceId: string, value: unknown): RegisteredDevice {
    try {
      const binding = parseDeviceControlBinding(value);
      if (binding?.kind === 'shelly-http')
        shellyHttpCredentials(binding.credentialRef);
      return this.registry.configureDeviceControl(deviceId, binding);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Invalid control configuration.',
      );
    }
  }

  async execute(
    deviceId: string,
    action: DeviceCapabilityAction | string | undefined,
  ): Promise<DeviceActionResult> {
    if (!action) throw new BadRequestException('Missing device action.');
    if (!isDeviceAction(action)) {
      throw new BadRequestException(`Unsupported device action ${action}.`);
    }

    const device = this.findDevice(deviceId);
    if (!device)
      throw new NotFoundException(`Device ${deviceId} was not found.`);

    if (
      device.trustStatus !== 'approved' ||
      device.tenantId !== (process.env.PORTAL_TENANT_ID || 'tenant-demo') ||
      device.siteId !==
        (process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home')
    )
      throw new ForbiddenException(
        'Control is limited to approved devices in this site.',
      );

    if (!deviceSupportsAction(device, action)) {
      throw new BadRequestException(
        `${device.displayName} does not expose ${action}.`,
      );
    }

    if (action !== 'turn_on' && action !== 'turn_off') {
      throw new BadRequestException(
        `${action} is recognized but is not wired to a control adapter yet.`,
      );
    }

    const problem = this.controlProblem(device, action, new Set());
    if (problem)
      return {
        deviceId,
        action,
        status: 'failed',
        adapter: 'none',
        message: problem,
        affectedDeviceIds: [],
      };

    const enrollmentProblem = await this.enrollmentProblem(device, new Set());
    if (enrollmentProblem) throw new ForbiddenException(enrollmentProblem);

    return this.executeBinarySwitch(device, action === 'turn_on', action);
  }

  private async enrollmentProblem(
    device: RegisteredDevice,
    seen: Set<string>,
  ): Promise<string | null> {
    if (seen.has(device.id)) return 'Circular device group; no command was sent.';
    const enrollment = await this.enrollment.find({
      tenantId: device.tenantId,
      siteId: device.siteId,
      deviceId: device.id,
    });
    if (!enrollment || enrollment.status !== 'enrolled') {
      return 'The device is not actively enrolled; no command was sent.';
    }
    const next = new Set(seen).add(device.id);
    for (const id of device.memberDeviceIds ?? []) {
      const member = this.findDevice(id);
      if (!member) return 'A group member is missing; no command was sent.';
      const problem = await this.enrollmentProblem(member, next);
      if (problem) return problem;
    }
    return null;
  }

  private controlProblem(
    device: RegisteredDevice,
    action: DeviceCapabilityAction,
    seen: Set<string>,
  ): string | null {
    if (seen.has(device.id))
      return 'Circular device group; no command was sent.';
    if (
      device.trustStatus !== 'approved' ||
      device.tenantId !== (process.env.PORTAL_TENANT_ID || 'tenant-demo') ||
      device.siteId !==
        (process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home')
    )
      return 'Every group member must be approved in this site.';
    if (!deviceSupportsAction(device, action))
      return 'A group member has no switching capability.';
    if (device.memberDeviceIds?.length) {
      const next = new Set(seen).add(device.id);
      for (const id of device.memberDeviceIds) {
        const member = this.findDevice(id);
        if (!member) return 'A group member is missing; no command was sent.';
        const problem = this.controlProblem(member, action, next);
        if (problem) return problem;
      }
      return null;
    }
    if (device.adapter.protocol === 'simulated') return null;
    const binding = parseDeviceControlBinding(device.control?.binding);
    const state = deviceControlState(device, binding);
    if (state.status === 'ready' && binding?.kind === 'shelly-http') {
      try {
        shellyHttpCredentials(binding.credentialRef);
      } catch {
        return 'The server credential reference is not configured.';
      }
    }
    return state.status === 'ready' ? null : state.reason;
  }

  private async executeBinarySwitch(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
  ): Promise<DeviceActionResult> {
    if (device.memberDeviceIds?.length) {
      return this.executeMemberSwitches(device, on, action);
    }

    if (device.adapter.protocol === 'simulated') {
      this.registry.ingestDeviceTelemetry({
        deviceId: device.id,
        values: { on },
        observedAt: new Date().toISOString(),
        origin: 'simulated-control',
      });

      return {
        deviceId: device.id,
        action,
        status: 'success',
        adapter: 'simulated',
        message: `${device.displayName} set ${on ? 'on' : 'off'} in simulation.`,
        affectedDeviceIds: [device.id],
      };
    }

    const binding = device.control!.binding!;
    if (binding.kind === 'generic-mqtt')
      return this.executeGenericMqttSwitch(device, on, action, binding.topic);
    return this.executeShellyRpc(device, on, action, binding);
  }

  private async executeMemberSwitches(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
  ): Promise<DeviceActionResult> {
    const members = [...new Set(device.memberDeviceIds!)].map(
      (id) => this.findDevice(id)!,
    );
    const results = await Promise.all(
      members.map((member) => this.executeBinarySwitch(member, on, action)),
    );
    const failed = results.filter((result) => result.status === 'failed');
    const pending = results.filter((result) => result.status === 'pending');
    const affected = results.flatMap((result) => result.affectedDeviceIds);

    return {
      deviceId: device.id,
      action,
      status:
        failed.length > 0
          ? 'failed'
          : pending.length > 0
            ? 'pending'
            : 'success',
      adapter: results.some((result) => result.adapter === 'mqtt')
        ? 'mqtt'
        : results.some((result) => result.adapter === 'http')
          ? 'http'
          : 'none',
      message:
        failed.length > 0
          ? `${failed.length} member switch command(s) failed.`
          : pending.length > 0
            ? `${affected.length} member switch command(s) sent; waiting for acknowledgement.`
            : `${affected.length} member switch command(s) confirmed.`,
      affectedDeviceIds: affected,
    };
  }

  private async executeShellyRpc(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
    binding: Extract<
      DeviceControlBinding,
      { kind: 'shelly-mqtt' | 'shelly-http' }
    >,
  ): Promise<DeviceActionResult> {
    const transport = binding.kind === 'shelly-http' ? 'http' : 'mqtt';
    const topic =
      binding.kind === 'shelly-mqtt'
        ? binding.topic
        : `${binding.baseUrl}/rpc/Switch.Set`;
    const dst = binding.physicalId;
    const switchId = binding.channel;

    const payload = JSON.stringify({
      id: Date.now(),
      src: process.env.HOME_SHELLY_RPC_SRC || 'energrid-api',
      dst,
      method: 'Switch.Set',
      params: { id: switchId, on },
    });

    const command = this.registry.markDeviceCommandPending(device.id, {
      action,
      expectedValues: { on },
      message: `Publishing Shelly ${action}; waiting for telemetry.`,
    });

    try {
      let reportedOn: boolean | null = null;
      if (binding.kind === 'shelly-http')
        reportedOn = await this.http.setSwitch(binding, on);
      else await this.publishMqtt(topic, payload);

      this.registry.markDeviceCommandPublished(device.id, command.id, {
        topic,
        adapter: binding.kind,
      });
      if (reportedOn !== null)
        this.registry.ingestDeviceTelemetry({
          deviceId: device.id,
          values: { on: reportedOn },
          observedAt: new Date().toISOString(),
          origin: 'shelly-http',
          status: 'online',
        });
      const confirmed = reportedOn === on;

      return {
        deviceId: device.id,
        action,
        status: confirmed ? 'success' : 'pending',
        adapter: transport,
        message: confirmed
          ? 'Shelly relay state confirmed over HTTP.'
          : `Sent Shelly ${action} to ${dst} switch ${switchId}; waiting for state confirmation.`,
        affectedDeviceIds: [device.id],
        command: this.findDevice(device.id)?.state.command || command,
      };
    } catch (error) {
      const message = errorMessage(error);

      this.registry.markDeviceCommandTransportFailed(
        device.id,
        command.id,
        message,
      );

      const failedCommand = this.registry.markDeviceCommandFailed(device.id, {
        action,
        expectedValues: { on },
        message,
      });

      return {
        deviceId: device.id,
        action,
        status: 'failed',
        adapter: transport,
        message,
        affectedDeviceIds: [],
        command: failedCommand,
      };
    }
  }

  private async executeGenericMqttSwitch(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
    topic: string,
  ): Promise<DeviceActionResult> {
    const command = this.registry.markDeviceCommandPending(device.id, {
      action,
      expectedValues: { on },
      message: `Publishing ${action}; waiting for telemetry.`,
    });

    const payload = JSON.stringify({
      commandId: command.id,
      action,
      on,
      deviceId: device.id,
      expectedValues: { on },
      requestedAt: command.requestedAt,
    });

    try {
      await this.publishMqtt(topic, payload);

      this.registry.markDeviceCommandPublished(device.id, command.id, {
        topic,
        adapter: device.adapter.driver,
      });

      return {
        deviceId: device.id,
        action,
        status: 'pending',
        adapter: 'mqtt',
        message: `Published ${action} to ${topic}; waiting for acknowledgement.`,
        affectedDeviceIds: [device.id],
        command,
      };
    } catch (error) {
      const message = errorMessage(error);

      this.registry.markDeviceCommandTransportFailed(
        device.id,
        command.id,
        message,
      );

      const failedCommand = this.registry.markDeviceCommandFailed(device.id, {
        action,
        expectedValues: { on },
        message,
      });

      return {
        deviceId: device.id,
        action,
        status: 'failed',
        adapter: 'mqtt',
        message,
        affectedDeviceIds: [],
        command: failedCommand,
      };
    }
  }

  private findDevice(deviceId: string): RegisteredDevice | null {
    return (
      this.registry.getDevices().find((device) => device.id === deviceId) ||
      null
    );
  }

  private async publishMqtt(topic: string, payload: string): Promise<void> {
    const args = [
      '-h',
      process.env.HOME_MQTT_HOST || process.env.MQTT_HOST || 'localhost',
      '-p',
      process.env.HOME_MQTT_PORT || process.env.MQTT_PORT || '1883',
      '-t',
      topic,
      '-m',
      payload,
    ];
    if (process.env.HOME_MQTT_USERNAME)
      args.push('-u', process.env.HOME_MQTT_USERNAME);
    if (process.env.HOME_MQTT_PASSWORD)
      args.push('-P', process.env.HOME_MQTT_PASSWORD);

    try {
      await execFileAsync(
        process.env.HOME_MQTT_PUB_BIN || 'mosquitto_pub',
        args,
        {
          timeout: Number(process.env.HOME_DEVICE_WRITE_TIMEOUT_MS || 2500),
        },
      );
    } catch {
      throw new Error('MQTT command publication failed.');
    }
  }
}

function deviceSupportsAction(
  device: RegisteredDevice,
  action: DeviceCapabilityAction,
): boolean {
  return device.capabilities.some((capability) =>
    capability.actions.includes(action),
  );
}

function isDeviceAction(value: string): value is DeviceCapabilityAction {
  return [
    'turn_on',
    'turn_off',
    'read',
    'set_target_temperature',
    'set_mode',
    'set_flow_temperature',
    'open',
    'close',
    'capture',
    'analyze',
  ].includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
