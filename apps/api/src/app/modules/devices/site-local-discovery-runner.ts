import { isIPv4 } from 'node:net'
import {
  DeviceLanNetworkEvidenceCollector,
  type NetworkCandidate,
} from './device-lan-discovery.service'
import { LocalNetworkRuntimeAdapter } from './adapters/outbound/network/local-network-runtime.adapter'
import type { NetworkDiscoveryZone } from './device-registry.types'
import type { NmapScanResult } from './adapters/outbound/network/nmap-network-evidence.adapter'

export const SITE_LOCAL_OBSERVER_SCHEMA_VERSION = 1 as const
export const SITE_LOCAL_OBSERVER_MAX_TARGETS = 254
export const SITE_LOCAL_OBSERVER_DEADLINE_MS = 120_000

export type ObserverStageStatus = 'not_started' | 'attempted' | 'complete' | 'incomplete' | 'failed' | 'cancelled'

export interface ObserverExecutionStage {
  name: 'scope_validation' | 'runtime_inspection' | 'nmap_capability' | 'host_discovery' | 'service_enrichment'
  status: ObserverStageStatus
  startedAt?: string
  completedAt?: string
  durationMs?: number
  failure?: string
}

export interface ValidatedObserverScope {
  cidr: string
  targetCount: number
  zone: NetworkDiscoveryZone
}

export interface SiteLocalObserverResult {
  schemaVersion: typeof SITE_LOCAL_OBSERVER_SCHEMA_VERSION
  status: 'complete' | 'incomplete' | 'failed' | 'rejected'
  run: { startedAt: string; completedAt: string; durationMs: number }
  authorization: { confirmation: 'explicit-cli-flag'; scopeCidr: string; targetCount: number }
  observer?: {
    observedAt: string
    identity: { id: string; host: string; platform: string }
    interfaces: NonNullable<Awaited<ReturnType<LocalNetworkRuntimeAdapter['inspect']>>['interfaces']>
    routes: NonNullable<Awaited<ReturnType<LocalNetworkRuntimeAdapter['inspect']>>['routes']>
    scopeReachability: Awaited<ReturnType<LocalNetworkRuntimeAdapter['inspect']>>['configuredScopes'][number]
  }
  nmap: { required: true; enabled: true; available: boolean; version?: string }
  methods: string[]
  coverage: {
    targetCount: number
    hostsReported: number
    hostDiscovery: { status: ObserverStageStatus; durationMs: number; complete: boolean; failure?: string }
    serviceEnrichment: { status: ObserverStageStatus; durationMs: number; complete: boolean; failure?: string }
    absenceMeaning: 'unreported-targets-remain-unknown-not-offline'
  }
  endpoints: NetworkCandidate[]
  stages: ObserverExecutionStage[]
  failures: string[]
  limitations: string[]
}

export interface SiteLocalObserverDependencies {
  collector?: DeviceLanNetworkEvidenceCollector
  runtime?: LocalNetworkRuntimeAdapter
  now?: () => Date
}

export class ObserverScopeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObserverScopeInputError'
  }
}

export function validateAuthorizedIpv4Cidr(cidr: string): ValidatedObserverScope {
  if (typeof cidr !== 'string' || cidr.length > 18 || cidr.trim() !== cidr) {
    throw new ObserverScopeInputError('Provide exactly one canonical IPv4 CIDR scope.')
  }
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/.exec(cidr)
  if (!match || !isIPv4(match[1])) throw new ObserverScopeInputError('Scope must be a valid IPv4 CIDR.')

  const prefix = Number(match[2])
  const octets = match[1].split('.').map(Number)
  const address = octets.reduce((value, octet) => value * 256 + octet, 0)
  const size = 2 ** (32 - prefix)
  const network = Math.floor(address / size) * size
  if (network !== address) throw new ObserverScopeInputError('Scope CIDR must use its canonical network address.')
  const targetCount = prefix <= 30 ? size - 2 : size
  if (targetCount < 1) throw new ObserverScopeInputError('Scope contains no usable IPv4 targets.')
  if (targetCount > SITE_LOCAL_OBSERVER_MAX_TARGETS) {
    throw new ObserverScopeInputError(`Scope exceeds the ${SITE_LOCAL_OBSERVER_MAX_TARGETS}-target limit; choose a narrower authorized CIDR.`)
  }

  return {
    cidr,
    targetCount,
    zone: {
      id: 'operator-authorized-scope',
      name: `Operator-authorized ${cidr}`,
      cidr,
      seedIps: [],
      role: 'primary',
      collectionSource: 'local',
    },
  }
}

