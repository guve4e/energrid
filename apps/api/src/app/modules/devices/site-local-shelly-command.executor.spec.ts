import { SiteLocalShellyCommandExecutor } from './site-local-shelly-command.executor'

const physicalId = 'shellyplus1-8813bfcdc8bc'
const owner = { tenantId: 'tenant-demo', siteId: 'site-home' }
const zone = { id: 'upstream-lan', name: 'Upstream LAN', cidr: '192.168.1.0/24', seedIps: ['192.168.1.1'] }
const observer = { id: 'pi-upstream-bathroom', host: 'pi', sshTarget: 'pi-housenet', interfaceName: 'eth0',
  ...owner, scopeId: zone.id, cidr: zone.cidr, expectedDeviceIds: [physicalId], expectedComponentKeys: ['switch:0'] }
const grant = { observerId: observer.id, ...owner, scopeId: zone.id, physicalId, component: 'switch:0' }
const request = { observerId: observer.id, ...owner, scopeId: zone.id, physicalId,
  ipAddress: '192.168.1.219', component: 'switch:0', expectedComponentKeys: ['switch:0'], on: true }

describe('site-local Shelly command executor', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, HOME_NETWORK_ZONES_JSON: JSON.stringify([zone]),
      HOME_SITE_LOCAL_OBSERVERS_JSON: JSON.stringify([observer]),
      HOME_SITE_LOCAL_SHELLY_CONTROL_ROUTES_JSON: JSON.stringify([grant]) }
  })
  afterEach(() => { process.env = originalEnv })

  function setup() {
    const adapter = { setSwitch: jest.fn().mockResolvedValue({ writeAttempted: true }) }
    const executor = new SiteLocalShellyCommandExecutor(adapter as never)
    return { adapter, executor }
  }

  it('dispatches only after matching configured scope, exact observer and separate command grant', async () => {
    const { adapter, executor } = setup()
    await expect(executor.execute(request)).resolves.toEqual({ writeAttempted: true })
    expect(adapter.setSwitch).toHaveBeenCalledTimes(1)
    expect(adapter.setSwitch).toHaveBeenCalledWith(expect.objectContaining({
      ...request, zone: expect.objectContaining({ id: zone.id, cidr: zone.cidr }),
      observer: expect.objectContaining({ id: observer.id }),
      route: expect.objectContaining({ physicalId, component: 'switch:0' }),
    }))
  })

  it('does not dispatch with read-only observer permission but no command route', async () => {
    process.env.HOME_SITE_LOCAL_SHELLY_CONTROL_ROUTES_JSON = '[]'
    const { adapter, executor } = setup()
    await expect(executor.execute(request)).rejects.toThrow('No separately authorized site-local Shelly command route')
    expect(adapter.setSwitch).not.toHaveBeenCalled()
  })

  it('does not dispatch to the wrong site or component', async () => {
    const { adapter, executor } = setup()
    await expect(executor.execute({ ...request, siteId: 'site-other' })).rejects.toThrow()
    await expect(executor.execute({ ...request, component: 'switch:1', expectedComponentKeys: ['switch:1'] })).rejects.toThrow()
    expect(adapter.setSwitch).not.toHaveBeenCalled()
  })

  it('does not dispatch if scope, endpoint or selected observer differs from the active assignment', async () => {
    const { adapter, executor } = setup()
    await expect(executor.execute({ ...request, ipAddress: '192.168.7.39' })).rejects.toThrow()
    await expect(executor.execute({ ...request, observerId: 'another-observer' })).rejects.toThrow()
    await expect(executor.execute({ ...request, scopeId: 'eero-lan' })).rejects.toThrow()
    expect(adapter.setSwitch).not.toHaveBeenCalled()
  })

  it('fails closed on competing observer assignments for the same component', async () => {
    process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = JSON.stringify([
      observer, { ...observer, id: 'pi-upstream-duplicate' },
    ])
    const { adapter, executor } = setup()
    await expect(executor.execute(request)).rejects.toThrow()
    expect(adapter.setSwitch).not.toHaveBeenCalled()
  })

  it('rejects a route targeting a virtual-lab network', async () => {
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify([{ ...zone, collectionSource: 'virtual-lab' }])
    process.env.HOME_VIRTUAL_LAB_ENABLED = 'true'
    const { adapter, executor } = setup()
    await expect(executor.execute(request)).rejects.toThrow('No configured site-local scope')
    expect(adapter.setSwitch).not.toHaveBeenCalled()
  })
})
