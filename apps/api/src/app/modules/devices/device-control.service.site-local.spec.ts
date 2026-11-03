import { DeviceControlService } from './device-control.service'
import { SiteLocalShellyCommandError } from './adapters/outbound/network/site-local-shelly-control.adapter'
import { runWithAuthorizedPortalSite } from '../portal/portal-site-context'
import type { RegisteredDevice } from './device-registry.types'

const physicalId = 'shellyplus1-8813bfcdc8bc'
const deviceId = `${physicalId}:switch:0`
const site = { tenantId: 'tenant-demo', siteId: 'site-home', siteName: 'Home', mode: 'home' as const }
const observer = { id: 'pi-upstream-bathroom', host: 'pi' }
const device: RegisteredDevice = {
  id: deviceId, tenantId: site.tenantId, siteId: site.siteId, siteName: site.siteName,
  displayName: 'Bathroom Shelly Plus 1', kind: 'physical', zoneId: 'bathroom', zoneName: 'Bathroom', trustStatus: 'approved',
  capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
  adapter: { id: 'shelly-lan', protocol: 'http', driver: 'shelly-discovered', configured: true, target: physicalId },
  metadata: { physicalId, component: 'switch:0', channel: 0, networkScope: 'upstream-lan:192.168.1.0/24' },
  state: { values: { on: false }, observedAt: null, source: 'saved', status: 'unknown' },
  control: { status: 'ready', reason: 'Explicit switching permission.', binding: { kind: 'shelly-switch', enabled: true, physicalId, channel: 0 } },
  assistantEnabled: false, policy: { requiresApproval: false, confirmationRequiredFor: [] },
  responseProfile: { confidence: 1, learningEnabled: false },
}

function setup(result?: Record<string, unknown>) {
  const inventory = { physicalDeviceId: 'dc565b3f-87ad-410c-9ae3-862d6b655c47', components: [{ key: 'switch:0' }] }
  const target = { device, inventory, physicalId, component: 'switch:0', channel: 0, ipAddress: '192.168.1.219',
    zone: { id: 'upstream-lan', cidr: '192.168.1.0/24', collectionSource: 'local' }, siteLocalObserver: observer }
  const registry = {
    getDevices: jest.fn(() => [device]),
    markDeviceCommandPending: jest.fn(() => ({ id: 'cmd-1', status: 'pending', requestedAt: new Date().toISOString(), expectedValues: { on: true } })),
    markDeviceCommandPublished: jest.fn(), markDeviceCommandFailed: jest.fn(),
    ingestDeviceTelemetry: jest.fn(), recordObserverReachability: jest.fn(),
  }
  const httpPoll = { resolveShellyControlTarget: jest.fn().mockResolvedValue(target) }
  const siteLocalCommands = { execute: jest.fn().mockResolvedValue(result) }
  const service = new DeviceControlService(registry as never, { find: async () => ({ status: 'enrolled' }) } as never,
    httpPoll as never, undefined, siteLocalCommands as never)
  return { service, registry, httpPoll, siteLocalCommands, target }
}

function result(output: boolean, identityId = physicalId) {
  return {
    identityBefore: { id: physicalId, gen: 2 }, identityAfter: { id: identityId, gen: 2 },
    componentKeys: ['switch:0'], statusBefore: { id: 0, output: !output }, statusAfter: { id: 0, output },
    acknowledgement: { was_on: !output }, observedAt: new Date().toISOString(),
    observer: { id: observer.id, host: observer.host, interfaceName: 'eth0', interfaceAddress: '192.168.1.6' },
    writeAttempted: true,
  }
}