export function parseSiteLocalObserverArgs(argv: readonly string[]): { scopeCidr: string; explicitlyConfirmed: true } {
  let scopeCidr: string | undefined
  let explicitlyConfirmed = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--scope-cidr') {
      if (scopeCidr !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new ObserverScopeInputError('Pass exactly one value to --scope-cidr.')
      }
      scopeCidr = argv[index + 1]
      index += 1
    } else if (argument === '--confirm-authorized') {
      if (explicitlyConfirmed) throw new ObserverScopeInputError('--confirm-authorized may only be provided once.')
      explicitlyConfirmed = true
    } else if (argument === '--help') {
      throw new ObserverScopeInputError('Usage: site-local-discovery-runner --scope-cidr <IPv4-CIDR> --confirm-authorized')
    } else {
      throw new ObserverScopeInputError(`Unsupported argument: ${argument}`)
    }
  }
  if (!scopeCidr) throw new ObserverScopeInputError('Exactly one --scope-cidr is required.')
  if (!explicitlyConfirmed) throw new ObserverScopeInputError('Explicit operator confirmation is required with --confirm-authorized.')
  validateAuthorizedIpv4Cidr(scopeCidr)
  return { scopeCidr, explicitlyConfirmed: true }
}

export async function runSiteLocalDiscoveryOnce(
  scopeCidr: string,
  dependencies: SiteLocalObserverDependencies = {},
): Promise<SiteLocalObserverResult> {
  const scope = validateAuthorizedIpv4Cidr(scopeCidr)
  const now = dependencies.now || (() => new Date())
  const started = now()
  const deadlineAt = started.getTime() + SITE_LOCAL_OBSERVER_DEADLINE_MS
  const controller = new AbortController()
  const deadlineTimer = setTimeout(() => controller.abort(new Error('Observer execution deadline reached.')), SITE_LOCAL_OBSERVER_DEADLINE_MS)
  const runtime = dependencies.runtime || new LocalNetworkRuntimeAdapter()
  const collector = dependencies.collector || new DeviceLanNetworkEvidenceCollector(undefined, undefined)
  const stages: ObserverExecutionStage[] = [{ name: 'scope_validation', status: 'complete', startedAt: started.toISOString(), completedAt: now().toISOString(), durationMs: 0 }]
  const failures: string[] = []
  const limitations = ['Unreported targets remain unknown; absence from this result is not proof that a device is offline.']
  let runtimeReport: Awaited<ReturnType<LocalNetworkRuntimeAdapter['inspect']>> | undefined
  let nmapCapability: Awaited<ReturnType<DeviceLanNetworkEvidenceCollector['getNmapCapability']>> = { available: false, enabled: true, reason: 'Nmap capability check did not complete.' }
  let evidence: Awaited<ReturnType<DeviceLanNetworkEvidenceCollector['collectEvidence']>> | undefined
  const runtimeStart = now()

  try {
    stages.push({ name: 'runtime_inspection', status: 'attempted', startedAt: runtimeStart.toISOString() })
    try {
      runtimeReport = await runtime.inspect([scope.zone])
      const stage = stages[stages.length - 1]
      stage.status = 'complete'
      stage.completedAt = now().toISOString()
      stage.durationMs = Math.max(0, now().getTime() - runtimeStart.getTime())
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime inspection failed.'
      failures.push(`Runtime inspection failed: ${message}`)
      const stage = stages[stages.length - 1]
      stage.status = 'failed'
      stage.completedAt = now().toISOString()
      stage.durationMs = Math.max(0, now().getTime() - runtimeStart.getTime())
      stage.failure = message
    }

    const reachability = runtimeReport?.configuredScopes[0]
    if (!runtimeReport || !reachability || reachability.cidr !== scope.cidr ||
        reachability.reachability !== 'on_link' || !reachability.boundedScanEligible) {
      const routeState = reachability?.reachability || 'unknown'
      const message = `Refusing to scan: runtime evidence does not establish an eligible on-link route for the authorized scope (reported ${routeState}).`
      failures.push(message)
      stages.push({ name: 'nmap_capability', status: 'not_started', failure: message })
      return buildResult({ scope, started, now, runtimeReport, nmapCapability, evidence, stages, failures, limitations, status: 'failed' })
    }

    if (controller.signal.aborted || now().getTime() >= deadlineAt) {
      failures.push('Execution deadline expired before collection began.')
      stages.push({ name: 'nmap_capability', status: 'cancelled', failure: failures[failures.length - 1] })
      return buildResult({ scope, started, now, runtimeReport, nmapCapability, evidence, stages, failures, limitations, status: 'failed' })
    }

    const capabilityStart = now()
    stages.push({ name: 'nmap_capability', status: 'attempted', startedAt: capabilityStart.toISOString() })
    nmapCapability = await collector.getNmapCapability(true, controller.signal)
    const capabilityStage = stages[stages.length - 1]
    capabilityStage.completedAt = now().toISOString()
    capabilityStage.durationMs = Math.max(0, now().getTime() - capabilityStart.getTime())
    capabilityStage.status = nmapCapability.available ? 'complete' : 'failed'
    if (!nmapCapability.available) {
      const message = nmapCapability.reason || 'Nmap is unavailable; no collection was attempted.'
      capabilityStage.failure = message
      failures.push(message)
      return buildResult({ scope, started, now, runtimeReport, nmapCapability, evidence, stages, failures, limitations, status: 'failed' })
    }

    const remainingMs = Math.max(0, deadlineAt - now().getTime())
    if (remainingMs < 1_000) {
      const message = 'Execution deadline leaves insufficient time to start bounded Nmap collection.'
      failures.push(message)
      return buildResult({ scope, started, now, runtimeReport, nmapCapability, evidence, stages, failures, limitations, status: 'failed' })
    }

    evidence = await collector.collectEvidence([scope.zone], controller.signal, {
      nmapEnabled: true,
      maxHosts: Math.min(scope.targetCount, SITE_LOCAL_OBSERVER_MAX_TARGETS),
      timeoutMs: remainingMs,
      allowActiveScanFallback: false,
      includeNeighborTable: false,
      includeRouterClientSources: false,
      includeConfiguredSeedTargets: false,
    })

    const nmapScope = evidence.nmap.scopes.find(item => item.scopeId === scope.zone.id)
    if (!nmapScope || !evidence.nmap.capability.available) {
      const message = evidence.nmap.capability.reason || 'Nmap collection did not produce a scope result.'
      failures.push(message)
      stages.push({ name: 'host_discovery', status: 'failed', failure: message })
      stages.push({ name: 'service_enrichment', status: 'not_started', failure: 'Nmap did not complete its host-discovery stage.' })
      return buildResult({ scope, started, now, runtimeReport: evidence.runtime || runtimeReport, nmapCapability, evidence, stages, failures, limitations, status: 'failed' })
    }

    stages.push(stageFromNmap('host_discovery', nmapScope.hostDiscovery))
    stages.push(stageFromNmap('service_enrichment', nmapScope.serviceEnrichment))
    failures.push(...evidence.nmap.failures)
    limitations.push(...evidence.nmap.limitations)
    const hostStageStatus = stageForOutput(stages, 'host_discovery')
    return buildResult({
      scope, started, now, runtimeReport: evidence.runtime || runtimeReport, nmapCapability, evidence,
      stages, failures, limitations,
      status: nmapScope.complete ? 'complete' : hostStageStatus === 'failed' && nmapScope.hostDiscovery.hostsReported === 0 ? 'failed' : 'incomplete',
    })
  } catch (error) {
    const message = controller.signal.aborted
      ? 'Observer execution reached its 120-second deadline; partial results are retained where available.'
      : error instanceof Error ? error.message : 'Observer collection failed.'
    failures.push(message)
    return buildResult({
      scope, started, now, runtimeReport: evidence?.runtime || runtimeReport, nmapCapability,
      evidence, stages, failures, limitations, status: evidence ? 'incomplete' : 'failed',
    })
  } finally {
    clearTimeout(deadlineTimer)
  }
}

