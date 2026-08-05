import { DeviceHttpPollService } from './device-http-poll.service'
import { DeviceRegistryService } from './device-registry.service'

describe('DeviceHttpPollService', () => {
  const originalEnv = process.env
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.PORTAL_TENANT_ID = 'valentin'
    process.env.PORTAL_SITE_ID = 'boyana-home'
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'kitchen.temperature.http',
          name: 'Kitchen temperature HTTP sensor',
          protocol: 'http',
          transport: 'http',
          driver: 'http-json-sensor',
          target: 'http://127.0.0.1:8088/status',
          location: 'Kitchen',
          capabilities: ['temperature', 'humidity'],
          values: { temperature: 22.4, humidity: 48 },
        },
      ],
    })
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
  })

  it('polls approved HTTP devices into live registry state', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        values: {
          temperature: 23.2,
          humidity: 47.4,
        },
      }),
    } as Response) as unknown as typeof fetch

    const registry = new DeviceRegistryService()
    const poller = new DeviceHttpPollService(registry)

    await poller.pollOnce()

    const device = registry
      .getSnapshot()
      .devices.find((item) => item.id === 'kitchen.temperature.http')

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8088/status',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    )
    expect(device?.state).toEqual(
      expect.objectContaining({
        values: { temperature: 23.2, humidity: 47.4 },
        source: 'http-poll',
        status: 'online',
      }),
    )
  })

  it('marks HTTP devices offline when polling fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    } as Response) as unknown as typeof fetch

    const registry = new DeviceRegistryService()
    const poller = new DeviceHttpPollService(registry)

    await poller.pollOnce()

    const device = registry
      .getSnapshot()
      .devices.find((item) => item.id === 'kitchen.temperature.http')

    expect(device?.state.status).toBe('offline')
  })
})
