# ADR 0005: Explicit ownership for background ingestion

- **Status:** Accepted; generic background adapter routing needs follow-up.
- **Date:** 2026-10-26

## Context

Portal site selection is request-scoped. Background pollers and MQTT callbacks run without a user's active Portal request. Deriving ownership from a current/default site, a client payload, an IP address or a recently selected scope risks projecting evidence into the wrong site. Network scope and site ownership answer different questions.

The HTTP poller uses persisted installation tenant/site values and the configured network-zone association. The discovery service captures server-authorized ownership when a scan starts. Exact approved MQTT routes carry tenant/site in trusted configuration. Generic adapter-driven MQTT effects use the registry snapshot, which may fall back to configured site context when there is no Portal request context.

## Decision

Every background observation, diagnostic event, discovery snapshot and candidate correlation must carry a trusted tenant/site owner resolved by the server or installation. Network scope is separate provenance and cannot select ownership. MQTT payloads may prove protocol claims but cannot choose their own tenant/site. Generic broker/device routes need an explicit configured owner before they are used in a multi-site installation.

## Consequences

- Explicitly configured routes can be authorized without relying on Portal state.
- Missing ownership is a rejection or unscoped historical evidence, not an invitation to use the current site.
- The generic background MQTT fallback is a documented risk until its broker/device-to-site binding is explicit.

## Source references

- [Authorized Portal site context](../../apps/api/src/app/modules/portal/portal-site-context.ts)
- [MQTT router](../../apps/api/src/app/modules/devices/mqtt/device-mqtt-message-router.ts)
- [HTTP poller](../../apps/api/src/app/modules/devices/device-http-poll.service.ts)
- [Collection architecture](../collection-and-ingestion.md#tenant-site-scope-identity)
