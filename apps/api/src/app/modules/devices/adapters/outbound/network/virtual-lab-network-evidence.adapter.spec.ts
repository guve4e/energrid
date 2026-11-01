import { VirtualLabNetworkEvidenceAdapter } from './virtual-lab-network-evidence.adapter'
import { Logger } from '@nestjs/common'
import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../../../device-registry.types'

const zone: NetworkDiscoveryZone = {
  id: 'device-lab-vlan',
  name: 'Virtual Lab LAN',
  cidr: '172.30.250.0/28',
  interfaceName: 'eth0',
  seedIps: ['172.30.250.10', '172.30.250.11'],
  collectionSource: 'virtual-lab',
}
const scopeTargets = Array.from({ length: 14 }, (_, index) => `172.30.250.${index + 1}`)

function device(ipAddress: string, id: string, protocol: NetworkDiscoveredDevice['protocol']): NetworkDiscoveredDevice {
  return {
    id, ipAddress, networkZoneId: zone.id, networkZoneName: zone.name,
    protocol, confidence: 0.95, status: 'online', discoveredAt: '2026-10-25T10:00:00.000Z',
    reason: 'Read-only protocol identity was verified.',
    observations: protocol === 'http' ? [{
      source: id.startsWith('shelly') ? 'http_rpc' : 'http_identity',
      attribute: id.startsWith('shelly') ? 'shelly.device_id' : 'identity.device_id',
      value: id, observedAt: '2026-10-25T10:00:00.000Z', scopeId: zone.id,
    }, ...(id.startsWith('shelly') ? [] : [{
      source: 'http_identity', attribute: 'identity.verified', value: true,
      observedAt: '2026-10-25T10:00:00.000Z', scopeId: zone.id,
    }])] : [],
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  const devices = [
    device('172.30.250.10', 'esp8266:a1b2c3', 'http'),
    device('172.30.250.11', 'shellyplus1-00c0de000001', 'http'),
    device('172.30.250.13', 'shellyplus1-00c0de000002', 'http'),
  ]
  return {
    schemaVersion: 2,
    scope: { id: zone.id, name: zone.name, configuredNetworkCidr: zone.cidr, interfaceName: 'eth0', explicitTargets: [...scopeTargets] },
    collector: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaces: ['eth0'] },
    nmap: {
      capability: { available: true, version: '7.93' }, hosts: [], methods: ['nmap_host_discovery', 'nmap_tcp_connect_service_scan'],
      scopes: [{ scopeId: zone.id, complete: true, targetCount: 14, hostsReported: 3,
        hostDiscovery: { durationMs: 12, complete: true, targetCount: 14, hostsReported: 3 },
        serviceEnrichment: { durationMs: 30, complete: true, targetCount: 14, hostsReported: 3 } }],
      failures: [], limitations: [], cancelled: false,
    },
    normalizedCandidates: devices.map(item => ({ ipAddress: item.ipAddress, networkZoneId: zone.id, networkZoneName: zone.name })),
    networkDevices: devices,
    startedAt: '2026-10-25T09:59:00.000Z', completedAt: '2026-10-25T10:00:00.000Z',
    ...overrides,
  }
}

