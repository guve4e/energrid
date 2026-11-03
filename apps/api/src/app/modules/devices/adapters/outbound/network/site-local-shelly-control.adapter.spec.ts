import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { SiteLocalShellyControlAdapter } from './site-local-shelly-control.adapter'
import type { SiteLocalShellyRpcInput } from './site-local-shelly-control.adapter'

jest.mock('node:child_process', () => ({ spawn: jest.fn() }))

const identity = 'shellyplus1-8813bfcdc8bc'
const observer = {
  id: 'pi-upstream-bathroom', host: 'pi', sshTarget: 'pi-housenet', tenantId: 'tenant-demo',
  siteId: 'site-home', scopeId: 'upstream-lan', cidr: '192.168.1.0/24', interfaceName: 'eth0',
  expectedDeviceIds: [identity], expectedComponentKeys: ['switch:0'],
}
const input: SiteLocalShellyRpcInput = {
  zone: { id: 'upstream-lan', cidr: '192.168.1.0/24', collectionSource: 'local' } as never,
  observer, tenantId: 'tenant-demo', siteId: 'site-home', physicalId: identity,
  ipAddress: '192.168.1.219', component: 'switch:0', expectedComponentKeys: ['switch:0'],
}

function prepareRunner(result: Record<string, unknown>, writeMarker = false) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: jest.Mock }
  child.stdout = stdout; child.stderr = stderr; child.stdin = stdin; child.kill = jest.fn()
  jest.mocked(spawn).mockImplementationOnce(((_command: unknown, _args: unknown, _options: unknown) => {
    setImmediate(() => {
      if (writeMarker) stdout.write('{"kind":"write_started"}\n')
      stdout.write(`${JSON.stringify({ kind: 'result', ...result })}\n`)
      stdout.end(); stderr.end(); child.emit('close', 0)
    })
    return child as never
  }) as never)
  return child
}

function validResult(output: boolean) {
  return {
    identityBefore: { id: identity, gen: 2 }, identityAfter: { id: identity, gen: 2 },
    componentKeys: ['switch:0'], statusBefore: { id: 0, output: false }, statusAfter: { id: 0, output },
    acknowledgement: { was_on: false }, observedAt: new Date().toISOString(),
    observer: { id: observer.id, host: observer.host, interfaceName: 'eth0', interfaceAddress: '192.168.1.6' },
    writeAttempted: true,
  }
}

describe('site-local Shelly RPC transport', () => {
  beforeEach(() => jest.mocked(spawn).mockReset())

  it('uses the configured SSH alias and returns bounded readback for API-side validation', async () => {
    const result = { ...validResult(false), writeAttempted: false, acknowledgement: null, statusAfter: null }
    const child = prepareRunner(result)
    const response = await new SiteLocalShellyControlAdapter().readStatus(input)
    expect(spawn).toHaveBeenCalledWith('ssh', expect.arrayContaining([
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'pi-housenet', expect.any(String),
    ]), { stdio: 'pipe' })
    expect(response.statusBefore).toEqual({ id: 0, output: false })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('requires a separately configured exact switch grant before a write transport starts', async () => {
    const route = { observerId: observer.id, tenantId: 'tenant-demo', siteId: 'site-home', scopeId: 'upstream-lan', physicalId: identity, component: 'switch:0' }
    prepareRunner(validResult(true), true)
    const response = await new SiteLocalShellyControlAdapter().setSwitch({ ...input, route, on: true })
    expect(response.writeAttempted).toBe(true)
    expect(response.statusAfter).toEqual({ id: 0, output: true })
    expect(() => new SiteLocalShellyControlAdapter().setSwitch({ ...input, on: true }))
      .toThrow(/separately authorized/)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('performs fresh identity, component, and status checks before the write marker', async () => {
    const route = { observerId: observer.id, tenantId: 'tenant-demo', siteId: 'site-home', scopeId: 'upstream-lan', physicalId: identity, component: 'switch:0' }
    prepareRunner(validResult(true), true)
    await new SiteLocalShellyControlAdapter().setSwitch({ ...input, route, on: true })
    const args = jest.mocked(spawn).mock.calls[0][1] as string[]
    // The fixed script is shell-quoted as the final SSH argument. Unquote its
    // escaped single quotes before checking the preflight/write ordering.
    const script = args.at(-1)!.replace(/'\\''/g, "'")
    const identityCheck = script.indexOf("identityBefore=await read(input.endpoint,'/rpc/Shelly.GetDeviceInfo')")
    const componentCheck = script.indexOf("read(input.endpoint,'/rpc/Shelly.GetComponents')")
    const statusCheck = script.indexOf("statusBefore=await read(input.endpoint,'/rpc/Switch.GetStatus?id='+channel)")
    const writeGuard = script.indexOf("if(input.mode==='set')")
    const writeCall = script.indexOf("acknowledgement=await write(input.endpoint")
    expect(identityCheck).toBeGreaterThanOrEqual(0)
    expect(componentCheck).toBeGreaterThan(identityCheck)
    expect(statusCheck).toBeGreaterThan(componentCheck)
    expect(writeCall).toBeGreaterThan(writeGuard)
    expect(writeGuard).toBeGreaterThan(statusCheck)
  })

  it('rejects a route for another scope before any SSH execution', async () => {
    const route = { observerId: observer.id, tenantId: 'tenant-demo', siteId: 'site-home', scopeId: 'eero-lan', physicalId: identity, component: 'switch:0' }
    expect(() => new SiteLocalShellyControlAdapter().setSwitch({ ...input, route, on: false }))
      .toThrow(/separately authorized/)
    expect(spawn).not.toHaveBeenCalled()
  })
})
