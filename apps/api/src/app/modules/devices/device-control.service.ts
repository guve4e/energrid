import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  Injectable,
  ForbiddenException,
  NotFoundException,
  Inject,
  Optional,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeviceRegistryService } from './device-registry.service';
import { configuredPortalSite } from '../portal/portal-site-context';
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
import { ShellyRouteResolver } from './shelly-route.resolver';
import { DeviceLanDiscoveryService } from './device-lan-discovery.service';
import { SiteLocalShellyCommandExecutor } from './site-local-shelly-command.executor';
import { verifySiteLocalShellyCommandReadback } from './site-local-shelly-command-readback'
import { SiteLocalShellyCommandError } from './adapters/outbound/network/site-local-shelly-control.adapter'

const execFileAsync = promisify(execFile);
const virtualLabCommandAckTtlMs = 25_000;

export interface DeviceActionResult {
  deviceId: string;
  action: DeviceCapabilityAction;
  status: 'success' | 'pending' | 'failed';
  adapter: 'mqtt' | 'http' | 'virtual-lab' | 'simulated' | 'none';
  message: string;
  affectedDeviceIds: string[];
  command?: RegisteredDevice['state']['command'];
}

@Injectable()
export class DeviceControlService {
  private readonly activeShellyCommands = new Set<string>();

  private readonly http = new ShellyHttpControl();

