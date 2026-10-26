# ADR 0004: Observer reachability is not device health

- **Status:** Accepted; partially implemented in main `46f3846`.
- **Date:** 2026-10-26

## Context

A collector's HTTP timeout describes a failed attempt from one observer to one target at a time. It does not prove device power loss, Wi-Fi disconnection or physical failure. The observer may have changed network, route, interface or reachability. Measurements also have their own freshness and may remain stale while a device continues to respond.

The Energrid ESP8266 identity-aware poller records observer-relative reachability separately from the device status and measurement timestamp. Durable firmware diagnostic failures include observer/target context. Generic configured HTTP polling still marks status `offline` on request failures and has no observer context; that path remains an open implementation gap. The live registry reachability field is process-local, while diagnostic failure history is durable.

## Decision

Represent observer-relative reachability, device-reported health and measurement freshness as separate evidence. Preserve the last successful health sample after a failed collection. Do not label the physical device offline from an observer timeout alone. Where current source cannot distinguish the cause, report an unknown or failed collection with the actual known reason.

## Consequences

- A status projection must identify the observer and timestamp for reachability claims.
- Historical device-reported values remain historical; they do not imply current connectivity.
- The ESP8266 correction is covered by API/Portal tests and committed in `46f3846`; those tests do not establish a deployed runtime's current interface or device reachability.
- Generic HTTP polling must be brought to the same evidence distinction before the contract is considered uniform across profiles.

## Source references

- [Current poller](../../apps/api/src/app/modules/devices/device-http-poll.service.ts)
- [Device Health history](../device-health-history.md)
- [Implementation status](../collection-and-ingestion.md#observer-reachability-and-device-health)
