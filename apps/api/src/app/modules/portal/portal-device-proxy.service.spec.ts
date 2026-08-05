import { HttpException } from '@nestjs/common'
import { PortalDeviceProxyService } from './portal-device-proxy.service'
import type { NetworkDiscoveredDevice } from '../devices/device-registry.types'

describe('PortalDeviceProxyService', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  function createService(devices: NetworkDiscoveredDevice[]) {
    return new PortalDeviceProxyService({
      getLastScan: () => devices,
    } as never)
  }

  function device(overrides: Partial<NetworkDiscoveredDevice> = {}): NetworkDiscoveredDevice {
    return {
      id: 'shellyplus1-test',
      ipAddress: '192.168.7.51',
      networkZoneId: 'local-lan',
      networkZoneName: 'Local LAN',
      protocol: 'http',
      confidence: 0.9,
      status: 'online',
      discoveredAt: new Date().toISOString(),
      reason: 'test',
      ...overrides,
    }
  }

  function responseMock() {
    return {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      send: jest.fn(),
      end: jest.fn(),
    }
  }

  it('blocks devices outside the latest discovery scan', async () => {
    const service = createService([])

    await expect(
      service.proxy('missing-device', '/', { method: 'GET', headers: {}, url: '/' } as never, responseMock() as never),
    ).rejects.toBeInstanceOf(HttpException)
  })

  it('blocks non-private addresses', async () => {
    const service = createService([device({ ipAddress: '8.8.8.8' })])

    await expect(
      service.proxy('shellyplus1-test', '/', { method: 'GET', headers: {}, url: '/' } as never, responseMock() as never),
    ).rejects.toBeInstanceOf(HttpException)
  })

  it('proxies a discovered private device and rewrites html base', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('<html><head><title>Shelly</title></head><body>OK</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const res = responseMock()
    const service = createService([device()])

    await service.proxy('shellyplus1-test', '/', { method: 'GET', headers: {}, url: '/' } as never, res as never)

    expect(global.fetch).toHaveBeenCalledWith(
      new URL('http://192.168.7.51/'),
      expect.objectContaining({ method: 'GET' }),
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('<base href="/portal/device-proxy/shellyplus1-test/">'),
    )
  })

  it('blocks writes unless installer proxy write mode is enabled', async () => {
    const service = createService([device()])

    await expect(
      service.proxy('shellyplus1-test', '/', { method: 'POST', headers: {}, url: '/' } as never, responseMock() as never),
    ).rejects.toBeInstanceOf(HttpException)
  })
})
