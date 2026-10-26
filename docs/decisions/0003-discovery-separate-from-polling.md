# ADR 0003: Discovery separate from operational polling

- **Status:** Accepted.
- **Date:** 2026-10-26

## Context

Network discovery can include subnet probes, interface/route inspection, Nmap and device identity enrichment. It has a different scope, permission and coverage model from routine reads of an enrolled device. An observed route or interface is evidence of a possible network scope; it is not permission to scan it. A scan can also be partial and cannot establish that an unreported host is offline.

## Decision

Keep discovery as an explicit operator-authorized operation over configured scopes, with bounded limits, cancellation, provenance and immutable snapshots. Keep periodic operational collection limited to authorized enrolled devices and capabilities. Discovery results may support candidate generation and endpoint identity verification, but must not silently enroll, approve, grant observation authority or issue control commands.

## Consequences

- Discovery scheduling is not coupled to the device polling interval.
- Scan coverage and observed endpoint evidence are preserved separately from health polling results.
- A discovery scan can be reviewed and compared without implying operational enrollment or reachability outside the scan time.

## Source references

- [Portal scan authorization](../../apps/api/src/app/modules/portal/portal.controller.ts)
- [LAN discovery service](../../apps/api/src/app/modules/devices/device-lan-discovery.service.ts)
- [Collection architecture](../collection-and-ingestion.md)
