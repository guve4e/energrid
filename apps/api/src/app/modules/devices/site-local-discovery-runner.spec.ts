import type { NetworkDiscoveryZone } from './device-registry.types'
import type { DeviceLanNetworkEvidenceCollector } from './device-lan-discovery.service'
import type { LocalNetworkRuntimeAdapter } from './adapters/outbound/network/local-network-runtime.adapter'
import type { NmapScanResult } from './adapters/outbound/network/nmap-network-evidence.adapter'
import {
  ObserverScopeInputError,
  parseSiteLocalObserverArgs,
  runSiteLocalDiscoveryOnce,
  validateAuthorizedIpv4Cidr,
} from './site-local-discovery-runner'
import { executeSiteLocalDiscoveryCli } from './site-local-discovery-cli'

describe('site-local discovery runner', () => {
  it('accepts one canonical bounded IPv4 scope and computes usable targets', () => {
    expect(validateAuthorizedIpv4Cidr('192.168.1.0/24').targetCount).toBe(254)
    expect(validateAuthorizedIpv4Cidr('192.168.1.6/31').targetCount).toBe(2)
    expect(validateAuthorizedIpv4Cidr('192.168.1.6/32').targetCount).toBe(1)
  })

  it.each([
    '192.168.1.1/24',
    '192.168.1.0/23',
    '192.168.1.0/33',
    '192.168.1/24',
    '2001:db8::/64',
    '0.0.0.0/0',
  ])('rejects malformed, non-canonical, or oversized scope %s', (cidr) => {
    expect(() => validateAuthorizedIpv4Cidr(cidr)).toThrow(ObserverScopeInputError)
  })

  it('requires exactly one explicit scope and an operator confirmation flag', () => {
    expect(parseSiteLocalObserverArgs(['--scope-cidr', '192.168.1.0/24', '--confirm-authorized'])).toEqual({
      scopeCidr: '192.168.1.0/24', explicitlyConfirmed: true,
    })
    expect(() => parseSiteLocalObserverArgs(['--scope-cidr', '192.168.1.0/24'])).toThrow(/confirmation/)
    expect(() => parseSiteLocalObserverArgs(['--scope-cidr', '192.168.1.0/24', '--scope-cidr', '192.168.2.0/24', '--confirm-authorized'])).toThrow(/exactly one/)
    expect(() => parseSiteLocalObserverArgs(['--scope-cidr', '192.168.1.0/24', '--confirm-authorized', '--target', '192.168.1.7'])).toThrow(/Unsupported argument/)
  })

  it('uses only the explicit scope and disables fallback and ambient environment sources', async () => {
    const collector = createCollector()
    const runtime = createRuntime('on_link')
    const previous = {
      seeds: process.env.HOME_LAN_SCAN_IPS,
      router: process.env.HOME_ROUTER_CLIENTS_COMMAND,
      nmap: process.env.HOME_NMAP_ENABLED,
      fallback: process.env.HOME_LAN_ACTIVE_SCAN_ENABLED,
    }
    process.env.HOME_LAN_SCAN_IPS = '192.168.1.250'
    process.env.HOME_ROUTER_CLIENTS_COMMAND = '/should-not-run'
    process.env.HOME_NMAP_ENABLED = 'false'
    process.env.HOME_LAN_ACTIVE_SCAN_ENABLED = 'true'
    try {
      await runSiteLocalDiscoveryOnce('192.168.1.0/24', { collector, runtime })
    } finally {
      restoreEnv('HOME_LAN_SCAN_IPS', previous.seeds)
      restoreEnv('HOME_ROUTER_CLIENTS_COMMAND', previous.router)
      restoreEnv('HOME_NMAP_ENABLED', previous.nmap)
      restoreEnv('HOME_LAN_ACTIVE_SCAN_ENABLED', previous.fallback)
    }

    expect(collector.getNmapCapability).toHaveBeenCalledWith(true, expect.any(AbortSignal))
    expect(collector.collectEvidence).toHaveBeenCalledTimes(1)
    const [zones, , options] = (collector.collectEvidence as jest.Mock).mock.calls[0] as [NetworkDiscoveryZone[], AbortSignal, Record<string, unknown>]
    expect(zones).toHaveLength(1)
    expect(zones[0]).toMatchObject({ cidr: '192.168.1.0/24', seedIps: [] })
    expect(options).toMatchObject({
      nmapEnabled: true,
      maxHosts: 254,
      allowActiveScanFallback: false,
      includeNeighborTable: false,
      includeRouterClientSources: false,
      includeConfiguredSeedTargets: false,
    })
    expect(Number(options.timeoutMs)).toBeLessThanOrEqual(120_000)
  })

  it('fails closed before collection when the scope is routed or has no route', async () => {
    const collector = createCollector()
    const result = await runSiteLocalDiscoveryOnce('192.168.1.0/24', {
      collector,
      runtime: createRuntime('routed'),
    })
    expect(result.status).toBe('failed')
    expect(result.failures[0]).toMatch(/not on-link|does not establish an eligible on-link route/)
    expect(collector.collectEvidence).not.toHaveBeenCalled()
  })

  it('fails closed if Nmap is unavailable and reports that no scan ran', async () => {
    const collector = createCollector({ available: false, enabled: true, reason: 'Nmap unavailable in fixture.' })
    const result = await runSiteLocalDiscoveryOnce('192.168.1.0/24', { collector, runtime: createRuntime('on_link') })
    expect(result.status).toBe('failed')
    expect(result.nmap).toMatchObject({ required: true, enabled: true, available: false })
    expect(result.endpoints).toEqual([])
    expect(collector.collectEvidence).not.toHaveBeenCalled()
  })

  it('retains host evidence when service enrichment is incomplete without claiming absent hosts are offline', async () => {
    const nmap = createNmapResult({
      complete: false,
      hostDiscoveryComplete: true,
      serviceComplete: false,
      serviceFailure: 'Nmap service enrichment timed out.',
    })
    const collector = createCollector({ nmapResult: nmap })
    const result = await runSiteLocalDiscoveryOnce('192.168.1.0/24', { collector, runtime: createRuntime('on_link') })
    expect(result.status).toBe('incomplete')
    expect(result.endpoints).toEqual([{ ipAddress: '192.168.1.10', evidenceSource: 'nmap' }])
    expect(result.coverage.hostDiscovery.complete).toBe(true)
    expect(result.coverage.serviceEnrichment.complete).toBe(false)
    expect(result.coverage.absenceMeaning).toBe('unreported-targets-remain-unknown-not-offline')
  })

  it('aborts the one-shot job at its 120-second deadline', async () => {
    jest.useFakeTimers()
    try {
      const collector = createCollector()
      ;(collector.collectEvidence as jest.Mock).mockImplementation((_zones: NetworkDiscoveryZone[], signal: AbortSignal) => new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({
          candidates: [],
          nmap: createNmapResult({
            complete: false,
            hostDiscoveryComplete: false,
            serviceComplete: false,
            serviceFailure: 'Nmap scan was cancelled by the operator.',
          }),
        }), { once: true })
      }))
      const resultPromise = runSiteLocalDiscoveryOnce('192.168.1.0/24', {
        collector,
        runtime: createRuntime('on_link'),
      })
      await jest.advanceTimersByTimeAsync(120_000)
      const result = await resultPromise
      expect(result.status).toBe('incomplete')
      expect(result.run.durationMs).toBeLessThanOrEqual(120_000)
      expect(result.stages.some(stage => stage.status === 'cancelled')).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('writes one structured JSON result for synthetic process evidence', async () => {
    const collector = createCollector()
    const chunks: string[] = []
    const exitCode = await executeSiteLocalDiscoveryCli(
      ['--scope-cidr', '192.168.1.0/24', '--confirm-authorized'],
      { collector, runtime: createRuntime('on_link'), writeStdout: value => chunks.push(value) },
    )
    expect(exitCode).toBe(0)
    const output = JSON.parse(chunks.join(''))
    expect(output.status).toBe('complete')
    expect(output.nmap).toMatchObject({ required: true, enabled: true, available: true, version: '7.94' })
    expect(output.methods).toEqual(['nmap_host_discovery', 'nmap_tcp_connect_service_scan'])
    expect(output.observer.observedAt).toBe('2026-10-26T18:00:00.000Z')
    expect(output.observer.scopeReachability.reachability).toBe('on_link')
    expect(output.coverage.targetCount).toBe(254)
    expect(output.endpoints[0].ipAddress).toBe('192.168.1.10')
    expect(output.endpoints.every((endpoint: { status?: string }) => endpoint.status !== 'offline')).toBe(true)
  })

  it('emits a structured rejection and never contacts the collector for invalid input', async () => {
    const collector = createCollector()
    const chunks: string[] = []
    const exitCode = await executeSiteLocalDiscoveryCli(
      ['--scope-cidr', '192.168.0.0/16', '--confirm-authorized'],
      { collector, writeStdout: value => chunks.push(value) },
    )
    expect(exitCode).toBe(2)
    expect(JSON.parse(chunks.join(''))).toMatchObject({ status: 'rejected', endpoints: [] })
    expect(collector.getNmapCapability).not.toHaveBeenCalled()
    expect(collector.collectEvidence).not.toHaveBeenCalled()
  })
})

