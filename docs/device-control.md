# Explicit device control

Approval, receiving readings, permission to switch and a command route are separate. Approval no longer makes an inferred control route ready. Nothing in discovery publishes switch commands or enables recording.

## Device page

Discovery defaults to all detected LAN devices, with an optional Shelly-only filter. Network visibility does not imply supported control. The authenticated scan reads Gen2+ Shelly component status and registers only explicitly reported switch/meter channels for review. Generic devices remain visible with an adapter-needed state. Diagnostic analysis is read-only and does not create guessed switch profiles.

The working flow is Discovery -> Review channels -> Approve device -> Configure control -> Devices. MQTT-discovered and HTTP-discovered channels share physical identity/channel metadata. LAN discovery does not overwrite an approved route or enable switching. The Devices page separates approved/pending views and hides example/simulated equipment by default. Meter channels stay read-only. Gateway links match exact hardware identity/MAC, not shared model names.

Phone and tablet inventories use stacked rows without horizontal table scrolling. Control setup appears before technical details; group setup links to its physical members. Unknown relay state is not displayed as Off. Command failures and unconfirmed state appear beside the controls.

Select an approved device and open Control settings. The installer configures its logical load classification and explicitly allows switching per component. For ordinary supported Shelly devices, the installer does not select MQTT, HTTP, or a Lab observer. The API resolves the transport from verified site-owned identity, component, active endpoint, configured scope and authorized observer. Saving permission does not switch or probe a device. On/Off controls appear only when the route is ready. Meter-only channels remain read-only. Logical groups use their members' routes and cannot be given a separate guessed destination.

Legacy explicit HTTP bindings can use a known private address from exact identity evidence. MQTT-only discovery may not provide an address; **Find address** uses the existing authorized scan and does not itself save a route or enable switching. Conflicting hardware addresses are not guessed. Background discovery does not overwrite saved bindings. Scope-resolved control rechecks the active endpoint and scope at command time, and HTTP switching verifies hardware identity before the write. A changed address requires explicit reconciliation; recency alone is not authorization.

Installation details separately save the device-settings URL and whether voice automation may target the device. An exact discovered settings address pre-fills the form; the device sheet offers direct settings access and a gateway-proxied page when available. Settings URLs are HTTP(S) UI links only and are never passed to the voice assistant or fetched by the API. Read-only devices remain available as context; controllable devices are offered to voice only when assistant permission is enabled and the control route is ready. Voice commands still require an explicit on-screen confirmation, and permission/readiness is checked again when that confirmation is used. The current voice light path uses a deterministic intent planner with the configured device name and room catalog; it does not give a language model direct transport access.

An unknown HTTP address is an empty input, never a sample IP presented as if discovered. Known-address status stays visible independently of the draft, and invalid/private-address constraints are checked before configuration is submitted. Inventory search and filters update locally without a network reload, reset the result scroller, announce the result count, and provide Clear filters without changing the Approved/Pending view. Refreshing the data preserves the active filters and unsaved setup draft. The development update connection follows the actual preview origin rather than a hardcoded port.

Discovery preserves the physical ID and component/channel. A supported events/status topic supplies an observed command-topic suggestion by retaining its complete prefix and replacing the status suffix with `/rpc`. The custom full-status publisher does not establish a command prefix, so no destination is invented from its hardware ID. EM1 and EM1Data remain the same read-only meter channel.

The current Portal does not ask installers to select the normal Shelly execution transport. Its scope-resolved Shelly binding is resolved server-side from the enrolled logical component's saved identity/scope, its exact Physical Inventory assignment and current endpoint, configured network scope, component-specific RPC evidence, and authorized observer. Components may share one parent device identity and endpoint, but each still needs its own assignment, capability evidence, and component status. Physical Inventory's displayed endpoint/scope is a separate projection; it does not fill missing or mismatched installation metadata or establish RPC verification. Legacy explicit MQTT/HTTP bindings remain supported where configured. For a site-local route, the separately authorized observer and exact command-route grant resolve the current endpoint; a legacy HTTP URL is not a second route authority and cannot block that validated route. The site-local command worker freshly checks device identity, component profile, and status before `Switch.Set`, then requires matching status readback. This server-side preflight runs for each command, so the Portal does not require a separate one-minute browser verification. Direct local HTTP routes still require their configured URL to match the resolved endpoint. A saved permission or route label does not prove current readiness. **Historical state on 2 November:** the Pro 2PM `switch:0/1` routes had read-only verification, while both Plus 1 observation routes remained blocked. The Bathroom route has since been reconciled and verified through its site-local observer as described below; Kitchen remains unresolved. No physical switching test has been performed unless a later acceptance record states otherwise.

