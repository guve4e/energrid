import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DeviceRegistryService } from './device-registry.service'
import type {
  DeviceCapabilityAction,
  RegisteredDevice,
} from './device-registry.types'

const execFileAsync = promisify(execFile)

export interface DeviceActionResult {
  deviceId: string
  action: DeviceCapabilityAction
  status: 'success' | 'pending' | 'failed'
  adapter: 'mqtt' | 'http' | 'simulated' | 'none'
  message: string
  affectedDeviceIds: string[]
  command?: RegisteredDevice['state']['command']
}

@Injectable()
export class DeviceControlService {
  private readonly logger = new Logger(DeviceControlService.name)

  constructor(private readonly registry: DeviceRegistryService) {}

  async execute(
    deviceId: string,
    action: DeviceCapabilityAction | string | undefined,
  ): Promise<DeviceActionResult> {
    if (!action) throw new BadRequestException('Missing device action.')
    if (!isDeviceAction(action)) {
      throw new BadRequestException(`Unsupported device action ${action}.`)
    }

    const device = this.findDevice(deviceId)
    if (!device) throw new NotFoundException(`Device ${deviceId} was not found.`)

    if (!deviceSupportsAction(device, action)) {
      throw new BadRequestException(
        `${device.displayName} does not expose ${action}.`,
      )
    }

    if (action !== 'turn_on' && action !== 'turn_off') {
      throw new BadRequestException(
        `${action} is recognized but is not wired to a control adapter yet.`,
      )
    }

    return this.executeBinarySwitch(device, action === 'turn_on', action)
  }

  private async executeBinarySwitch(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
  ): Promise<DeviceActionResult> {
    if (device.memberDeviceIds?.length) {
      return this.executeMemberSwitches(device, on, action)
    }

    if (device.adapter.protocol === 'simulated') {
      this.registry.ingestDeviceTelemetry({
        deviceId: device.id,
        values: { on },
        observedAt: new Date().toISOString(),
        origin: 'simulated-control',
      })

      return {
        deviceId: device.id,
        action,
        status: 'success',
        adapter: 'simulated',
        message: `${device.displayName} set ${on ? 'on' : 'off'} in simulation.`,
        affectedDeviceIds: [device.id],
      }
    }

    if (!device.adapter.configured) {
      return {
        deviceId: device.id,
        action,
        status: 'failed',
        adapter: 'none',
        message: 'Device adapter is not configured.',
        affectedDeviceIds: [],
      }
    }

    if (isShellyRpcDevice(device)) {
      return this.executeShellyRpc(device, on, action)
    }

    if (device.adapter.commandTopic || device.adapter.target) {
      return this.executeGenericMqttSwitch(device, on, action)
    }

    return {
      deviceId: device.id,
      action,
      status: 'failed',
      adapter: 'none',
      message: `No control adapter for ${device.adapter.driver}.`,
      affectedDeviceIds: [],
    }
  }

  private async executeMemberSwitches(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
  ): Promise<DeviceActionResult> {
    const members = device.memberDeviceIds
      ?.map((id) => this.findDevice(id))
      .filter((member): member is RegisteredDevice => !!member) || []
    const switchMembers = members.filter((member) =>
      deviceSupportsAction(member, action),
    )

    if (switchMembers.length === 0) {
      return {
        deviceId: device.id,
        action,
        status: 'failed',
        adapter: 'none',
        message: 'Logical device has no controllable switch members.',
        affectedDeviceIds: [],
      }
    }

    const results = await Promise.all(
      switchMembers.map((member) => this.executeBinarySwitch(member, on, action)),
    )
    const failed = results.filter((result) => result.status === 'failed')
    const pending = results.filter((result) => result.status === 'pending')
    const affected = results.flatMap((result) => result.affectedDeviceIds)

    return {
      deviceId: device.id,
      action,
      status: failed.length > 0 ? 'failed' : pending.length > 0 ? 'pending' : 'success',
      adapter: results.some((result) => result.adapter === 'mqtt') ? 'mqtt' : 'none',
      message:
        failed.length > 0
          ? `${failed.length} member switch command(s) failed.`
          : pending.length > 0
            ? `${affected.length} member switch command(s) sent; waiting for acknowledgement.`
            : `${affected.length} member switch command(s) confirmed.`,
      affectedDeviceIds: affected,
    }
  }

