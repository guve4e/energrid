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