describe('site-local Shelly manual control', () => {
  it.each([true, false])('settles only on fresh desired-state readback output=%s', async output => {
    const fixture = setup(result(output))
    const response = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, output ? 'turn_on' : 'turn_off'))
    expect(response).toMatchObject({ status: 'success', adapter: 'http' })
    expect(fixture.httpPoll.resolveShellyControlTarget).toHaveBeenCalledWith(deviceId, site, undefined, true)
    expect(fixture.siteLocalCommands.execute).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: site.tenantId, siteId: site.siteId, physicalId, ipAddress: '192.168.1.219', component: 'switch:0', on: output,
    }))
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      deviceId, values: { on: output }, tenantId: site.tenantId, siteId: site.siteId,
      state: expect.objectContaining({ values: { on: output }, status: 'online' }),
    }))
  })

  it('uses the authorized site-local route instead of a stale legacy HTTP URL', async () => {
    const fixture = setup(result(true))
    const legacyDevice: RegisteredDevice = {
      ...device,
      control: { ...device.control!, binding: {
        kind: 'shelly-http', enabled: true, physicalId, channel: 0, baseUrl: 'http://192.168.1.44',
      } },
    }
    fixture.registry.getDevices.mockReturnValue([legacyDevice])

    const response = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'))

    expect(response.status).toBe('success')
    expect(fixture.siteLocalCommands.execute).toHaveBeenCalledWith(expect.objectContaining({
      observerId: observer.id, ipAddress: '192.168.1.219', physicalId, component: 'switch:0', on: true,
    }))
  })

  it('still rejects a mismatched direct HTTP URL when no site-local observer route is resolved', async () => {
    const fixture = setup(result(true))
    const legacyDevice: RegisteredDevice = {
      ...device,
      control: { ...device.control!, binding: {
        kind: 'shelly-http', enabled: true, physicalId, channel: 0, baseUrl: 'http://192.168.1.44',
      } },
    }
    fixture.registry.getDevices.mockReturnValue([legacyDevice])
    fixture.httpPoll.resolveShellyControlTarget.mockResolvedValue({
      ...fixture.target, siteLocalObserver: undefined,
    } as never)

    await expect(runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on')))
      .rejects.toThrow('The saved legacy HTTP route differs from the verified endpoint and scope.')
    expect(fixture.siteLocalCommands.execute).not.toHaveBeenCalled()
    expect(fixture.registry.markDeviceCommandPending).not.toHaveBeenCalled()
  })

  it('ingests actual mismatching readback but marks the requested command failed', async () => {
    const fixture = setup(result(false))
    const response = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'))
    expect(response.status).toBe('failed')
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({ values: { on: false } }))
    expect(fixture.registry.markDeviceCommandFailed).toHaveBeenCalled()
  })

  it('does not record a command as published when identity validation fails before a write', async () => {
    const beforeWriteFailure = { ...result(false), writeAttempted: false, acknowledgement: null,
      statusAfter: null, failure: 'identity_mismatch' }
    const fixture = setup(beforeWriteFailure)
    const response = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_off'))
    expect(response.status).toBe('failed')
    expect(fixture.registry.markDeviceCommandPublished).not.toHaveBeenCalled()
    expect(fixture.registry.markDeviceCommandFailed).toHaveBeenCalled()
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
  })

  it('does not settle after an identity mismatch and leaves a post-write outcome pending', async () => {
    const fixture = setup(result(true, 'shellyplus1-000000000000'))
    const response = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'))
    expect(response.status).toBe('pending')
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled()
  })

  it('keeps a possible post-write SSH timeout pending, never retries automatically', async () => {
    const fixture = setup()
    fixture.siteLocalCommands.execute.mockRejectedValue(new SiteLocalShellyCommandError('timeout', true))
    const response = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'))
    expect(response.status).toBe('pending')
    expect(fixture.siteLocalCommands.execute).toHaveBeenCalledTimes(1)
    expect(fixture.registry.markDeviceCommandFailed).not.toHaveBeenCalled()
  })

  it('rejects a wrong-site route before marking a command pending', async () => {
    const fixture = setup(result(true))
    fixture.httpPoll.resolveShellyControlTarget.mockRejectedValue(new Error('wrong site'))
    await expect(runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'))).rejects.toThrow('wrong site')
    expect(fixture.registry.markDeviceCommandPending).not.toHaveBeenCalled()
    expect(fixture.siteLocalCommands.execute).not.toHaveBeenCalled()
  })
})
