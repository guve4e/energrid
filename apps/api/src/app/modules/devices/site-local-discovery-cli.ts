import {
  ObserverScopeInputError,
  parseSiteLocalObserverArgs,
  runSiteLocalDiscoveryOnce,
  SITE_LOCAL_OBSERVER_SCHEMA_VERSION,
  type SiteLocalObserverDependencies,
} from './site-local-discovery-runner'

export interface ObserverCliDependencies extends SiteLocalObserverDependencies {
  writeStdout?: (value: string) => void
  now?: () => Date
}

export async function executeSiteLocalDiscoveryCli(
  argv: readonly string[],
  dependencies: ObserverCliDependencies = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout || (value => process.stdout.write(value))
  const now = dependencies.now || (() => new Date())
  if (argv.length === 1 && argv[0] === '--help') {
    writeStdout('Usage: site-local-discovery-runner --scope-cidr <IPv4-CIDR> --confirm-authorized\n')
    return 0
  }

  try {
    const input = parseSiteLocalObserverArgs(argv)
    const result = await runSiteLocalDiscoveryOnce(input.scopeCidr, dependencies)
    writeStdout(`${JSON.stringify(result)}\n`)
    return result.status === 'complete' ? 0 : 3
  } catch (error) {
    const message = error instanceof ObserverScopeInputError
      ? error.message
      : error instanceof Error ? error.message : 'Observer runner failed.'
    const rejected = {
      schemaVersion: SITE_LOCAL_OBSERVER_SCHEMA_VERSION,
      status: 'rejected' as const,
      completedAt: now().toISOString(),
      stages: [{ name: 'scope_validation', status: 'failed', failure: message }],
      failures: [message],
      endpoints: [],
    }
    writeStdout(`${JSON.stringify(rejected)}\n`)
    return 2
  }
}

if (require.main === module) {
  void executeSiteLocalDiscoveryCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  }).catch(() => {
    process.exitCode = 3
  })
}
