# ADR 0001: Reusable collection coordination

- **Status:** Accepted as target architecture; coordinator/typed plans are roadmap work.
- **Date:** 2026-10-26

## Context

Energrid has one application-level HTTP timer, with generic HTTP and an Energrid ESP8266-specific branch. Diagnostics use a per-device cadence inside that poller. MQTT is push-driven and LAN discovery is operator-triggered. The current HTTP cycle has one process-local overlap flag, but dispatches all eligible devices using an unbounded `Promise.all` and one global interval.

Residential and commercial installations need the same deterministic Core while device capabilities and supported transports vary. Adding another manufacturer-specific poller would duplicate scheduling, concurrency, timeout, lifecycle and failure semantics.

## Decision

Use a reusable polling coordinator driven by typed collection plans. A plan identifies the authorized site/device, capability, adapter, verified endpoint evidence and schedule. Protocol adapters collect evidence and return typed outcomes; they do not own a per-device scheduler. The coordinator owns bounded concurrency, per-operation non-overlap, cancellation and retry/backoff/jitter policy.

Introduce this incrementally around the existing HTTP loop. Keep protocol-specific parsing and identity checks in adapters, and do not move discovery or control into scheduled collection.

## Consequences

- One scheduler policy can serve multiple capabilities and deployment types.
- Adding a protocol does not require another timer implementation.
- The current `DeviceHttpPollService` remains the implementation until the typed boundary is actually delivered.
- Multi-process execution will still require a lease or partitioning mechanism; an in-process coordinator alone is not distributed coordination.

## Source references

- [Current HTTP poller](../../apps/api/src/app/modules/devices/device-http-poll.service.ts)
- [Collection architecture](../collection-and-ingestion.md)
