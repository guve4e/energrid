# Observation and identity flows

This focused guide explains selected observation paths. For the complete current collection schedule, MQTT route distinctions, discovery lifecycle, scope behavior and open architecture work, see [Collection and ingestion](collection-and-ingestion.md).

This page describes the repository implementation at the documentation base commit. It does not define firmware guarantees beyond the API's accepted contracts.

## MQTT ingestion

The API's device MQTT path is distinct from the telemetry subsystem's durable subscriber. The device path parses configured topics, routes recognized payloads, gathers evidence, checks site/install binding and approval, then admits observations through the domain pipeline. A separate persistent MQTT subscriber uses a stable client ID, `clean: false`, QoS 1 subscriptions and acknowledges delivery only after its callback reports successful local durable admission; on admission failure it closes without acknowledging so the broker session may redeliver.

```mermaid
sequenceDiagram
  participant Device
  participant Broker as MQTT broker
  participant API as API MQTT ingress
  participant Evidence as Scope and identity checks
  participant Store as LevelDB observation store
  participant History as PostgreSQL history
  Device->>Broker: Publish telemetry
  Broker->>API: QoS 1 delivery (durable subscriber path)
  API->>Evidence: Parse, route, correlate and authorize
  Evidence-->>API: Accepted observation or rejection reason
  API->>Store: Durable local admission / state and decision
  Store-->>Broker: Acknowledge only after successful admission
  API->>History: Queue accepted measurements in local outbox
  History->>History: Replay to PostgreSQL when available
```

The diagram combines the durable-subscriber contract with the approved observation/history path; not every MQTT topic or device protocol enters each stage. Do not infer broker delivery guarantees for QoS 0. The bounded in-memory operational log is diagnostic context, not the durable observation record.

### Shelly Gen2+ LAN onboarding and MQTT measurement admission

The Shelly path treats a Gen2+ MQTT identity/topic as a protocol claim, not physical authentication. A normal Shelly MQTT message does not create a pending registry candidate, select the current/default site, create an inventory record, update device state, or write measurements. Unknown Shelly hardware must first be found in an operator-authorized configured LAN scope.

The read-only LAN collector obtains `Shelly.GetDeviceInfo`, enumerates supported components with `Shelly.GetComponents` (or its documented status fallback), and confirms each component with its own `Switch.GetStatus?id=N` or `EM1.GetStatus?id=N` response. Only that scan evidence creates the ordinary Discovery candidate. The candidate carries separate scan timestamp, observer IP/MAC evidence, device-reported MAC, protocol identity, component method and timestamp. Enrollment requires the same tenant/site owner and recent identity plus component RPC evidence (currently 15 minutes); stale or MQTT-only Shelly candidates remain blocked until a new configured-scope scan.

After manual enrollment, a separate authenticated Portal approval proposes only the numeric `power` field when the corresponding status RPC reported `apower`/`act_power`. The saved installation binds the logical component to the exact device-root `shelly-mqtt` event topic and the `power` field. The operator must confirm that single proposal. This grants no relay command permission. MQTT processing then resolves the already enrolled LAN-verified device from its persisted tenant/site, checks the exact topic and binding, and passes the measurement to `DeviceIntelligenceObservationIngress`; accepted samples use the existing durable observation state and generic measurement history writer. Device-observed sample timestamps and a stable message evidence ID support duplicate delivery handling. The existing electrical history sink receives only the accepted, approved power reading when its observation timestamp is device-reported.

This initial Shelly approval supports `power` only. Other electrical values parsed by the adapter are not made authorized by this approval. Control route setup and switching remain separate and disabled until independently configured and verified. Unmatched MQTT traffic is not attributed to the active Portal site, and a site change cannot transfer the device's persisted installation authority.

