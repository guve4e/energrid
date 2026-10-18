# Explicit device control

Approval, receiving readings, permission to switch and a command route are separate. Approval no longer makes an inferred control route ready. Nothing in discovery publishes switch commands or enables recording.

## Device page

Discovery defaults to all detected LAN devices, with an optional Shelly-only filter. Network visibility does not imply supported control. The authenticated scan reads Gen2+ Shelly component status and registers only explicitly reported switch/meter channels for review. Generic devices remain visible with an adapter-needed state. Diagnostic analysis is read-only and does not create guessed switch profiles.

The working flow is Discovery -> Review channels -> Approve device -> Configure control -> Devices. MQTT-discovered and HTTP-discovered channels share physical identity/channel metadata. LAN discovery does not overwrite an approved route or enable switching. The Devices page separates approved/pending views and hides example/simulated equipment by default. Meter channels stay read-only. Gateway links match exact hardware identity/MAC, not shared model names.

Phone and tablet inventories use stacked rows without horizontal table scrolling. Control setup appears before technical details; group setup links to its physical members. Unknown relay state is not displayed as Off. Command failures and unconfirmed state appear beside the controls.

Select an approved device and open Control settings. The page shows the readings transport independently of the control route, hardware identity and relay channel. Choose MQTT or (for a supported Shelly relay) HTTP, enter the exact destination, explicitly allow switching, and save. Saving does not switch or probe a device. Off/On controls appear only for ready routes. Meter-only channels remain read-only. Logical groups use their members' routes and cannot be given a separate guessed destination.

HTTP setup fills in a known private address from an exact physical ID/MAC match in LAN discovery, HTTP discovery metadata, or an existing HTTP readings endpoint. MQTT-only discovery identifies the hardware but does not necessarily provide a local address; **Find address** runs the existing authorized LAN scan and fills the unsaved draft if that exact device is found. It does not save a route or enable switching. Conflicting hardware addresses are not guessed. Saved HTTP bindings and manually edited drafts are not overwritten by background discovery; an explicit Find address request can replace the address draft, but still requires Save to change the route. HTTP control continues to verify hardware identity before every switch write, protecting against DHCP address reassignment.

Installation details separately save the device-settings URL and whether voice automation may target the device. An exact discovered settings address pre-fills the form; the device sheet offers direct settings access and a gateway-proxied page when available. Settings URLs are HTTP(S) UI links only and are never passed to the voice assistant or fetched by the API. Read-only devices remain available as context; controllable devices are offered to voice only when assistant permission is enabled and the control route is ready. Voice commands still require an explicit on-screen confirmation, and permission/readiness is checked again when that confirmation is used. The current voice light path uses a deterministic intent planner with the configured device name and room catalog; it does not give a language model direct transport access.

An unknown HTTP address is an empty input, never a sample IP presented as if discovered. Known-address status stays visible independently of the draft, and invalid/private-address constraints are checked before configuration is submitted. Inventory search and filters update locally without a network reload, reset the result scroller, announce the result count, and provide Clear filters without changing the Approved/Pending view. Refreshing the data preserves the active filters and unsaved setup draft. The development update connection follows the actual preview origin rather than a hardcoded port.

Discovery preserves the physical ID and component/channel. A supported events/status topic supplies an observed command-topic suggestion by retaining its complete prefix and replacing the status suffix with `/rpc`. The custom full-status publisher does not establish a command prefix, so no destination is invented from its hardware ID. EM1 and EM1Data remain the same read-only meter channel.

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

Production login uses `PORTAL_ADMIN_EMAIL`, `PORTAL_ADMIN_PASSWORD`, and `PORTAL_CONTROL_TOKEN`. The portal API accepts the configured token only through the Authorization bearer header; query-string tokens are not accepted. The local development login remains a development convenience and must not be used as production credentials. Operator-provided startup routes can still be supplied privately through `HOME_DEVICE_CONTROL_BINDINGS_JSON`, an object keyed by approved registry device ID. Registry MQTT announcements cannot provide control bindings.

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
