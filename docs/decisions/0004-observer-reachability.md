# ADR 0004: Observer reachability is not device health

- **Status:** Accepted; implementation is in progress in the main checkout.
- **Date:** 2026-10-26

## Context

A collector's HTTP timeout describes a failed attempt from one observer to one target at a time. It does not prove device power loss, Wi-Fi disconnection or physical failure. The observer may have changed network, route, interface or reachability. Measurements also have their own freshness and may remain stale while a device continues to respond.

At committed `558c6d3`, HTTP failures can set registry status to `offline`. The active main checkout contains uncommitted changes to record observer identity, target endpoint/scope, time and reachability separately and to present that distinction in the Portal.

## Decision

Represent observer-relative reachability, device-reported health and measurement freshness as separate evidence. Preserve the last successful health sample after a failed collection. Do not label the physical device offline from an observer timeout alone. Where current source cannot distinguish the cause, report an unknown or failed collection with the actual known reason.

## Consequences

- A status projection must identify the observer and timestamp for reachability claims.
- Historical device-reported values remain historical; they do not imply current connectivity.
- The uncommitted observer work is not treated as shipped until reviewed, committed and verified.

## Source references

- [Current poller](../../apps/api/src/app/modules/devices/device-http-poll.service.ts)
- [Device Health history](../device-health-history.md)
- [Implementation status](../collection-and-ingestion.md#observer-reachability-and-device-health)