  private async executeShellyRpc(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
  ): Promise<DeviceActionResult> {
    const topic = process.env.HOME_SHELLY_RPC_TOPIC || 'shelly/rpc'
    const dst =
      stringMetadata(device, 'dst') ||
      stringMetadata(device, 'physicalId') ||
      stringMetadata(device, 'hardwareId') ||
      device.adapter.target
    const switchId =
      numberMetadata(device, 'switchId') ?? numberMetadata(device, 'channel') ?? 0

    if (!dst) {
      return {
        deviceId: device.id,
        action,
        status: 'failed',
        adapter: 'mqtt',
        message: 'Shelly RPC destination is missing.',
        affectedDeviceIds: [],
      }
    }

    const payload = JSON.stringify({
      id: Date.now(),
      src: process.env.HOME_SHELLY_RPC_SRC || 'energrid-api',
      dst,
      method: 'Switch.Set',
      params: { id: switchId, on },
    })

    try {
      await this.publishMqtt(topic, payload)
      const command = this.registry.markDeviceCommandPending(device.id, {
        action,
        expectedValues: { on },
        message: `Published Shelly ${action}; waiting for telemetry.`,
      })
      this.logger.log(
        `[DEVICE ACTION SHELLY RPC] ${device.id} ${action} topic=${topic} dst=${dst} switch=${switchId}`,
      )

      return {
        deviceId: device.id,
        action,
        status: 'pending',
        adapter: 'mqtt',
        message: `Published Shelly ${action} to ${dst} switch ${switchId}; waiting for acknowledgement.`,
        affectedDeviceIds: [device.id],
        command,
      }
    } catch (error) {
      const message = errorMessage(error)
      const command = this.registry.markDeviceCommandFailed(device.id, {
        action,
        expectedValues: { on },
        message,
      })
      this.logger.warn(
        `[DEVICE ACTION SHELLY RPC FAILED] ${device.id} ${action} ${message}`,
      )

      return {
        deviceId: device.id,
        action,
        status: 'failed',
        adapter: 'mqtt',
        message,
        affectedDeviceIds: [],
        command,
      }
    }
  }

  private async executeGenericMqttSwitch(
    device: RegisteredDevice,
    on: boolean,
    action: DeviceCapabilityAction,
  ): Promise<DeviceActionResult> {
    const topic = device.adapter.commandTopic || device.adapter.target
    if (!topic) {
      return {
        deviceId: device.id,
        action,
        status: 'failed',
        adapter: 'mqtt',
        message: 'MQTT command topic is missing.',
        affectedDeviceIds: [],
      }
    }

    const payload = JSON.stringify({
      action,
      on,
      deviceId: device.id,
      observedAt: new Date().toISOString(),
    })

    try {
      await this.publishMqtt(topic, payload)
      const command = this.registry.markDeviceCommandPending(device.id, {
        action,
        expectedValues: { on },
        message: `Published ${action}; waiting for telemetry.`,
      })

      return {
        deviceId: device.id,
        action,
        status: 'pending',
        adapter: 'mqtt',
        message: `Published ${action} to ${topic}; waiting for acknowledgement.`,
        affectedDeviceIds: [device.id],
        command,
      }
    } catch (error) {
      const message = errorMessage(error)
      const command = this.registry.markDeviceCommandFailed(device.id, {
        action,
        expectedValues: { on },
        message,
      })
      return {
        deviceId: device.id,
        action,
        status: 'failed',
        adapter: 'mqtt',
        message,
        affectedDeviceIds: [],
        command,
      }
    }
  }

  private findDevice(deviceId: string): RegisteredDevice | null {
    return (
      this.registry.getDevices().find((device) => device.id === deviceId) || null
    )
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
    ]
    if (process.env.HOME_MQTT_USERNAME) args.push('-u', process.env.HOME_MQTT_USERNAME)
    if (process.env.HOME_MQTT_PASSWORD) args.push('-P', process.env.HOME_MQTT_PASSWORD)

    await execFileAsync(process.env.HOME_MQTT_PUB_BIN || 'mosquitto_pub', args, {
      timeout: Number(process.env.HOME_DEVICE_WRITE_TIMEOUT_MS || 2500),
    })
  }
}

function deviceSupportsAction(
  device: RegisteredDevice,
  action: DeviceCapabilityAction,
): boolean {
  return device.capabilities.some((capability) =>
    capability.actions.includes(action),
  )
}

function isShellyRpcDevice(device: RegisteredDevice): boolean {
  return (
    device.adapter.driver.includes('shelly') ||
    !!stringMetadata(device, 'dst') ||
    !!stringMetadata(device, 'physicalId') ||
    !!stringMetadata(device, 'hardwareId')
  )
}

function stringMetadata(device: RegisteredDevice, key: string): string | undefined {
  const value = device.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberMetadata(device: RegisteredDevice, key: string): number | undefined {
  const value = device.metadata?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
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
  ].includes(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
