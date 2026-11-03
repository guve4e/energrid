import { configuredSiteLocalShellyControlRoutes, selectSiteLocalShellyControlRoute } from './site-local-shelly-control-route'

const route = {
  observerId: 'pi-upstream-bathroom', tenantId: 'tenant-demo', siteId: 'site-home',
  scopeId: 'upstream-lan', physicalId: 'shellyplus1-8813bfcdc8bc', component: 'switch:0',
}
const observer = {
  id: route.observerId, host: 'pi', tenantId: route.tenantId, siteId: route.siteId,
  scopeId: route.scopeId, cidr: '192.168.1.0/24', expectedDeviceIds: [route.physicalId],
  expectedComponentKeys: ['switch:0'], sshTarget: 'pi-housenet', interfaceName: 'eth0',
}

describe('site-local Shelly command route', () => {
  it('accepts a separately configured exact observer/site/scope/device/component grant', () => {
    const routes = configuredSiteLocalShellyControlRoutes(JSON.stringify([route]))
    expect(selectSiteLocalShellyControlRoute({ routes, observer, ...route })).toEqual(route)
  })

  it.each([
    { siteId: 'site-other' },
    { scopeId: 'eero-lan' },
    { physicalId: 'shellyplus1-other' },
    { component: 'switch:1' },
    { observer: { ...observer, id: 'another-observer' } },
  ])('fails closed when the exact authorization tuple differs', changed => {
    const routes = configuredSiteLocalShellyControlRoutes(JSON.stringify([route]))
    expect(selectSiteLocalShellyControlRoute({ routes, observer, tenantId: 'tenant-demo', siteId: 'site-home',
      scopeId: 'upstream-lan', physicalId: route.physicalId, component: 'switch:0', ...changed })).toBeNull()
  })

  it.each([
    [{ ...route, component: 'em1:0' }],
    [{ ...route, component: 'switch:*' }],
    [route, route],
  ])('rejects malformed or duplicate command grants', value => {
    expect(() => configuredSiteLocalShellyControlRoutes(JSON.stringify(value))).toThrow()
  })

  it('grants no control when configuration is absent', () => {
    expect(configuredSiteLocalShellyControlRoutes('')).toEqual([])
    expect(selectSiteLocalShellyControlRoute({ routes: [], observer, ...route })).toBeNull()
  })
})
