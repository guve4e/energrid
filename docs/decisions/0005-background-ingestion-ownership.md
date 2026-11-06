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
- A matching tenant/site string is not evidence that two API instances share an inventory authority. Development instances must be explicitly marked isolated; each deployed site designates one canonical writer. `ENERGRID_INSTANCE_ID` / `ENERGRID_INSTANCE_MODE` currently expose this intended role in an administrator diagnostic but do not enforce uniqueness or attest deployment.
- Network observers may be authorized at the network/site boundary while persisted, operator-approved Physical Inventory assignments narrow which physical identity/components can be verified. Optional per-device allowlists can further restrict that path; omission does not grant enrollment, observation, measurement, or control authority.
- The existing API-owned SSH stdio observer is a scoped pull path for read-only Shelly switch status, not a general observer push protocol. Operator-attested Portal evidence and the internal observation ingress must not be treated as machine authentication. A separate, narrowly scoped authenticated reporting boundary with replay/order validation is required before remote observers can submit to a distinct site authority.

## Source references

- [Authorized Portal site context](../../apps/api/src/app/modules/portal/portal-site-context.ts)
- [MQTT router](../../apps/api/src/app/modules/devices/mqtt/device-mqtt-message-router.ts)
- [HTTP poller](../../apps/api/src/app/modules/devices/device-http-poll.service.ts)
- [Collection architecture](../collection-and-ingestion.md#tenant-site-scope-identity)