function stageFromNmap(
  name: 'host_discovery' | 'service_enrichment',
  stage: NmapScanResult['scopes'][number]['hostDiscovery'],
): ObserverExecutionStage {
  const failure = stage.failure?.toLowerCase() || ''
  const status: ObserverStageStatus = stage.complete
    ? 'complete'
    : failure.includes('cancel')
      ? 'cancelled'
      : /failed before|time limit|unavailable|did not run|invalid nmap xml/.test(failure)
        ? 'failed'
        : stage.failure ? 'incomplete' : 'attempted'
  return {
    name,
    status,
    durationMs: stage.durationMs,
    ...(stage.startedAt ? { startedAt: stage.startedAt } : {}),
    ...(stage.completedAt ? { completedAt: stage.completedAt } : {}),
    ...(stage.failure ? { failure: stage.failure } : {}),
  }
}

function buildResult(input: {
  scope: ValidatedObserverScope
  started: Date
  now: () => Date
  runtimeReport?: Awaited<ReturnType<LocalNetworkRuntimeAdapter['inspect']>>
  nmapCapability: Awaited<ReturnType<DeviceLanNetworkEvidenceCollector['getNmapCapability']>>
  evidence?: Awaited<ReturnType<DeviceLanNetworkEvidenceCollector['collectEvidence']>>
  stages: ObserverExecutionStage[]
  failures: string[]
  limitations: string[]
  status: SiteLocalObserverResult['status']
}): SiteLocalObserverResult {
  const completed = input.now()
  const nmapScope = input.evidence?.nmap.scopes.find(item => item.scopeId === input.scope.zone.id)
  return {
    schemaVersion: SITE_LOCAL_OBSERVER_SCHEMA_VERSION,
    status: input.status,
    run: {
      startedAt: input.started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - input.started.getTime()),
    },
    authorization: {
      confirmation: 'explicit-cli-flag',
      scopeCidr: input.scope.cidr,
      targetCount: input.scope.targetCount,
    },
    ...(input.runtimeReport ? { observer: {
      observedAt: input.runtimeReport.observedAt,
      identity: input.runtimeReport.observer,
      interfaces: input.runtimeReport.interfaces,
      routes: input.runtimeReport.routes,
      scopeReachability: input.runtimeReport.configuredScopes[0],
    } } : {}),
    nmap: {
      required: true,
      enabled: true,
      available: input.nmapCapability.available,
      ...(input.nmapCapability.version ? { version: input.nmapCapability.version } : {}),
    },
    methods: input.evidence?.nmap.methods || [],
    coverage: {
      targetCount: input.scope.targetCount,
      hostsReported: nmapScope?.hostsReported || 0,
      hostDiscovery: {
        status: stageForOutput(input.stages, 'host_discovery'),
        durationMs: nmapScope?.hostDiscovery.durationMs || 0,
        complete: nmapScope?.hostDiscovery.complete || false,
        ...(nmapScope?.hostDiscovery.failure ? { failure: nmapScope.hostDiscovery.failure } : {}),
      },
      serviceEnrichment: {
        status: stageForOutput(input.stages, 'service_enrichment'),
        durationMs: nmapScope?.serviceEnrichment.durationMs || 0,
        complete: nmapScope?.serviceEnrichment.complete || false,
        ...(nmapScope?.serviceEnrichment.failure ? { failure: nmapScope.serviceEnrichment.failure } : {}),
      },
      absenceMeaning: 'unreported-targets-remain-unknown-not-offline',
    },
    endpoints: input.evidence?.nmap.capability.available ? input.evidence.candidates : [],
    stages: input.stages,
    failures: [...new Set(input.failures)],
    limitations: [...new Set(input.limitations)],
  }
}

function stageForOutput(stages: ObserverExecutionStage[], name: 'host_discovery' | 'service_enrichment'): ObserverStageStatus {
  return stages.find(stage => stage.name === name)?.status || 'not_started'
}