describe('VirtualLabNetworkEvidenceAdapter', () => {
  const originalContext = process.env.HOME_VIRTUAL_LAB_DOCKER_CONTEXT
  const originalHost = process.env.HOME_VIRTUAL_LAB_DOCKER_HOST

  beforeEach(() => {
    process.env.HOME_VIRTUAL_LAB_DOCKER_CONTEXT = 'energrid-lab-ssh'
    process.env.HOME_VIRTUAL_LAB_DOCKER_HOST = '192.168.1.138'
  })

  afterEach(() => {
    if (originalContext === undefined) delete process.env.HOME_VIRTUAL_LAB_DOCKER_CONTEXT
    else process.env.HOME_VIRTUAL_LAB_DOCKER_CONTEXT = originalContext
    if (originalHost === undefined) delete process.env.HOME_VIRTUAL_LAB_DOCKER_HOST
    else process.env.HOME_VIRTUAL_LAB_DOCKER_HOST = originalHost
  })

  it('scans only the fixed authorized /28 and discovers configured plus unknown devices', async () => {
    const calls: Array<{ args: string[]; options: { timeout: number; maxBuffer: number } }> = []
    const run = jest.fn(async (args: string[], options: { timeout: number; maxBuffer: number }) => {
      calls.push({ args, options })
      const stdout = args[0] === 'context'
        ? 'ssh://lab@192.168.1.138\n'
        : args.includes('network')
          ? 'energrid-device-lab-vlan bridge true\n'
          : JSON.stringify(payload())
      return { stdout, stderr: '' }
    })
    const result = await new VirtualLabNetworkEvidenceAdapter(run).scan(zone)

    expect(result.devices.map(item => item.id)).toEqual([
      'esp8266:a1b2c3', 'shellyplus1-00c0de000001', 'shellyplus1-00c0de000002',
    ])
    expect(result.collector).toEqual({ id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaces: ['eth0'] })
    expect(calls[1].args).toEqual(['--context', 'energrid-lab-ssh', 'network', 'inspect', 'energrid-device-lab-vlan', '--format', '{{.Name}} {{.Driver}} {{.Internal}}'])
    expect(calls[2].args).toContain('--network')
    expect(calls[2].args).toContain('energrid-device-lab-vlan')
    expect(calls[2].args).toContain('--pull=never')
    expect(calls[2].args).toContain('energrid-device-lab-core-scan-m2:local')
    expect(calls[2].args).toContain(`M2_SCAN_TARGETS_JSON=${JSON.stringify(scopeTargets)}`)
    expect(calls[2].args).toContain('M2_MAX_HOSTS=14')
    expect(calls[2].args).not.toContain('--publish')
    expect(calls[2].args).not.toContain('sh')
    expect(calls[2].options.timeout).toBe(150_000)
  })

  it('logs safe structured categories for transport, runner, and invalid output failures', async () => {
    const logger = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const transportRun = jest.fn().mockRejectedValue(Object.assign(new Error('ssh password=do-not-log'), { code: 'ETIMEDOUT' }))
    await expect(new VirtualLabNetworkEvidenceAdapter(transportRun).scan(zone)).rejects.toThrow('context is unavailable')
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('"category":"ssh_docker_failure"'))
    expect(logger.mock.calls.flat().join(' ')).not.toContain('do-not-log')

    logger.mockClear()
    const runnerError = Object.assign(new Error('private runner output'), { code: 1, stderr: 'token=do-not-log' })
    const runnerRun = jest.fn()
      .mockResolvedValueOnce({ stdout: 'ssh://lab@192.168.1.138', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'energrid-device-lab-vlan bridge true', stderr: '' })
      .mockRejectedValueOnce(runnerError)
    await expect(new VirtualLabNetworkEvidenceAdapter(runnerRun).scan(zone)).rejects.toThrow('scanner failed')
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('"category":"runner_failure"'))
    expect(logger.mock.calls.flat().join(' ')).not.toContain('do-not-log')

    logger.mockClear()
    const invalidRun = jest.fn()
      .mockResolvedValueOnce({ stdout: 'ssh://lab@192.168.1.138', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'energrid-device-lab-vlan bridge true', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'not-json secret=do-not-log', stderr: '' })
    await expect(new VirtualLabNetworkEvidenceAdapter(invalidRun).scan(zone)).rejects.toThrow('malformed bounded evidence')
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('"category":"invalid_output"'))
    expect(logger.mock.calls.flat().join(' ')).not.toContain('do-not-log')
  })

  it('reads only the fixed Energrid identity and status endpoints through the internal Lab network', async () => {
    const calls: string[][] = []
    const run = jest.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'context') return { stdout: 'ssh://lab@192.168.1.138\n', stderr: '' }
      if (args.includes('network')) return { stdout: 'energrid-device-lab-vlan bridge true\n', stderr: '' }
      return { stdout: JSON.stringify({
        identity: { status: 200, body: { schemaVersion: 1, id: 'esp8266:a1b2c3' } },
        status: { status: 200, body: { schemaVersion: 1, deviceId: 'esp8266:a1b2c3', sensor: { temperatureC: 24 } } },
      }), stderr: '' }
    })

    const evidence = await new VirtualLabNetworkEvidenceAdapter(run).readEnergridHttpEvidence(
      zone, '172.30.250.10', 'esp8266:a1b2c3',
    )

    expect(evidence.identity.status).toBe(200)
    expect(evidence.status?.status).toBe(200)
    expect(calls[2]).toContain('--network')
    expect(calls[2]).toContain('energrid-device-lab-vlan')
    expect(calls[2]).toContain('--entrypoint')
    expect(calls[2]).toContain('node')
    expect(calls[2]).toContain('M5_TARGET_IP=172.30.250.10')
    expect(calls[2]).not.toContain('--publish')
    expect(calls[2]).not.toContain('sh')
    const script = calls[2][calls[2].indexOf('-e') + 1]
    expect(script).toContain("'/api/v1/identity'")
    expect(script).toContain("'/api/v1/status'")
    expect(script).toContain('redirect: \'manual\'')
    expect(script).toContain('id === expected')
  })

  it('runs selected Shelly identity, component and status RPC through the fixed isolated observer', async () => {
    const calls: Array<{ args: string[]; options: { timeout: number; maxBuffer: number } }> = []
    const run = jest.fn(async (args: string[], options: { timeout: number; maxBuffer: number }) => {
      calls.push({ args, options })
      const stdout = args[0] === 'context'
        ? 'ssh://lab@192.168.1.138\n'
        : args.includes('network')
          ? 'energrid-device-lab-vlan bridge true\n'
          : JSON.stringify({
            identity: { id: 'shellyplus1-00c0de000001', gen: 2 },
            componentKeys: ['switch:0'],
            componentStatuses: [{ componentKey: 'switch:0', body: { id: 0, output: false }, observedAt: '2026-10-31T12:00:00.000Z' }],
          })
      return { stdout, stderr: '' }
    })

    const result = await new VirtualLabNetworkEvidenceAdapter(run).verifyShellyComponent(
      zone, '172.30.250.11', 'shellyplus1-00c0de000001', ['switch:0'],
    )

    expect(result).toMatchObject({
      identity: { id: 'shellyplus1-00c0de000001', gen: 2 },
      componentKeys: ['switch:0'],
      componentStatuses: [{ componentKey: 'switch:0', body: { id: 0, output: false }, observedAt: '2026-10-31T12:00:00.000Z' }],
      observer: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaceName: 'eth0' },
    })
    expect(calls).toHaveLength(3)
    expect(calls[1].args).toEqual(['--context', 'energrid-lab-ssh', 'network', 'inspect', 'energrid-device-lab-vlan', '--format', '{{.Name}} {{.Driver}} {{.Internal}}'])
    expect(calls[2].args).toContain('--network')
    expect(calls[2].args).toContain('energrid-device-lab-vlan')
    expect(calls[2].args).toContain('--cap-drop')
    expect(calls[2].args).toContain('--read-only')
    expect(calls[2].args).toContain('--user')
    expect(calls[2].args).toContain('M6_TARGET_IP=172.30.250.11')
    expect(calls[2].args).toContain(`M6_ALLOWED_TARGETS_JSON=${JSON.stringify(scopeTargets)}`)
    expect(calls[2].args).toContain('M6_EXPECTED_COMPONENTS_JSON=["switch:0"]')
    expect(calls[2].args).not.toContain('--publish')
    expect(calls[2].args).not.toContain('sh')
    expect(calls[2].options.timeout).toBe(15_000)
    const script = calls[2].args[calls[2].args.indexOf('-e') + 1]
    expect(script).toContain('/rpc/Shelly.GetDeviceInfo')
    expect(script).toContain('/rpc/Shelly.GetComponents')
    expect(script).toContain("(kind === 'switch' ? 'Switch' : 'EM1') + '.GetStatus?id='")
    expect(script).not.toContain('Switch.Set')
  })

  it('verifies an in-scope saved endpoint not present in seedIps without running a subnet scan', async () => {
    const calls: string[][] = []
    const run = jest.fn(async (args: string[]) => {
      calls.push(args)
      const stdout = args[0] === 'context'
        ? 'ssh://lab@192.168.1.138\n'
        : args.includes('network')
          ? 'energrid-device-lab-vlan bridge true\n'
          : JSON.stringify({
            identity: { id: 'shellyplus1-00c0de000002', gen: 2 },
            componentKeys: ['switch:0'],
            componentStatuses: [{ componentKey: 'switch:0', body: { id: 0, output: false }, observedAt: '2026-10-31T12:00:00.000Z' }],
          })
      return { stdout, stderr: '' }
    })

    const result = await new VirtualLabNetworkEvidenceAdapter(run).verifyShellyComponent(
      zone, '172.30.250.13', 'shellyplus1-00c0de000002', ['switch:0'],
    )

    expect(result.identity.id).toBe('shellyplus1-00c0de000002')
    expect(calls).toHaveLength(3)
    expect(calls[2]).toContain('M6_TARGET_IP=172.30.250.13')
    expect(calls[2]).toContain(`M6_ALLOWED_TARGETS_JSON=${JSON.stringify(scopeTargets)}`)
    expect(calls[2].join(' ')).not.toContain('M2_SCAN_TARGETS_JSON')
    expect(calls[2].join(' ')).not.toContain('nmap')
  })

  it('rejects malformed selected Shelly RPC output before returning observer evidence', async () => {
    const run = jest.fn()
      .mockResolvedValueOnce({ stdout: 'ssh://lab@192.168.1.138\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'energrid-device-lab-vlan bridge true\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({
        identity: { id: 'shellyplus1-00c0de000001', gen: 2 },
        componentKeys: ['switch:0'],
        componentStatuses: [],
      }), stderr: '' })

    await expect(new VirtualLabNetworkEvidenceAdapter(run).verifyShellyComponent(
      zone, '172.30.250.11', 'shellyplus1-00c0de000001', ['switch:0'],
    )).rejects.toThrow('malformed or incomplete bounded Shelly RPC evidence')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('preserves the bounded Docker runner exception as a cause without exposing command output', async () => {
    const rootCause = Object.assign(new Error('runner timed out'), { code: 'ETIMEDOUT', stderr: 'UNRESTRICTED_RUNNER_OUTPUT' })
    const run = jest.fn()
      .mockResolvedValueOnce({ stdout: 'ssh://lab@192.168.1.138\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'energrid-device-lab-vlan bridge true\n', stderr: '' })
      .mockRejectedValueOnce(rootCause)

    let wrapped: Error & { code?: string; cause?: unknown } | undefined
    try {
      await new VirtualLabNetworkEvidenceAdapter(run).verifyShellyComponent(
        zone, '172.30.250.13', 'shellyplus1-00c0de000002', ['switch:0'],
      )
    } catch (error) {
      wrapped = error as Error & { code?: string; cause?: unknown }
    }

    expect(wrapped).toBeInstanceOf(Error)
    expect(wrapped?.message).toBe('Virtual Lab Shelly verification exceeded its 15-second execution limit.')
    expect(wrapped?.code).toBe('VIRTUAL_LAB_SHELLY_EXECUTION_TIMEOUT')
    expect(wrapped?.cause).toBe(rootCause)
    expect(wrapped?.message).not.toContain('UNRESTRICTED_RUNNER_OUTPUT')
  })

  it('rejects an out-of-scope target or unsupported component before remote execution', async () => {
    const run = jest.fn()
    const adapter = new VirtualLabNetworkEvidenceAdapter(run)
    await expect(adapter.verifyShellyComponent(zone, '172.30.251.13', 'shellyplus1-00c0de000001', ['switch:0']))
      .rejects.toThrow('outside the authorized observer scope')
    await expect(adapter.verifyShellyComponent(zone, '172.30.250.11', 'shellyplus1-00c0de000001', ['cover:0']))
      .rejects.toThrow('outside the authorized observer scope')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects any poll address outside the configured two-device allowlist before remote execution', async () => {
    const run = jest.fn()
    await expect(new VirtualLabNetworkEvidenceAdapter(run).readEnergridHttpEvidence(
      zone, '172.30.250.12', 'esp8266:a1b2c3',
    )).rejects.toThrow('not an explicitly configured Energrid device')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects seed addresses outside the authorized Virtual Lab /28 before remote execution', async () => {
    const run = jest.fn()
    await expect(new VirtualLabNetworkEvidenceAdapter(run).scan({ ...zone, seedIps: [...zone.seedIps, '172.30.251.12'] }))
      .rejects.toThrow('only in-scope seed addresses')
    expect(run).not.toHaveBeenCalled()
  })

  it('can discover an unknown in-scope endpoint without adding it to seedIps', async () => {
    const run = jest.fn(async (args: string[], options: { timeout: number; maxBuffer: number }) => {
      const stdout = args[0] === 'context'
        ? 'ssh://lab@192.168.1.138\n'
        : args.includes('network')
          ? 'energrid-device-lab-vlan bridge true\n'
          : JSON.stringify(payload())
      return { stdout, stderr: '' }
    })
    const result = await new VirtualLabNetworkEvidenceAdapter(run).scan({ ...zone, seedIps: [] })

    expect(result.devices.find(item => item.ipAddress === '172.30.250.13')?.id)
      .toBe('shellyplus1-00c0de000002')
    expect(run.mock.calls[2][0]).toContain(`M2_SCAN_TARGETS_JSON=${JSON.stringify(scopeTargets)}`)
  })

  it('rejects scope expansion to any network other than the authorized Virtual Lab /28', async () => {
    const run = jest.fn()
    await expect(new VirtualLabNetworkEvidenceAdapter(run).scan({
      ...zone, id: 'other-lab', cidr: '172.30.251.0/28', seedIps: [],
    })).rejects.toThrow('restricted to the configured device-lab-vlan scope')
    expect(run).not.toHaveBeenCalled()
  })

  it('retains reachable devices when some authorized /28 hosts are unresponsive', async () => {
    const partialPayload = payload({
      nmap: {
        ...payload().nmap,
        failures: ['One or more targets did not respond before the per-host timeout.'],
        limitations: ['Host discovery was incomplete for unresponsive targets.'],
        scopes: [{ scopeId: zone.id, complete: false, targetCount: 14, hostsReported: 3,
          hostDiscovery: { durationMs: 1_000, complete: false, targetCount: 14, hostsReported: 3,
            failure: 'Per-host timeout elapsed.' },
          serviceEnrichment: { durationMs: 200, complete: true, targetCount: 3, hostsReported: 3 } }],
      },
    })
    const run = jest.fn(async (args: string[]) => ({
      stdout: args[0] === 'context' ? 'ssh://lab@192.168.1.138\n'
        : args.includes('network') ? 'energrid-device-lab-vlan bridge true\n'
          : JSON.stringify(partialPayload),
      stderr: '',
    }))
    const result = await new VirtualLabNetworkEvidenceAdapter(run).scan(zone)

    expect(result.devices).toHaveLength(3)
    expect(result.nmap.failures).toContain('One or more targets did not respond before the per-host timeout.')
    expect(result.nmap.scopes[0].complete).toBe(false)
  })

  it('rejects a non-SSH Docker context before starting a container', async () => {
    const run = jest.fn(async () => ({ stdout: 'unix:///var/run/docker.sock', stderr: '' }))
    await expect(new VirtualLabNetworkEvidenceAdapter(run).scan(zone)).rejects.toThrow('not an SSH context')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the SSH context resolves to a different host', async () => {
    const run = jest.fn(async () => ({ stdout: 'ssh://lab@192.168.1.6', stderr: '' }))
    await expect(new VirtualLabNetworkEvidenceAdapter(run).scan(zone)).rejects.toThrow('does not match the explicitly configured Lab host')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed or out-of-scope scanner results', async () => {
    const run = jest.fn()
      .mockResolvedValueOnce({ stdout: 'ssh://lab@192.168.1.138', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'energrid-device-lab-vlan bridge true', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(payload({ networkDevices: [device('192.168.1.1', 'router', 'http')] })), stderr: '' })
    await expect(new VirtualLabNetworkEvidenceAdapter(run).scan(zone)).rejects.toThrow('outside the configured identities or scope')
  })

  it('rejects identity claims without matching protocol evidence', async () => {
    const badDevice = { ...device('172.30.250.10', 'esp8266:a1b2c3', 'http'), observations: [] }
    const run = jest.fn()
      .mockResolvedValueOnce({ stdout: 'ssh://lab@192.168.1.138', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'energrid-device-lab-vlan bridge true', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(payload({ networkDevices: [badDevice, device('172.30.250.11', 'shellyplus1-00c0de000001', 'http')] })), stderr: '' })
    await expect(new VirtualLabNetworkEvidenceAdapter(run).scan(zone)).rejects.toThrow('without matching protocol evidence')
  })

  it.each([true, false])('confirms only the requested switch:0 output=%s using fresh readback', async (on) => {
    const calls: Array<{ args: string[]; options: { timeout: number; maxBuffer: number } }> = []
    const observedAt = new Date().toISOString()
    const run = jest.fn(async (args: string[], options: { timeout: number; maxBuffer: number }) => {
      calls.push({ args, options })
      const stdout = args[0] === 'context' ? 'ssh://lab@192.168.1.138\n'
        : args.includes('network') ? 'energrid-device-lab-vlan bridge true\n'
          : JSON.stringify({
            identity: { id: 'shellyplus1-00c0de000001', gen: 2 },
            identityAfter: { id: 'shellyplus1-00c0de000001', gen: 2 },
            componentKey: 'switch:0', writeAttempted: true, acknowledged: true,
            status: { id: 0, output: on }, observedAt,
          })
      return { stdout, stderr: '' }
    })
    const result = await new VirtualLabNetworkEvidenceAdapter(run).setShellySwitch(
      zone, '172.30.250.11', 'shellyplus1-00c0de000001', 0, on,
    )
    expect(result).toMatchObject({ writeAttempted: true, acknowledged: true, output: on, observedAt,
      observer: { id: 'virtual-lab-docker/192.168.1.138/eth0' } })
    expect(calls).toHaveLength(3)
    expect(calls[2].options.timeout).toBe(18_000)
    expect(calls[2].args).toContain('M8_TARGET_IP=172.30.250.11')
    expect(calls[2].args).toContain('M8_EXPECTED_PHYSICAL_ID=shellyplus1-00c0de000001')
    expect(calls[2].args).toContain(`M8_SWITCH_ON=${String(on)}`)
    expect(calls[2].args).toContain('--read-only')
    const script = calls[2].args[calls[2].args.indexOf('-e') + 1]
    expect(script).toContain("rpc('Switch.Set', { id: 0, on: onText === 'true' })")
    expect(script).toContain("rpc('Switch.GetStatus', { id: 0 })")
    expect(script).not.toContain('Switch.Set?id=1')
    expect(script).not.toContain('Shelly.SetConfig')
  })

  it('rejects a remote command result with mismatched identity before accepting state', async () => {
    const run = jest.fn()
      .mockResolvedValueOnce({ stdout: 'ssh://lab@192.168.1.138\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'energrid-device-lab-vlan bridge true\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({
        identity: { id: 'shellyplus1-00c0de000002', gen: 2 },
        identityAfter: { id: 'shellyplus1-00c0de000002', gen: 2 },
        componentKey: 'switch:0', writeAttempted: true, acknowledged: true,
        status: { id: 0, output: true }, observedAt: new Date().toISOString(),
      }), stderr: '' })
    await expect(new VirtualLabNetworkEvidenceAdapter(run).setShellySwitch(
      zone, '172.30.250.11', 'shellyplus1-00c0de000001', 0, true,
    )).rejects.toThrow('invalid identity or command confirmation')
  })

  it('rejects unconfigured endpoints and nonzero channels before Docker execution', async () => {
    const run = jest.fn()
    const adapter = new VirtualLabNetworkEvidenceAdapter(run)
    await expect(adapter.setShellySwitch(zone, '172.30.250.16', 'shellyplus1-00c0de000001', 0, true))
      .rejects.toThrow('outside the authorized switch:0 route')
    await expect(adapter.setShellySwitch(zone, '172.30.250.11', 'shellyplus1-00c0de000001', 1, true))
      .rejects.toThrow('outside the authorized switch:0 route')
    expect(run).not.toHaveBeenCalled()
  })
})
