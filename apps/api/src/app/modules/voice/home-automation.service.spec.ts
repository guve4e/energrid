import { execFile } from 'node:child_process'
import { DeviceControlService } from '../devices/device-control.service'
import { DeviceRegistryService } from '../devices/device-registry.service'
import { HomeAutomationService } from './home-automation.service'

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_command, _args, _options, callback) => {
    callback(null, { stdout: '', stderr: '' })
  }),
}))

describe('HomeAutomationService', () => {
  const originalEnv = process.env
  const execFileMock = jest.mocked(execFile)

  function createService() {
    const registry = new DeviceRegistryService()
    return new HomeAutomationService(registry, new DeviceControlService(registry))
  }

  beforeEach(() => {
    execFileMock.mockClear()
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' })
      return {} as ReturnType<typeof execFile>
    })

    process.env = { ...originalEnv }
    delete process.env.HOME_AVAILABLE_DEVICES
    delete process.env.HOME_KITCHEN_LIGHT_ON_URL
    delete process.env.HOME_KITCHEN_LIGHT_OFF_URL
    delete process.env.HOME_KITCHEN_LIGHT_MQTT_TOPIC
    delete process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES
    delete process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC
    delete process.env.HOME_KITCHEN_TEMP_JSON_PATH
    delete process.env.HOME_MQTT_HOST
    delete process.env.HOME_MQTT_PORT
    delete process.env.HOME_APPROVED_DEVICES_JSON
    delete process.env.PORTAL_KITCHEN_TEMP_C
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('builds home context from configured temperature and devices', async () => {
    process.env.PORTAL_KITCHEN_TEMP_C = '24.5'
    process.env.HOME_AVAILABLE_DEVICES = 'kitchen_light,kitchen_temperature'

    const service = createService()
    const context = await service.getHomeContext()

    expect(context.insideTempC).toBe(24.5)
    expect(context.availableDevices).toEqual([
      'kitchen_light',
      'kitchen_temperature',
    ])
  })

  it('uses simulated light execution when no real adapter is configured', async () => {
    const service = createService()

    const results = await service.executePlan({
      intent: 'turn_on_lights',
      requiresConfirmation: false,
      spokenReply: 'Включвам лампите.',
      actions: [
        {
          type: 'light.turn_on',
          deviceId: 'kitchen_light',
          risk: 'safe',
          reason: 'test',
        },
      ],
    })

    expect(results).toEqual([
      expect.objectContaining({
        status: 'success',
        adapter: 'simulated',
      }),
    ])
  })

  it('fans kitchen light commands out to configured Shelly RPC devices', async () => {
    process.env.HOME_MQTT_HOST = '192.168.1.6'
    process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES =
      'kitchen.light.wall.led:shellyplus1-cc7b5c0ea5f8:0,kitchen.light.island.led:shellyplus1-78ee4ccf5cf0:0,kitchen.light.cans:shellyplus1-78ee4ccf4268:0'

    const service = createService()

    const results = await service.executePlan({
      intent: 'turn_on_lights',
      requiresConfirmation: false,
      spokenReply: 'Включвам лампите.',
      actions: [
        {
          type: 'light.turn_on',
          deviceId: 'kitchen_light',
          risk: 'safe',
          reason: 'test',
        },
      ],
    })

    expect(results).toEqual([
      expect.objectContaining({
        status: 'pending',
        adapter: 'mqtt',
        affected: [
          'kitchen.light.wall.led',
          'kitchen.light.island.led',
          'kitchen.light.cans',
        ],
      }),
    ])
    expect(execFileMock).toHaveBeenCalledTimes(3)
    expect(execFileMock).toHaveBeenCalledWith(
      'mosquitto_pub',
      expect.arrayContaining(['-h', '192.168.1.6', '-t', 'shelly/rpc']),
      expect.any(Object),
      expect.any(Function),
    )

    const publishedPayloads = execFileMock.mock.calls.map((call) => {
      const args = call[1] as string[]
      return JSON.parse(args[args.indexOf('-m') + 1])
    })

    expect(publishedPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dst: 'shellyplus1-cc7b5c0ea5f8',
          method: 'Switch.Set',
          params: { id: 0, on: true },
        }),
        expect.objectContaining({
          dst: 'shellyplus1-78ee4ccf5cf0',
          method: 'Switch.Set',
          params: { id: 0, on: true },
        }),
        expect.objectContaining({
          dst: 'shellyplus1-78ee4ccf4268',
          method: 'Switch.Set',
          params: { id: 0, on: true },
        }),
      ]),
    )
  })

  it('executes a requested bathroom light through the approved logical device', async () => {
    process.env.HOME_MQTT_HOST = '192.168.1.6'
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'bath.light.led',
          origin: 'shelly',
          physicalId: 'shellyplus1-bathroom',
          channel: 0,
          groups: ['bath.lights'],
          aliases: ['bathroom lights', 'лампи в банята'],
        },
      ],
    })

    const service = createService()

    const results = await service.executePlan({
      intent: 'turn_on_lights',
      requiresConfirmation: false,
      spokenReply: 'Включвам лампите.',
      actions: [
        {
          type: 'light.turn_on',
          deviceId: 'bath_light',
          room: 'баня',
          risk: 'safe',
          reason: 'test',
        },
      ],
    })

    expect(results).toEqual([
      expect.objectContaining({
        status: 'pending',
        adapter: 'mqtt',
        affected: ['bath.light.led'],
      }),
    ])

    const args = execFileMock.mock.calls[0]?.[1] as string[]
    const payload = JSON.parse(args[args.indexOf('-m') + 1])
    expect(payload).toEqual(
      expect.objectContaining({
        dst: 'shellyplus1-bathroom',
        method: 'Switch.Set',
        params: { id: 0, on: true },
      }),
    )
  })

  it('reads kitchen temperature from an MQTT sensor payload', async () => {
    process.env.HOME_MQTT_HOST = '192.168.1.6'
    process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC = 'sensors/arduino/temp'
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, {
        stdout: '{"temperature":23.7,"humidity":45}',
        stderr: '',
      })
      return {} as ReturnType<typeof execFile>
    })

    const service = createService()
    const temperature = await service.getKitchenTemperature()

    expect(temperature).toBe(23.7)
    expect(execFileMock).toHaveBeenCalledWith(
      'mosquitto_sub',
      expect.arrayContaining([
        '-h',
        '192.168.1.6',
        '-t',
        'sensors/arduino/temp',
        '-C',
        '1',
      ]),
      expect.any(Object),
      expect.any(Function),
    )
  })
})