Implementation anchors: [Shelly LAN candidate adapter](../apps/api/src/app/modules/devices/adapters/inbound/shelly/shelly-lan-candidates.ts), [onboarding service](../apps/api/src/app/modules/portal/device-onboarding.service.ts), [Shelly observation approval contract](../apps/api/src/app/modules/devices/adapters/inbound/shelly/shelly-mqtt-observation-approval.ts), and [approved Shelly ingress](../apps/api/src/app/modules/devices/mqtt/approved-mqtt-observation.runtime.ts).

An optional Mosquitto publisher-attribution plugin sends signed broker evidence to a dedicated topic. It records publisher metadata and a payload digest rather than retaining payloads. API-side HMAC and timestamp checks are required; candidate peer addresses require additional bounded Shelly RPC identity evidence before they can be promoted as verified LAN addresses. See [the plugin guide](../deploy/mosquitto/README.md).

## HTTP polling and identity verification

The API poller operates on approved installations, reads the endpoint binding from site-scoped discovery memory and refreshes a stable HTTP identity. It does not trust a new IP merely because the address responded. The current Energrid identity contract uses `GET /api/v1/identity`; the poller requires the expected physical `deviceId` and records scope/method/time identity evidence. Only a fresh, exact match can authorize the observation adapter to use the existing endpoint for status observations. Stale evidence triggers identity renewal; mismatch, failed request, invalid endpoint or scope mismatch rejects the observation path.

```mermaid
sequenceDiagram
  participant Poller as API HTTP poller
  participant Memory as Discovery / installation memory
  participant Device as Site device
  participant Gate as Trusted ingress
  participant State as Observation / health stores
  Poller->>Memory: Read approved site binding and endpoint
  Poller->>Device: GET /api/v1/identity
  Device-->>Poller: Stable physical device ID and firmware identity
  Poller->>Poller: Match expected ID, site/network scope and freshness
  Poller->>Memory: If mismatch, save failure and reject the status payload
  Poller->>Device: If matched, GET status or bounded diagnostics endpoint
  Device-->>Poller: Status or diagnostic sample
  Poller->>Gate: Submit with verified identity evidence
  Gate->>State: Validate installation, approval and observation contract
```

Status observation and firmware diagnostics have different schemas and persistence paths. The V1 firmware diagnostics endpoint is `GET /api/v1/diagnostics`; the parser accepts a bounded schema version and exact expected physical ID. Samples have a collector timestamp (`collectedAt`); firmware currently supplies no trusted wall-clock sample time, so `deviceObservedAt` is null. Communication failures are retained as failures; they do not prove that the device is offline.

## Rejection and recovery

- Unknown, stale, mismatched or out-of-scope identity is rejected; renew evidence before retrying.
- Duplicate observation evidence is deduplicated by scoped identity/evidence ID. Reuse of an evidence ID with different content is a conflict, not a new reading.
- Local durable admission failure pauses MQTT acknowledgement and allows broker redelivery for the persistent QoS 1 session. After restart, local state is reopened and queued history replay is retried.
- PostgreSQL history outage leaves admitted measurements in the bounded LevelDB outbox; when the queue reaches capacity, ingress fails closed instead of silently evicting queued measurements.
- Network/HTTP failure records a collection attempt and reason. It does not synthesize an offline observation.

For stored history and retention behavior, see [persistence](persistence.md), [Device Health history](device-health-history.md), and [generic measurement history](../apps/api/src/app/modules/telemetry/generic-measurements/README.md).

Implementation anchors: [durable MQTT subscriber](../apps/api/src/app/modules/devices/mqtt/durable-mqtt-subscriber.ts), [approved MQTT observation runtime](../apps/api/src/app/modules/devices/mqtt/approved-mqtt-observation.runtime.ts), [HTTP poller](../apps/api/src/app/modules/devices/device-http-poll.service.ts), [HTTP observation adapter](../apps/api/src/app/modules/devices/adapters/inbound/energrid/energrid-http-observation.adapter.ts), and [firmware diagnostics store](../apps/api/src/app/modules/devices/device-firmware-diagnostics.ts).