On 2 November 2026, the authenticated Portal's Network Identity view showed both Plus 1 installations had `Saved installation endpoint: Not saved` and `Saved installation scope: Not saved`. Bathroom `shellyplus1-8813bfcdc8bc` had separate current Physical Inventory evidence at `192.168.1.219` / `gateway-unknown:upstream-lan`; an operator-approved Upstream LAN scan freshly verified its Shelly ID and `switch:0` status through the routed Mac runtime. The subsequent one-shot route check returned HTTP 409, “The saved endpoint does not belong to a configured installation network scope,” before RPC. Runtime Network Intelligence diagnostics showed no remote upstream observer; the Mac was attached to Eero and had only a routed path to upstream. This establishes the immediate cause: inventory/scan evidence was never reconciled into installation endpoint/scope metadata, and no authorized upstream observer is available to make that reconciliation. Kitchen `shellyplus1-78ee4ccf4b54` has no endpoint or network evidence and was absent from the latest Eero and upstream snapshots. Neither device was reconfigured, enrolled, or granted new authority. A newer scan's protocol identity is not a valid substitute for a site-local observer report. See [current gaps](audit-and-gaps.md) for the live evidence and recovery blocker.

On 3 November, the Bathroom Plus 1 control path was added as a separately configured, exact component route for Home / `upstream-lan` / `shellyplus1-8813bfcdc8bc` / `switch:0`, through the already authorized observer `pi-upstream-bathroom`. It is separate from read-only observer permission and the existing per-component switching permission; this task did not change the permission or assistant setting. The API's bounded SSH adapter rechecks the observer interface and CIDR, target endpoint, Shelly identity and component before a write, then requires fresh `Switch.GetStatus` readback before confirming a command. The running local Portal successfully performed a read-only status request through the Pi and displayed `Off` with a fresh timestamp. The Portal exposed the existing manual control UI after this authorized identity/status check. No physical command was sent: the connected load has not been identified as safe, and operator approval for physical actuation remains required. Thus virtual ON/OFF acceptance is not evidence of a physical switch test.

## Command execution ownership (refactor checkpoint)

The dedicated `SiteLocalShellyCommandExecutor` performs the final, separately authorized site-local `Switch.Set` dispatch. It revalidates the configured zone, exact site/observer/device/component assignment and command-route grant before calling the bounded Shelly SSH adapter. `DeviceLanDiscoveryService` retains read-only status collection but no longer dispatches this physical switch write. The `DeviceControlService` continues to own command lifecycle, audit and readback; it currently still obtains its enrolled command target through `DeviceHttpPollService`. **Separating that target resolver is pending.** This is a code-organization change, not new hardware authorization or a claim of live acceptance; all existing restrictions continue to apply.

## Contract and safeguards

`libs/domain-devices/src/lib/device-control.ts` owns framework-free binding types, runtime validation and readiness rules. Registry state and the portal share this contract. Vendor execution belongs to API adapters, not the domain or UI.

Supported explicit bindings:

```json
{
  "kind": "shelly-mqtt",
  "enabled": false,
  "physicalId": "shellyplus2pm-example",
  "channel": 1,
  "topic": "shelly/kitchen/rpc"
}
```

```json
{
  "kind": "shelly-http",
  "enabled": false,
  "physicalId": "shellyplus2pm-example",
  "channel": 1,
  "baseUrl": "http://192.168.7.15",
  "credentialRef": "kitchen"
}
```

Identifiers and addresses above are illustrative, not actual assignments. A `generic-mqtt` binding has `enabled` and an exact `topic` for devices that explicitly speak the existing Energrid command format; Shellys cannot use that format. `null` removes a route.

- Both the backend and UI require an approved switch-capable device. The backend also enforces the configured tenant/site. Capability or approval alone is not control permission.
- Physical identity, component and channel must match the approved relay. A missing channel never defaults to zero. Unknown routes do not fall back to HTTP, a generic MQTT target, or the old global `HOME_SHELLY_RPC_TOPIC`.
- MQTT topics are exact, bounded and cannot contain wildcards. Shelly requests use the configured topic, physical destination and `Switch.Set` channel. The shared deployment broker/credentials remain server configuration. Publication is pending until expected relay state is observed; publishing is not success.
- HTTP origins are explicit RFC1918 IPv4 addresses with HTTP(S), with no embedded credentials, path, query or fragment. Hostnames, public/loopback/metadata addresses and redirects are not supported. The API/site gateway must reach the device. TLS verification is never disabled.
- HTTP checks `Shelly.GetDeviceInfo` against the bound physical ID before sending `Switch.Set`. It then reads `Switch.GetStatus` for the same channel. An accepted write with missing or contradictory read-back stays pending, not successful. No automatic retry of a switch write occurs. A timed-out write can have an uncertain physical outcome.
- The HTTP adapter requires system `curl`; libcurl handles SHA-256 Digest authentication. Private credentials are sent to curl through stdin configuration, not command-line arguments, portal state or logs. A configured secret reference must exist. Authentication/transport errors never include raw upstream bodies or secret-bearing command output.
- All group members are checked before any command is dispatched. Missing, unapproved, out-of-site or unconfigured members block the group. Transport failures after dispatch can still produce a partial group result; this is not a hardware transaction.

