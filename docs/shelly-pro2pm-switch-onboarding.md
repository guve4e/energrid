# Shelly Pro 2PM switch-mode onboarding (in progress)

This page records an isolated implementation checkpoint for using the existing discovery, candidate, enrollment and observation approval lifecycle with the Shelly Pro 2PM after the operator changed it to Switch mode. It is not evidence that the feature is active in the Mac LAB Portal.

## Current profile evidence

The operator reports that the physical Shelly at `192.168.1.166` now uses Switch mode and exposes `switch:0` and `switch:1`. The earlier `cover:0` response describes a historical profile and must not be used as current capability evidence. A fresh RPC identity and per-component status report is required before producing a current candidate. The implementation never infers relay channels from `SPSW-202PE16EU` or `Pro2PM` alone.

The existing collector reads `Shelly.GetComponents`, follows bounded pages, and verifies each supported switch/meter component using its own read-only status RPC. It derives measurement capability only from numeric fields in the matching response. Shelly cumulative energy values reported in Wh are normalized to kWh; import and returned/export totals remain distinct cumulative counters. Other reported components such as `input:0` and `input:1` are not turned into onboarding candidates by this focused workflow.

## Site-local report intake

The new narrow Portal API accepts a report only from an authenticated Portal administrator and a server-configured observer allowlist bound to the active tenant/site, configured network scope, observer interface/address and directly connected route. The report is a single-target read-only RPC result: it must contain exactly one in-scope endpoint and explicitly marks host discovery incomplete; no subnet scan is required or accepted. It also requires an exact expected Shelly identity, consistent MAC evidence when an observed MAC is provided, individually verified `switch:N` or `em1:N` status responses, and fresh timestamps. Ownership is assigned by the server; fields in the report cannot select a tenant or site. The accepted report enters Discovery Memory and the existing pending-candidate lifecycle. Replay of identical evidence is rejected.

The report source is **operator-attested, not cryptographically signed by the Pi**. The Portal administrator session, allowlist, strict scope/identity validation and explicit candidate review constrain intake, but do not prove that the JSON was emitted by the observer. The snapshot records this limitation. Before automated or lower-trust intake, add observer-origin signatures verified against server-configured public keys and update the isolated Linux runner to sign its output.

## Historical profile conflicts and operator review

Fresh switch evidence is compared with existing same-site records for the same Shelly physical ID. Historical `cover:N`, `switch:N` or `em1:N` components absent from the fresh profile are preserved and marked as conflicts; nothing is deleted or silently relabeled. The existing Portal pending-review flow requires the operator to acknowledge the discrepancy, select a room, and explicitly enroll the verified component.

Enrollment does not grant measurement or control authority. Power and cumulative energy fields are proposed only when present in the fresh component status. Each field requires separate operator approval and site-owned installation authority. For MQTT, the operator must enter and confirm the exact event topic; a custom topic such as `shelly/washer@other/events/rpc` is supported. The exact topic is a reviewed routing selector, not authenticated identity evidence. The source message must still map to the independently RPC-verified, enrolled physical component and pass the persisted per-field approval. Accepted MQTT observations use the shared deterministic observation ingress and history writer. No relay action is enabled by measurement approval.

## Activation boundary

The feature remains isolated and unactivated. No scan, report import, enrollment, measurement approval, service restart, broker reconfiguration or physical command is part of this implementation checkpoint. Live acceptance must first obtain fresh single-device Pi RPC evidence under separate authorization, import it through the authenticated route, review the candidate, and stop before enrollment or approval unless separately authorized.
