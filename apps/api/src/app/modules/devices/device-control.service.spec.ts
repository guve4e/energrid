import { BadRequestException } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { DeviceControlService } from './device-control.service'
import { DeviceRegistryService } from './device-registry.service'

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_command, _args, _options, callback) => {
    callback(null, { stdout: '', stderr: '' })
  }),
}))

describe('DeviceControlService', () => {
  const originalEnv = process.env
  const execFileMock = jest.mocked(execFile)

  beforeEach(() => {
    execFileMock.mockClear()
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' })
      return {} as ReturnType<typeof execFile>
    })
    process.env = { ...originalEnv }
    delete process.env.HOME_APPROVED_DEVICES_JSON
    delete process.env.HOME_SHELLY_RPC_TOPIC
    delete process.env.HOME_MQTT_HOST
    delete process.env.HOME_MQTT_PORT
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('publishes Shelly RPC for a switch-capable logical device', async () => {
    process.env.HOME_MQTT_HOST = '192.168.1.6'
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify([
      {
        deviceId: 'kitchen.island.light',
        name: 'Kitchen island light',
        kind: 'physical',
        origin: 'shelly',
        protocol: 'mqtt',
        transport: 'mqtt',
        driver: 'shelly-rpc',
        target: 'shellyplus1-78ee4ccf5cf0',
        location: 'kitchen',
        physicalId: 'shellyplus1-78ee4ccf5cf0',
        channel: 0,
        capabilities: ['switch'],
      },
    ])

    const service = new DeviceControlService(new DeviceRegistryService())

    const result = await service.execute('kitchen.island.light', 'turn_on')

    expect(result).toEqual(
      expect.objectContaining({
        status: 'success',
        adapter: 'mqtt',
        affectedDeviceIds: ['kitchen.island.light'],
      }),
    )
    expect(execFileMock).toHaveBeenCalledWith(
      'mosquitto_pub',
      expect.arrayContaining([
        '-h',
        '192.168.1.6',
        '-t',
        'shelly/rpc',
        '-m',
        expect.stringContaining('"method":"Switch.Set"'),
      ]),
      expect.any(Object),
      expect.any(Function),
    )
    const args = execFileMock.mock.calls[0]?.[1] as string[]
    const payload = JSON.parse(args[args.indexOf('-m') + 1])
    expect(payload).toEqual(
      expect.objectContaining({
        dst: 'shellyplus1-78ee4ccf5cf0',
        method: 'Switch.Set',
        params: { id: 0, on: true },
      }),
    )
  })

  it('does not expose switching for a read-only meter channel', async () => {
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify([
      {
        deviceId: 'panel.mainline.energy',
        name: 'Whole house mainline',
        kind: 'physical',
        origin: 'shelly',
        protocol: 'mqtt',
        transport: 'mqtt',
        driver: 'shelly-pro-em',
        target: 'shelly/mainline@water-pump',
        location: 'panel',
        physicalId: 'shellyproem50-8c4f00dbd258',
        hardwareId: 'shellyproem50-8c4f00dbd258',
        channel: 0,
        channelName: 'mainline',
        component: 'em:0',
        capabilities: ['power'],
        values: { power: 376.2 },
      },
    ])

    const service = new DeviceControlService(new DeviceRegistryService())

    await expect(
      service.execute('panel.mainline.energy', 'turn_off'),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
