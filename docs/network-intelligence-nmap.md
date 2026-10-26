# Network Intelligence Nmap adapter

The API uses the system `nmap` executable as an optional infrastructure adapter. Nmap is not a domain dependency and is never invoked on API startup. A manual scan still requires an authenticated Portal operator, selected scopes, and confirmation for configured subnets.

## Install Nmap

macOS with Homebrew:

```sh
brew install nmap
nmap --version
```

Raspberry Pi OS / Debian:

```sh
sudo apt-get update
sudo apt-get install -y nmap
nmap --version
```

The current API collector runs on the host where the API process runs. This release does not install Nmap automatically and does not provide a remote Raspberry Pi collector. A scan from a Mac can only obtain layer-2 neighbor information visible to that Mac; Nmap IP/service results do not establish remote MAC addresses or physical links.

## Enable bounded Nmap service checks

Set these variables in the API process environment before starting the API:

```sh
HOME_NMAP_ENABLED=true
HOME_NMAP_MAX_HOSTS=254
HOME_NMAP_TIMEOUT_MS=120000
```

When enabled, each explicitly requested scope is scanned sequentially with TCP connect checks and lightweight service detection over a fixed port list. The adapter limits the target count to 254 addresses per scope, the process time to at most four minutes per scope, parallelism to 16, retries to one, and XML output to 8 MiB. It passes validated arguments directly to `nmap` without a shell. Do not set the host limit higher in this version.

Nmap unavailable, malformed XML, timeout, cancellation, and incomplete coverage are recorded as limitations. An address omitted from an incomplete scan is unknown, not offline. MAC data from Nmap XML is retained only when the collector has a matching on-link interface. The adapter does not infer device identity, approve enrollment, or issue device commands.

## First real scan

1. Install Nmap on the machine that runs the API and verify `nmap --version`.
2. Configure the three variables above in the API's existing environment and restart the API only through the normal approved deployment procedure.
3. Open the existing Portal Network Intelligence view, select **Eero** (`192.168.7.0/24`) or **HouseNet** (`192.168.1.0/24`), and choose **Discover selected networks**.
4. Confirm the named subnet. The saved snapshot shows Nmap version availability, methods, scope coverage, endpoints, service evidence, collector host/interface, and any limitations.
5. Repeat the same scope later to compare snapshots. Comparisons only treat a scope as fully covered when the Nmap run reports successful completion for every selected address.

When Nmap is enabled, comparisons treat a scope as fully covered only when the Nmap run reports successful completion for every selected address. If Nmap is disabled, the snapshot retains the existing collector's coverage assessment and records that Nmap service evidence was not collected.

The first V2 slice does not establish router/AP/switch hierarchy, wired versus Wi-Fi links, or remote HouseNet observations from a Mac attached only to Eero. Those relationships remain unknown until supported by direct network evidence.

## Isolated site-local one-shot runner (offline build only)

The API source includes a standalone Linux runner that reuses `DeviceLanNetworkEvidenceCollector`, its Nmap adapter, and the typed discovery evidence contracts. It is built separately from the API and does not start NestJS, Portal, MQTT, pollers, LevelDB, or PostgreSQL. The bundle replaces only Nest's decorators/logger with a small bundle-only shim; production API execution continues to use Nest normally. The runner requires Linux, Node.js 22, and an unprivileged Nmap executable.

Build on a development machine with the repository dependencies already installed:

```sh
pnpm exec nx run api:build-site-local-observer
```

The output is `dist/site-local-discovery-runner/` (`runner.js`, `package.json`, and `README.txt`). The JavaScript bundle has no runtime npm dependencies or native modules. Its package manifest declares Node.js `>=22 <23`. The source build and clean-directory Node smoke check are verified on macOS; an ARM64 Linux execution has not been performed in this milestone.

The runner accepts exactly one canonical IPv4 CIDR and a separate explicit confirmation flag. It rejects malformed, noncanonical, routed/off-link, or larger-than-254-target scopes; it does not infer authorization from interfaces or routes. It fails before discovery unless Nmap is available. It then reuses the existing adapter for host discovery followed by bounded service enrichment only against discovered hosts. It passes a maximum of 120 seconds and 254 hosts, and Nmap itself limits parallelism to 16, retries to one, and rate to 100. Active ICMP/TCP fallback, neighbor-table reads, router-client sources, configured/environment seed targets, HTTP identity probes, and persistence are disabled. Unreported addresses remain unknown, not offline. The standalone bundle never reads production environment files or credentials.

### Future deployment and one authorized run

No deployment or physical-network execution is part of this implementation. After separately authorizing a specific run, the operator can package and transfer the artifact through the established Pi SSH alias. For example, for an explicitly authorized HouseNet run:

```sh
COPYFILE_DISABLE=1 tar -czf /private/tmp/energrid-site-local-observer.tar.gz -C dist/site-local-discovery-runner .
scp /private/tmp/energrid-site-local-observer.tar.gz pi-jump:/tmp/energrid-site-local-observer.tar.gz
ssh pi-jump 'mkdir -p /tmp/energrid-site-local-observer && tar -xzf /tmp/energrid-site-local-observer.tar.gz -C /tmp/energrid-site-local-observer && cd /tmp/energrid-site-local-observer && node --version && nmap --version && node runner.js --scope-cidr 192.168.1.0/24 --confirm-authorized > result.json; code=$?; cat result.json; exit $code'
```

Run as the normal SSH user, without `sudo`; use a newly approved scope in place of the example. Review the JSON and remove only `/tmp/energrid-site-local-observer` and its tarball when finished. The command is not a generic remote-command endpoint and must not be automated by the API.

The output is a standalone evidence report, not an authenticated Discovery Memory snapshot. It has no server-authorized tenant/site owner, candidate replay, or Portal ingestion path. To ingest results safely, a later narrowly scoped API boundary must authenticate the observer, bind the submitted report to a server-authorized site and approved scan request, validate the report schema and scope, and then persist it through the existing Discovery Memory owner. Do not copy JSON directly into production stores or treat it as an enrollment candidate.
