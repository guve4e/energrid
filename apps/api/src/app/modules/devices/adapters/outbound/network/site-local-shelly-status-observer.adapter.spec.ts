import { EventEmitter } from 'node:events'
import * as childProcess from 'node:child_process'
import { VirtualLabNetworkEvidenceAdapter, type RemoteShellyStatusAssignment } from './virtual-lab-network-evidence.adapter'
import type { NetworkDiscoveryZone } from '../../../device-registry.types'
import type { AuthorizedSiteLocalObserver } from '../../../site-local-shelly-evidence-intake'

jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), spawn: jest.fn() }))

const zone: NetworkDiscoveryZone = {
  id: 'upstream-lan', name: 'Upstream LAN', cidr: '192.168.1.0/24', seedIps: [], collectionSource: 'local',
}
const authorization: AuthorizedSiteLocalObserver = {
  id: 'pi-upstream-bathroom', host: 'pi', sshTarget: 'pi-housenet', tenantId: 'tenant-demo', siteId: 'site-home',
  scopeId: zone.id, cidr: zone.cidr!, interfaceName: 'eth0',
  expectedDeviceIds: ['shellyplus1-8813bfcdc8bc'], expectedComponentKeys: ['switch:0'],
}
const assignment: RemoteShellyStatusAssignment = {
  key: 'a'.repeat(32), physicalId: 'shellyplus1-8813bfcdc8bc', ipAddress: '192.168.1.219',
  expectedComponentKeys: ['switch:0'], components: [{ assignmentKey: 'b'.repeat(32), componentKey: 'switch:0' }],
}

class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() })
  stderr = { resume: jest.fn() }
  stdin = {
    writable: true,
    write: jest.fn((line: string) => {
      const request = JSON.parse(line)
      const observer = request.observer
      this.stdout.emit('data', `${JSON.stringify({ schemaVersion: 1, kind: 'ready', ready: true,
        observerSessionId: request.observerSessionId, scopeId: request.scopeId, observerId: observer.id,
        host: 'pi', interfaceName: 'eth0', interfaceAddress: '192.168.1.6', cidr: '192.168.1.0/24' })}\n`)
      return true
    }),
  }
  kill = jest.fn(() => { this.emit('close', 0, 'SIGTERM'); return true })
}

describe('site-local Shelly status observer transport', () => {
  let child: FakeChild
  let spawn: jest.SpyInstance

  beforeEach(() => {
    child = new FakeChild()
    spawn = childProcess.spawn as unknown as jest.SpyInstance
    spawn.mockImplementation((() => {
      setImmediate(() => child.emit('spawn'))
      return child as never
    }) as typeof childProcess.spawn)
  })

  afterEach(() => { spawn.mockReset(); jest.restoreAllMocks() })

  it('keeps one persistent read-only worker on a strict SSH stream for the exact authorized assignment', async () => {
    const result = await new VirtualLabNetworkEvidenceAdapter().startSiteLocalShellyOperationalObserver(
      zone, authorization, '11111111-1111-4111-8111-111111111111', [assignment], jest.fn(), jest.fn(),
    )

    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { stdio: string }]
    expect(command).toBe('ssh')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args).toContain('ConnectTimeout=5')
    expect(args).toContain('pi-housenet')
    expect(args.at(-1)).toContain('node -e ')
    expect(args.at(-1)).toContain('Shelly.GetDeviceInfo')
    expect(args.at(-1)).toContain('Shelly.GetComponents')
    expect(args.at(-1)).toContain('Switch.GetStatus')
    expect(args.at(-1)).not.toContain('Switch.Set')
    expect(options.stdio).toBe('pipe')
    expect(result.observer).toEqual({ id: authorization.id, host: 'pi', interfaceName: 'eth0', platform: 'linux',
      localScopes: [{ interfaceName: 'eth0', cidr: '192.168.1.0/24', address: '192.168.1.6' }] })
    expect(result.handle.isAlive()).toBe(true)

    expect(result.handle.update([{ ...assignment, ipAddress: '192.168.1.220' }])).toBe(false)
    result.handle.close()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(result.handle.isAlive()).toBe(false)
  })

  it('rejects an observer that reports the wrong remote host before accepting any collection events', async () => {
    child.stdin.write.mockImplementationOnce((line: string) => {
      const request = JSON.parse(line)
      child.stdout.emit('data', `${JSON.stringify({ schemaVersion: 1, kind: 'ready', ready: true,
        observerSessionId: request.observerSessionId, scopeId: request.scopeId, observerId: authorization.id,
        host: 'other-host', interfaceName: 'eth0', interfaceAddress: '192.168.1.6', cidr: zone.cidr })}\n`)
      return true
    })

    await expect(new VirtualLabNetworkEvidenceAdapter().startSiteLocalShellyOperationalObserver(
      zone, authorization, '11111111-1111-4111-8111-111111111111', [assignment], jest.fn(), jest.fn(),
    )).rejects.toThrow('runtime identity, interface or authorized scope did not match')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('rejects mismatched scopes and endpoints outside the authorized CIDR before spawning SSH', async () => {
    const adapter = new VirtualLabNetworkEvidenceAdapter()
    await expect(adapter.startSiteLocalShellyOperationalObserver(
      { ...zone, cidr: '192.168.7.0/24' }, authorization, '11111111-1111-4111-8111-111111111111',
      [assignment], jest.fn(), jest.fn(),
    )).rejects.toThrow('exact configured observer')
    await expect(adapter.startSiteLocalShellyOperationalObserver(
      zone, authorization, '11111111-1111-4111-8111-111111111111',
      [{ ...assignment, ipAddress: '192.168.7.39' }], jest.fn(), jest.fn(),
    )).rejects.toThrow('outside its authorized network scope')
    expect(spawn).not.toHaveBeenCalled()
  })
})
