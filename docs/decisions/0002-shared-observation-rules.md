# ADR 0002: Shared deterministic observation rules

- **Status:** Accepted; normalized accepted measurement history is unified, while some MQTT state routes and electrical rollup compatibility writes remain separate.
- **Date:** 2026-10-26

## Context

HTTP polling and MQTT pushes are different transports for observations. Both must respect the same tenant/site ownership, enrollment, installation, source/field approval, evidence identity, deduplication and persistence rules. Transport adapters establish evidence provenance; the Core makes deterministic admission decisions.

Today, HTTP ESP samples and the identity-bound Lab MQTT route use `DeviceIntelligenceObservationIngress`. The normal configured MQTT route and older adapter-driven effects have paths that do not traverse the same ingress/history writer boundary.

## Decision

All approved observations, whether collected on a schedule or pushed by MQTT, should converge on one deterministic, protocol-independent ingress and persistence contract. The ingress assigns server receipt time, validates configured authority, performs idempotent state admission and forwards accepted evidence to history persistence. Transport-specific code may parse and establish provenance but cannot authorize fields or enrollment.

`telemetry.measurements` is the canonical raw historical store for accepted, history-eligible normalized measurements, and Portal history readers use its tenant/site/device/component/channel/metric identity and persisted field authorization. The electrical `telemetry.readings` table remains a specialized compatibility input to electrical rollups; its current Pro Shelly MQTT projection is not a second universal Portal history source. Historical data is not automatically merged or backfilled between those stores.

Ingress convergence for every state-only MQTT route remains a target; existing direct-store paths remain documented technical debt until migrated and verified. Likewise, moving electrical rollup consumers to generic history requires a separately reviewed compatibility/backfill plan.

## Consequences

- HTTP and MQTT can share approval and duplicate-evidence behavior.
- A successful transport receipt is not itself an accepted observation.
- Device Health diagnostics remain a distinct health-evidence contract rather than becoming measurement telemetry.
- Existing direct-store and legacy MQTT routes must be reconciled deliberately; do not assert they already use the common writer.

## Source references

- [Shared observation ingress](../../apps/api/src/app/modules/devices/device-intelligence-observation-ingress.ts)
- [Approved MQTT route](../../apps/api/src/app/modules/devices/mqtt/approved-mqtt-observation.route.ts)
- [Collection architecture and current gaps](../collection-and-ingestion.md)
