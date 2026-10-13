# Explicit device control

Approval, receiving readings, permission to switch and a command route are separate. Approval no longer makes an inferred control route ready. Nothing in discovery publishes switch commands or enables recording.

## Device page

Discovery defaults to all detected LAN devices, with an optional Shelly-only filter. Network visibility does not imply supported control. The authenticated scan reads Gen2+ Shelly component status and registers only explicitly reported switch/meter channels for review. Generic devices remain visible with an adapter-needed state. Diagnostic analysis is read-only and does not create guessed switch profiles.

The working flow is Discovery -> Review channels -> Approve device -> Configure control -> Devices. MQTT-discovered and HTTP-discovered channels share physical identity/channel metadata. LAN discovery does not overwrite an approved route or enable switching. The Devices page separates approved/pending views and hides example/simulated equipment by default. Meter channels stay read-only. Gateway links match exact hardware identity/MAC, not shared model names.

Phone and tablet inventories use stacked rows without horizontal table scrolling. Control setup appears before technical details; group setup links to its physical members. Unknown relay state is not displayed as Off. Command failures and unconfirmed state appear beside the controls.

Select an approved device and open Control settings. The page shows the readings transport independently of the control route, hardware identity and relay channel. Choose MQTT or (for a supported Shelly relay) HTTP, enter the exact destination, explicitly allow switching, and save. Saving does not switch or probe a device. Off/On controls appear only for ready routes. Meter-only channels remain read-only. Logical groups use their members' routes and cannot be given a separate guessed destination.

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

## Configuration lifetime

The existing approval inventory is in memory. Control edits in the portal are also explicitly **runtime-session settings**, not database-backed configuration. Restart discards runtime edits. No hidden file or database migration was introduced. Operator-provided startup routes can be supplied privately through `HOME_DEVICE_CONTROL_BINDINGS_JSON`, an object keyed by approved registry device ID. Startup configuration is validated and survives deployments only through the operator's configuration management. Runtime overrides, including disabling a startup-enabled route, do not rewrite that configuration; update the operator configuration before restart when a change must persist. Registry MQTT announcements cannot provide control bindings.

For authenticated HTTP devices, configure `HOME_SHELLY_HTTP_CREDENTIALS_JSON` privately as an object keyed by credential reference, with `username: "admin"` and the device password. Never commit that object or enter a password in the portal address/reference fields. The credential reference is a lookup key, not a secret itself.

## API and testing

### Read-only connection diagnosis

The device sheet exposes **Check connection** before the control settings. It does not run automatically, send a switching command, retry a failed command, grant approval, or edit device settings. It separates current HTTP reachability, MQTT configuration/connectivity, observation freshness, control permission and the outcome of the last command. A missing observation is unknown, not evidence of offline status; old telemetry is stale, not proof of network unreachability.

`POST /portal/devices/:deviceId/diagnostics` requires portal authorization and an approved device in the configured tenant/site. Supported Shelly relay checks use only `Shelly.GetDeviceInfo`, `Switch.GetStatus`, `MQTT.GetConfig` and `MQTT.GetStatus`. Hardware identity must match before any further reads. The address is an explicit private IPv4 origin from the approved device/binding or an exact hardware match from the last LAN scan. Missing hardware/channel metadata is not guessed. Redirects are disabled, requests have deadlines, concurrent device checks are bounded and simultaneous requests for one device are coalesced. This initial active probe supports Gen2+ Shelly relays; unsupported devices remain unverified rather than receiving invented diagnostics.

Framework-free evidence types and diagnosis rules live in `libs/domain-devices/src/lib/device-diagnostics.ts`. The API service gathers and whitelists vendor observations; the portal renders the report without interpreting raw vendor payloads. Each check is timestamped, credentials and raw error bodies are excluded, and a snapshot is explicitly marked old after a minute. Read-only checks do not feed command reconciliation: current relay state cannot retroactively prove an earlier command succeeded. Publication is not device receipt, and MQTT settings in Energrid do not enable MQTT on hardware. Shared physical-device topics are flagged for review, not silently corrected.

Diagnostic reports themselves are returned on demand, not persisted. Execution history and runtime configuration still have the existing in-memory lifetime. Durable, restart-safe audit storage remains a separate requirement; this feature does not claim to provide it. The API includes the available last command's request, publication and completion timestamps without exposing its raw evidence payload.

`POST /portal/devices/:deviceId/control` accepts `{ "binding": ... }`, requires the existing portal authorization, and returns the device plus `persistence: "runtime"`. Actions still use the authorized `/portal/devices/:deviceId/actions` endpoint; it independently rechecks trust, identity, route and permission.

Unit tests mock all HTTP/MQTT transport and cover route validation, exact channel/prefix preservation, approval separation, meters, cross-site rejection, group preflight, Digest credential handling, wrong hardware, malformed responses, timeouts, pending/read-back states and UI save/error/permission states. They do not operate real devices.

Sources: [Shelly RPC channels](https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels/), [Shelly authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/), [curl configuration and Digest authentication](https://curl.se/docs/manpage.html).