  constructor(
    private readonly registry: DeviceRegistryService,
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment: DeviceEnrollmentService,
    @Optional() private readonly routes?: ShellyRouteResolver,
    @Optional() private readonly lanDiscovery?: DeviceLanDiscoveryService,
    @Optional() private readonly siteLocalCommands?: SiteLocalShellyCommandExecutor,
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
    const site = configuredPortalSite();
    if (!device)
      throw new NotFoundException(`Device ${deviceId} was not found.`);

    if (
      device.trustStatus !== 'approved' ||
      device.tenantId !== site.tenantId || device.siteId !== site.siteId
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
    const site = configuredPortalSite();
    if (seen.has(device.id))
      return 'Circular device group; no command was sent.';
    if (
      device.trustStatus !== 'approved' ||
      device.tenantId !== site.tenantId || device.siteId !== site.siteId
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
    if (['shelly-lan', 'shelly-discovered'].includes(device.adapter.driver) &&
      (binding.kind === 'shelly-switch' || binding.kind === 'shelly-virtual-lab' || binding.kind === 'shelly-http' || binding.kind === 'shelly-mqtt')) {
      if (this.activeShellyCommands.has(device.id)) {
        throw new ConflictException('A switch command is already running for this Shelly; wait for its result before retrying.');
      }
      this.activeShellyCommands.add(device.id);
      try {
        return await this.executeResolvedShellySwitch(device, on, action, binding);
      } finally {
        this.activeShellyCommands.delete(device.id);
      }
    }
    // Preserve already-authorized MQTT profiles that do not expose verified
    // site-owned LAN identity. The new scope resolver applies to Shelly-LAN
    // installations; it must not invent a LAN route for MQTT-native devices.
    if (binding.kind === 'generic-mqtt')
      return this.executeGenericMqttSwitch(device, on, action, binding.topic);
    if (binding.kind === 'shelly-mqtt' || binding.kind === 'shelly-http')
      return this.executeShellyRpc(device, on, action, binding);
    throw new ForbiddenException('This Shelly switch permission has no eligible authorized execution scope.');
  }

  /** Select HTTP or the remote observer from persisted site-owned identity and scope evidence. */
  private async executeResolvedShellySwitch(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
    binding: Extract<DeviceControlBinding, { kind: 'shelly-switch' | 'shelly-virtual-lab' | 'shelly-http' | 'shelly-mqtt' }>,
  ): Promise<DeviceActionResult> {
    if (!this.routes)
      throw new ServiceUnavailableException('Scope-authorized Shelly control is unavailable.')
    const site = configuredPortalSite()
    const target = await this.routes.resolveShellyControlTarget(device.id, site, undefined, true)
    if (target.physicalId !== binding.physicalId || target.component !== `switch:${binding.channel}`) {
      throw new ForbiddenException('The switch permission no longer matches the enrolled physical component.')
    }
    if (binding.kind === 'shelly-virtual-lab' && target.zone.collectionSource !== 'virtual-lab') {
      throw new ForbiddenException('The saved legacy route does not match this device’s authorized network scope.')
    }
    // A site-local observer is the active execution route for this target.
    // The legacy HTTP URL may be historical; endpoint, scope, observer and
    // command-route authorization are resolved and revalidated separately.
    if (binding.kind === 'shelly-http' && !target.siteLocalObserver) {
      const configured = new URL(binding.baseUrl)
      if ((target.zone.collectionSource ?? 'local') !== 'local' || configured.hostname !== target.ipAddress || (configured.port && configured.port !== '80')) {
        throw new ForbiddenException('The saved legacy HTTP route differs from the verified endpoint and scope.')
      }
    }

    if (target.siteLocalObserver) {
      if (!this.siteLocalCommands) throw new ServiceUnavailableException('The authorized site-local Shelly command adapter is unavailable.')
      const command = this.registry.markDeviceCommandPending(device.id, {
        action, expectedValues: { on }, ttlMs: virtualLabCommandAckTtlMs,
        message: `Requesting ${action} through the separately authorized site-local Shelly route.`,
        actor: { type: 'user', id: 'portal-installer', name: 'Portal installer' },
      })
      try {
        const result = await this.siteLocalCommands.execute({
          scopeId: target.zone.id, observerId: target.siteLocalObserver.id,
          tenantId: site.tenantId, siteId: site.siteId, physicalId: target.physicalId,
          ipAddress: target.ipAddress, component: target.component,
          expectedComponentKeys: target.inventory.components.map(item => item.key).filter(key => /^switch:\d+$/.test(key)), on,
        })
        if (result.writeAttempted) {
          this.registry.markDeviceCommandPublished(device.id, command.id, { adapter: 'site-local-ssh-http-rpc' })
        }
        const readback = verifySiteLocalShellyCommandReadback(result, {
          physicalId: target.physicalId,
          component: target.component,
          expectedComponentKeys: target.inventory.components.map(item => item.key),
          requestedOn: on,
        })
        if (!readback) {
          const uncertain = result.writeAttempted
          const message = 'The site-local Shelly command could not be confirmed with fresh matching identity, component, and status evidence.'
          if (!uncertain) this.registry.markDeviceCommandFailed(device.id, command.id, 'pre_write', message)
          return { deviceId: device.id, action, status: uncertain ? 'pending' : 'failed', adapter: 'http',
            message: uncertain ? `${message} Check the device state before retrying.` : message,
            affectedDeviceIds: uncertain ? [device.id] : [], command: this.findDevice(device.id)?.state.command || command }
        }
        // A well-formed but mismatching readback is real state and is ingested;
        // transport success alone never settles the command.
        const { observedAt, confirmed } = readback
        const values = { on: readback.on }
        const source = `site-local-http-rpc:${target.siteLocalObserver.id}`
        this.registry.ingestDeviceTelemetry({
          id: device.id, deviceId: device.id, tenantId: site.tenantId, siteId: site.siteId,
          displayName: device.displayName, protocol: 'http', transport: 'http', driver: 'shelly-lan',
          target: `http://${target.ipAddress}/rpc/Switch.GetStatus?id=${target.channel}`, location: device.zoneName,
          capabilities: device.capabilities.map(item => item.kind), values,
          state: { values, source, status: 'online', observedAt }, observedAt,
        })
        this.registry.recordObserverReachability(device.id, {
          status: 'reachable', checkedAt: observedAt,
          endpoint: `http://${target.ipAddress}/rpc/Switch.GetStatus?id=${target.channel}`,
          targetIpAddress: target.ipAddress, networkScopeId: target.zone.id,
          observer: { id: target.siteLocalObserver.id, host: target.siteLocalObserver.host, platform: 'docker', localScopes: [] },
        })
        const settledCommand = confirmed ? (this.findDevice(device.id)?.state.command || command) :
          (this.registry.markDeviceCommandFailed(
            device.id, command.id, 'readback_mismatch',
            `Shelly switch readback was ${values.on ? 'ON' : 'OFF'}, not the requested state.`,
          ) || this.findDevice(device.id)?.state.command || command)
        return { deviceId: device.id, action, status: confirmed ? 'success' : 'failed', adapter: 'http',
          message: confirmed ? `Switch:${target.channel} ${on ? 'ON' : 'OFF'} confirmed by a fresh Shelly status read.`
            : `The Shelly reported ${values.on ? 'ON' : 'OFF'} after the ${on ? 'ON' : 'OFF'} request.`,
          affectedDeviceIds: [device.id], command: settledCommand }
      } catch (error) {
        const uncertain = error instanceof SiteLocalShellyCommandError && error.writeMayHaveBeenSent
        const message = uncertain
          ? 'The site-local command may have reached the Shelly, but fresh readback was not received. Check the current state before retrying.'
          : error instanceof Error ? error.message : 'The site-local Shelly command failed before execution.'
        if (!uncertain) this.registry.markDeviceCommandFailed(device.id, command.id, 'pre_write', message)
        return { deviceId: device.id, action, status: uncertain ? 'pending' : 'failed', adapter: 'http',
          message, affectedDeviceIds: uncertain ? [device.id] : [], command: this.findDevice(device.id)?.state.command || command }
      }
    }

    if (target.zone.collectionSource === 'local') {
      const route = {
        kind: 'shelly-http' as const,
        enabled: true,
        physicalId: target.physicalId,
        channel: target.channel,
        baseUrl: `http://${target.ipAddress}`,
        ...(binding.kind === 'shelly-http' && binding.credentialRef ? { credentialRef: binding.credentialRef } : {}),
      }
      return this.executeShellyRpc(device, on, action, route)
    }
    if (target.zone.collectionSource !== 'virtual-lab') {
      throw new ForbiddenException('No authorized Shelly execution transport is configured for this network scope.')
    }
    if (!this.lanDiscovery)
      throw new ServiceUnavailableException('The authorized remote Shelly execution adapter is unavailable.')

    const command = this.registry.markDeviceCommandPending(device.id, {
      action, expectedValues: { on },
      ttlMs: virtualLabCommandAckTtlMs,
      message: `Requesting ${action} through the resolved site-authorized Shelly route.`,
      actor: { type: 'user', id: 'portal-installer', name: 'Portal installer' },
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 22_000)
    try {
      const result = await this.lanDiscovery.executeVirtualLabSwitchControl(
        target.zone.id, target.ipAddress, target.physicalId, target.channel, on, controller.signal,
      )
      this.registry.markDeviceCommandPublished(device.id, command.id, { adapter: 'virtual-lab-http-rpc' })
      const observedAt = result.observedAt
      const observedTime = observedAt ? Date.parse(observedAt) : Number.NaN
      const fresh = Number.isFinite(observedTime) && observedTime <= Date.now() + 60_000 && Date.now() - observedTime <= 15 * 60_000
      if (result.acknowledged && typeof result.output === 'boolean' && fresh) {
        const values = { on: result.output }
        const source = `site-local-http-rpc:${result.observer.id}`
        this.registry.ingestDeviceTelemetry({
          id: device.id, deviceId: device.id, tenantId: site.tenantId, siteId: site.siteId,
          displayName: device.displayName, protocol: 'http', transport: 'http', driver: 'shelly-lan',
          target: `http://${target.ipAddress}/rpc/Switch.GetStatus?id=${target.channel}`, location: device.zoneName,
          capabilities: device.capabilities.map(item => item.kind), values,
          state: { values, source, status: 'online', observedAt }, observedAt,
        })
        this.registry.recordObserverReachability(device.id, {
          status: 'reachable', checkedAt: observedAt!,
          endpoint: `http://${target.ipAddress}/rpc/Switch.GetStatus?id=${target.channel}`, targetIpAddress: target.ipAddress,
          networkScopeId: target.zone.id,
          observer: { id: result.observer.id, host: result.observer.host, platform: 'docker', localScopes: [] },
        })
        const confirmed = result.output === on
        return {
          deviceId: device.id, action, status: confirmed ? 'success' : 'failed', adapter: 'virtual-lab',
          message: confirmed
            ? `Switch:${target.channel} ${on ? 'ON' : 'OFF'} confirmed by a fresh Shelly status read.`
            : `The Shelly reported ${result.output ? 'ON' : 'OFF'} after the ${on ? 'ON' : 'OFF'} request.`,
          affectedDeviceIds: [device.id], command: this.findDevice(device.id)?.state.command || command,
        }
      }
      return {
        deviceId: device.id, action, status: 'pending', adapter: 'virtual-lab',
        message: result.acknowledged
          ? 'The command was acknowledged, but a fresh Shelly state read was unavailable. Check the displayed state before retrying.'
          : 'The remote command outcome is unconfirmed. Check the displayed state before retrying.',
        affectedDeviceIds: [device.id], command: this.findDevice(device.id)?.state.command || command,
      }
    } catch {
      // A Docker/SSH timeout can happen after Switch.Set reached the device.
      // Keep the result pending and never claim failure or success without read-back.
      return {
        deviceId: device.id, action, status: 'pending', adapter: 'virtual-lab',
        message: 'The Virtual Lab result could not be confirmed. Check the Shelly state before retrying.',
        affectedDeviceIds: [device.id], command: this.findDevice(device.id)?.state.command || command,
      }
    } finally {
      clearTimeout(timeout)
    }
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

      const failedCommand = this.findDevice(device.id)?.state.command || command;

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

      const failedCommand = this.findDevice(device.id)?.state.command || command;

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
