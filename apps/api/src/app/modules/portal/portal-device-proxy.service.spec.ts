import { GoneException } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { PortalController } from './portal.controller'
import { PortalDeviceProxyService } from './portal-device-proxy.service'
import { AccessJwtGuard, RoleGuard } from '../auth/auth.guard'

describe('Portal device web proxy retirement', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each([
    ['unknown vendor GET command', 'cm', '/cm?cmnd=Power%20On', 'GET'],
    ['encoded command path', '%63m', '/%63m?cmnd=Power%20On', 'GET'],
    ['double-encoded command parameter', 'cm', '/cm?cmnd=Power%2520On', 'GET'],
    ['case-varied command path', 'CM', '/CM?CMND=POWER%20ON', 'GET'],
    ['redirect-shaped request', 'redirect', '/redirect', 'GET'],
    ['non-read method', 'relay/0', '/relay/0?turn=on', 'POST'],
  ])('never forwards %s to a device', async (_caseName, path, url, method) => {
    const fetch = jest.spyOn(global, 'fetch')
    const service = new PortalDeviceProxyService()

    await expect(Promise.resolve().then(() => service.proxy('device-id', path, {
      method,
      headers: {},
      url,
    }, {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      send: jest.fn(),
      end: jest.fn(),
    }))).rejects.toBeInstanceOf(GoneException)

    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the retired Portal route behind authenticated administrator guards', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PortalController))
      .toEqual([AccessJwtGuard, RoleGuard])
    expect(Reflect.getMetadata('energrid.auth.roles', PortalController))
      .toEqual(['admin'])
  })
})