## Installation lifetime

Approvals, installer-assigned device/room names, explicit control routes and append-only command/commissioning evidence are stored locally in LevelDB at `~/.energrid/device-registry` (override with `HOME_DEVICE_STORE_DIRECTORY`). This works without PostgreSQL or internet access. Back up this directory with the site gateway's normal backup; it contains site configuration and operational evidence. The store is scoped by configured site ID. On restart, approved identities and saved routes are restored, while live state is reset to unknown until the device reports again. Historical event records distinguish an Energrid command result from an installer-confirmed physical result.

Portal login uses PostgreSQL-backed accounts. The browser receives a short-lived access JWT and an HttpOnly rotating refresh cookie; the legacy `PORTAL_CONTROL_TOKEN` is not accepted by browser routes. Administrator role does not bypass installation approval, observation authorization, device command permissions, or execution safety policy. Operator-provided startup routes can still be supplied privately through `HOME_DEVICE_CONTROL_BINDINGS_JSON`, an object keyed by approved registry device ID. Registry MQTT announcements cannot provide control bindings.

For authenticated HTTP devices, configure `HOME_SHELLY_HTTP_CREDENTIALS_JSON` privately as an object keyed by credential reference, with `username: "admin"` and the device password. Never commit that object or enter a password in the portal address/reference fields. The credential reference is a lookup key, not a secret itself.

## API and testing

### Read-only connection diagnosis

The device sheet exposes **Check connection** before the control settings. It does not run automatically, send a switching command, retry a failed command, grant approval, or edit device settings. It separates current HTTP reachability, MQTT configuration/connectivity, observation freshness, control permission and the outcome of the last command. A missing observation is unknown, not evidence of offline status; old telemetry is stale, not proof of network unreachability.

`POST /portal/devices/:deviceId/diagnostics` requires portal authorization and an approved device in the configured tenant/site. Supported Shelly relay checks use only `Shelly.GetDeviceInfo`, `Switch.GetStatus`, `MQTT.GetConfig` and `MQTT.GetStatus`. Hardware identity must match before any further reads. The address is an explicit private IPv4 origin from the approved device/binding or an exact hardware match from the last LAN scan. Missing hardware/channel metadata is not guessed. Redirects are disabled, requests have deadlines, concurrent device checks are bounded and simultaneous requests for one device are coalesced. This initial active probe supports Gen2+ Shelly relays; unsupported devices remain unverified rather than receiving invented diagnostics.

Framework-free evidence types and diagnosis rules live in `libs/domain-devices/src/lib/device-diagnostics.ts`. The API service gathers and whitelists vendor observations; the portal renders the report without interpreting raw vendor payloads. Each check is timestamped, credentials and raw error bodies are excluded, and a snapshot is explicitly marked old after a minute. Read-only checks do not feed command reconciliation: current relay state cannot retroactively prove an earlier command succeeded. Publication is not device receipt, and MQTT settings in Energrid do not enable MQTT on hardware. Shared physical-device topics are flagged for review, not silently corrected.

Diagnostic reports themselves are returned on demand, not persisted. Execution history and runtime configuration still have the existing in-memory lifetime. Durable, restart-safe audit storage remains a separate requirement; this feature does not claim to provide it. The API includes the available last command's request, publication and completion timestamps without exposing its raw evidence payload.

`POST /portal/devices/:deviceId/control` accepts `{ "binding": ... }`, requires portal authorization, and returns the device plus `persistence: "local"`. Actions use the authorized `/portal/devices/:deviceId/actions` endpoint; it independently rechecks trust, identity, route and permission. Physical outcome confirmation is only available after command reconciliation reports matching device state, and is an explicit installer assertion, not a sensor measurement.

Unit tests mock all HTTP/MQTT transport and cover route validation, exact channel/prefix preservation, approval separation, meters, cross-site rejection, group preflight, Digest credential handling, wrong hardware, malformed responses, timeouts, pending/read-back states and UI save/error/permission states. They do not operate real devices.

Sources: [Shelly RPC channels](https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels/), [Shelly authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/), [curl configuration and Digest authentication](https://curl.se/docs/manpage.html).

### Home Bathroom Plus 1 — 3 November 2026

The operator confirmed that manual switching of
`shellyplus1-8813bfcdc8bc:switch:0` works through
the authenticated Home Portal.

This is operator-reported physical acceptance.
Independent command/readback timing, restart
recovery, and failure handling remain unverified.

Kitchen Plus 1 remains unresolved.
