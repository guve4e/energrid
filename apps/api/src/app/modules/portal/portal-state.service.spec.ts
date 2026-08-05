import { DeviceRegistryService } from '../devices/device-registry.service'
import { PortalStateService } from './portal-state.service'

describe('PortalStateService', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.PORTAL_KITCHEN_TEMP_C
    delete process.env.PORTAL_KITCHEN_TEMP_SOURCE
    delete process.env.VOICE_STT_PROVIDER
  })

  afterAll(() => {
    process.env = originalEnv
  })

  function createService() {
    return new PortalStateService(new DeviceRegistryService(), {
      getLastScan: () => [],
      getZones: () => [],
    } as never, {
      getDebugState: () => ({
        enabled: false,
        status: 'disabled',
        broker: { host: '127.0.0.1', port: '1883' },
        prefix: 'energrid/tenant-demo/site-home',
        subscriptions: ['energrid/tenant-demo/site-home/#'],
        legacyTemperatureTopics: [],
        recentMessages: [],
      }),
    } as never)
  }

  it('returns a demo portal state with kitchen temperature and voice config', () => {
    process.env.PORTAL_KITCHEN_TEMP_C = '23.7'
    process.env.PORTAL_KITCHEN_TEMP_SOURCE = 'valentin-sensor'
    process.env.VOICE_STT_PROVIDER = 'openai'

    const state = createService().getState()
    const kitchen = state.zones.find((zone) => zone.id === 'kitchen')
    const temp = kitchen?.sensors.find(
      (sensor) => sensor.id === 'kitchen_temperature',
    )

    expect(state.tenant.name).toBe('Energrid Demo')
    expect(state.site.name).toBe('Home')
    expect(temp?.value).toBe(23.7)
    expect(temp?.source).toBe('valentin-sensor')
    expect(state.voice.provider).toBe('openai')
    expect(state.bus.mqtt.status).toBe('disabled')
    expect(state.networkZones).toEqual([])
    expect(state.networkDevices).toEqual([])
  })

  it('falls back to null when configured temperature is not numeric', () => {
    process.env.PORTAL_KITCHEN_TEMP_C = 'not-a-number'

    const state = createService().getState()
    const temp = state.zones[0].sensors[0]

    expect(temp.value).toBeNull()
  })

  it('includes the device registry snapshot for the portal brain view', () => {
    process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES =
      'kitchen.light.wall.led:shellyplus1-cc7b5c0ea5f8:0,kitchen.light.island.led:shellyplus1-78ee4ccf5cf0:0,kitchen.light.cans:shellyplus1-78ee4ccf4268:0'

    const state = createService().getState()

    expect(state.deviceSummary.total).toBe(5)
    expect(state.deviceSummary.controllable).toBe(4)
    expect(state.deviceSummary.sensors).toBe(1)
    expect(state.deviceSummary.systems).toBe(5)
    expect(state.systems.map((system) => system.id)).toEqual(
      expect.arrayContaining([
        'floor_heating',
        'fan_coils',
        'refrigerator_inventory',
        'forecast_optimizer',
      ]),
    )
    expect(state.devices.map((device) => device.id)).toEqual(
      expect.arrayContaining([
        'kitchen_light',
        'kitchen.light.wall.led',
        'kitchen.light.island.led',
        'kitchen.light.cans',
        'kitchen_temperature',
      ]),
    )
  })
})