function createCollector(input: {
  available?: boolean
  enabled?: boolean
  nmapResult?: NmapScanResult
} = {}): DeviceLanNetworkEvidenceCollector {
  const getNmapCapability = jest.fn().mockResolvedValue({
    available: input.available ?? true,
    enabled: input.enabled ?? true,
    ...(input.available === false ? { reason: 'Nmap unavailable in fixture.' } : { version: '7.94' }),
  })
  const collectEvidence = jest.fn().mockResolvedValue({
    candidates: [{ ipAddress: '192.168.1.10', evidenceSource: 'nmap' }],
    nmap: input.nmapResult || createNmapResult(),
  })
  return { getNmapCapability, collectEvidence } as unknown as DeviceLanNetworkEvidenceCollector
}

function createRuntime(reachability: 'on_link' | 'routed' | 'no_route'): LocalNetworkRuntimeAdapter {
  const inspect = jest.fn().mockResolvedValue({
    observedAt: '2026-10-26T18:00:00.000Z',
    observer: { id: 'pi/linux', host: 'pi', platform: 'linux' },
    interfaces: [{ name: 'eth0', internal: false, addresses: [{ family: 'IPv4', address: '192.168.1.6', cidr: '192.168.1.6/24' }] }],
    routes: [{ destination: '192.168.1.0/24', family: 'IPv4', interfaceName: 'eth0', sourceAddress: '192.168.1.6', evidence: 'kernel-route-table' }],
    localScopes: [{ cidr: '192.168.1.0/24', interfaceName: 'eth0' }],
    configuredScopes: [{ id: 'operator-authorized-scope', name: 'scope', cidr: '192.168.1.0/24', reachability, boundedScanEligible: true, reason: 'route evidence' }],
    capabilities: [{ id: 'nmap', available: true, detail: 'available' }],
    limitations: ['Route evidence does not establish endpoint reachability.'],
  })
  return { inspect } as unknown as LocalNetworkRuntimeAdapter
}

function createNmapResult(input: {
  complete?: boolean
  hostDiscoveryComplete?: boolean
  serviceComplete?: boolean
  serviceFailure?: string
} = {}): NmapScanResult {
  const hostDiscoveryComplete = input.hostDiscoveryComplete ?? true
  const serviceComplete = input.serviceComplete ?? true
  return {
    capability: { available: true, version: '7.94' },
    hosts: [],
    scopes: [{
      scopeId: 'operator-authorized-scope', complete: input.complete ?? (hostDiscoveryComplete && serviceComplete),
      targetCount: 254, hostsReported: 1,
      hostDiscovery: { durationMs: 1000, complete: hostDiscoveryComplete, targetCount: 254, hostsReported: 1 },
      serviceEnrichment: { durationMs: 2000, complete: serviceComplete, targetCount: 1, hostsReported: 1, ...(input.serviceFailure ? { failure: input.serviceFailure } : {}) },
    }],
    methods: ['nmap_host_discovery', 'nmap_tcp_connect_service_scan'],
    failures: input.serviceFailure ? [input.serviceFailure] : [],
    limitations: input.serviceFailure ? ['Host evidence retained; services incomplete.'] : [],
    cancelled: false,
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
