# Documentation audit and remaining gaps

## Current device status and backlog (local main `2db09e5`, 2 November 2026)

This section is the current device roadmap/status ledger. It reconciles source at local main `2db09e5` and the authenticated local Home Portal check on 2 November 2026. The commit is local only; this report does not claim Pi 5 or production deployment. Runtime results below are limited to the stated Portal actions. One bounded, read-only Shelly Pro 2PM identity/status report was collected through the authorized Eero observer and reconciled to the existing `switch:1` enrollment. No scan, relay command, enrollment change, or permission change was made.

### Implemented in source; verification level

| Capability | Source status | Verified evidence and limit |
| --- | --- | --- |
| Physical inventory and logical component assignments | Implemented | Portal groups components only by exact tenant/site-scoped enrollment assignments. At local commit `dbf63c26`, authenticated Home Portal showed 6 physical units and 7 components. The Pro 2PM `switch:0` and `switch:1` rows shared inventory `8e15ec60-a22b-4f8c-ab09-5e61d44030f9`. This confirms the read model's grouping, not fresh identity for each channel. |
| Per-component Shelly read-only status API and authorized observer resolution | Implemented with fail-closed checks | `switch:0` uses endpoint `192.168.7.39` and scope `eero-lan:192.168.7.0/24`. Initially `switch:1` had no installation endpoint/scope, although its existing Physical Inventory `8e15ec60-a22b-4f8c-ab09-5e61d44030f9` had a site-owned `.39` observation. The route correctly failed closed; inventory history alone does not authorize execution. The explicit Eero observer component allowlist also initially named only `switch:0`. After adding `switch:1` to that local observer authorization, a targeted read-only Shelly identity/status report was reconciled through the existing authenticated workflow. The existing installation route was populated as `.39` / `eero-lan`, and the scheduled HTTP poller subsequently accepted a status observation from `mac-eero-en0`. No enrollment or permission was changed. |
| Shelly physical identity and component evidence | `switch:1` verified; Plus 1s blocked | At `2026-11-02T08:28:08Z`, read-only `Shelly.GetDeviceInfo` from `192.168.7.39` returned physical ID `shellypro2pm-ec6260888084`, model `SPSW-202PE16EU`, app `Pro2PM`; `Switch.GetStatus?id=1` returned `id:1`, `output:true`, `apower:0`. The authorized evidence was reconciled to the existing switch1 logical assignment and same inventory ID, not a new enrollment. The scheduled poller accepted `switch:1` status at `2026-11-02T08:32:58.936Z` (`observerId=mac-eero-en0`, `scopeId=eero-lan`). The authenticated Portal then showed Switch 2 On and Fresh with a later accepted timestamp. Plus 1 `shellyplus1-78ee4ccf4b54` has no current endpoint/scope or identity evidence; `shellyplus1-8813bfcdc8bc` has only historical `.220` / `upstream-lan` inventory evidence, not fresh identity. Neither was probed or allowlisted. |
| Authorized scope-resolved Shelly control | Implemented; Lab acceptance reported | The Device Lab reported a virtual Shelly #1 ON/OFF round trip with RPC readback and independent dashboard confirmation. No physical Home switching test has been performed. Current permission is not proof that a route is ready. |
| Accepted-state SSE to Portal | Implemented in source and covered by tests | Registry events are emitted for projected state of approved devices; the authenticated SSE endpoint filters by principal tenant/site and Portal reconciliation fetches `/portal/state` on stream readiness/reconnect. Live external-toggle latency, Home channel-1 updates, and restart recovery were not demonstrated in the 2 November check. |
| Multi-channel Device Lab Pro 2PM | Not implemented | The recorded Lab supports virtual ESP8266 and single-switch Plus 1 profiles. No two-channel Pro 2PM emulator exists in the inspected Lab configuration; Energrid tests do not substitute for this live acceptance. |

### Current priorities

| Priority | Status | Next safe action |
| --- | --- | --- |
| 1. Resolve authorized Home routes for Pro 2PM `switch:1` and both Plus 1 devices | **Pro 2PM switch1 resolved; Plus 1s blocked** | `switch:1` now has the existing `.39` endpoint and `eero-lan` scope, after exact component authorization and fresh targeted evidence. No switching permission was enabled. Plus 1 `shellyplus1-78ee4ccf4b54` has no endpoint or scope in installation metadata or current inventory evidence; establish a current endpoint through authorized discovery and observer scope first. Plus 1 `shellyplus1-8813bfcdc8bc` has only historical protocol-observed inventory evidence at `192.168.1.220` / `gateway-unknown:upstream-lan` (25 Oct), no installation endpoint/scope, no fresh RPC identity, and is absent from Home observer identity allowlists. Confirm its current address and explicitly authorize its identity under the verified scope before reconciliation. Do not copy inventory history alone into installation metadata. |
| 2. Complete read-only physical observation for the Plus 1 devices | **Blocked by priority 1** | For each Plus 1, first establish its current address and exact authorized observer/scope binding, then obtain fresh identity and component status through the existing targeted workflow. Do not send `Switch.Set`. |
| 3. Extend the existing Device Lab for multi-channel Shelly | **Planned** | Add a protocol-faithful two-switch profile to the existing emulator, then exercise the same production discovery, verification, observation and candidate code. No Lab-specific Core policy. |
| 4. Test restart, recovery, stale state and control reliability | **Partially implemented; live acceptance pending** | Verify actual observed-state recovery and stale/unknown transitions across API and observer restart, with correlated timestamps. No physical actuation without explicit safety approval. |
| 5. Integrate the physical Shelly EM | **Planned** | Establish actual device identity, endpoint, component and authorized Home scope before integration; keep measurement approval separate from switching. |

### Known unresolved defects / acceptance gaps

- **Discovery HTTP 500:** previous Virtual Device Lab Portal scans returned HTTP 500. The original runner packaging failure (`MODULE_NOT_FOUND: ./network-discovery-evidence-utils`) was corrected and tested, but this does not establish that every later HTTP 500 cause was fixed. No current root cause or successful follow-up scan is recorded here. Reproduce only with structured stage diagnostics and the authorized Lab scope; do not count an earlier scan as proof.
- **Current Home route rejections:** the confirmed Pro 2PM channel-1 rejection was missing `RegisteredDevice.metadata` endpoint and scope. Physical Inventory's `.39` observation was not substituted for an authorized installation route. The Eero observer allowlist was explicitly extended only for this known Pro 2PM component; a fresh, single-target read-only report confirmed stable identity and `switch:1`, then the existing reconciliation action saved the route. The periodic local API poller subsequently accepted the real switch status through `mac-eero-en0` / `eero-lan`. Existing inventory and logical enrollment IDs remained unchanged, no measurement or switching permission was added, and the switch0 route/state stayed intact. Plus 1 `shellyplus1-78ee4ccf4b54` still has no endpoint/scope or current LAN evidence. Plus 1 `shellyplus1-8813bfcdc8bc` still has only historical `.220` / `gateway-unknown:upstream-lan` inventory evidence, no installation route or fresh identity, and no observer allowlist entry. Neither Plus 1 was probed or reconfigured. The Network Intelligence page displayed “No configured scopes” after restart even while the working channel route showed Eero; that read-model discrepancy remains unresolved and is distinct from the earlier discovery HTTP 500.
- **Live event synchronization:** SSE code and tests exist, but measured external device change-to-Portal latency and live API restart recovery remain unverified for Home hardware.
- **Collection scale/retry policy:** the HTTP collector still uses unbounded per-cycle `Promise.all` and lacks per-device backoff/jitter; collection coordinator work remains roadmap, not implemented.
- **Background MQTT ownership/history convergence:** normal configured routes and legacy adapter effects do not all traverse the common ingress/history writer. The existing limitation remains documented in [Collection and ingestion](collection-and-ingestion.md) and ADR 0002.
- **Durable user-attributed device command audit:** current registry command/runtime logs are not a durable append-only command ledger; see [Commands and authority](commands-and-authority.md).
- **Generic HTTP reachability semantics:** some generic configured HTTP failures still project `offline` without observer-relative context; see ADR 0004.

### Runtime and deployment evidence

The evidence above combines authenticated **local Mac Home Portal** observations on 2 November 2026, the local `pnpm run api` development process, source, and a sanitized inspection of local observer authorization configuration. The admin-only Network Identity response distinguishes installation route metadata from Physical Inventory. The Eero observer's scope remained `192.168.7.0/24` on `en0`; its allowlist was extended only for the already-enrolled Pro 2PM's `switch:1`. A read-only identity/status report at `2026-11-02T08:28:08Z` was accepted by the existing reconciliation workflow. The poller then logged an accepted switch1 observation at `2026-11-02T08:32:58.936Z`; the Portal showed Switch 2 On and Fresh around 10:33 Sofia. The existing physical and logical IDs were preserved. Manual switching remains disabled for switch1; the assistant-use setting was already enabled before this task and was not changed. Measurement approval remains separate and was not added. Channel0 remained configured and operational. No Plus 1 RPC, network scan, relay command, or Pi operation/deployment occurred. This local runtime result is not a claim of production deployment.

The handbook intentionally keeps no second standalone roadmap/backlog: this table is the status source; the lifecycle, collection, control and Lab pages carry the detailed contracts.

## Audit scope

This is a historical, read-only architecture audit of repository commit `6bd4b5f`; it did not query or modify live PostgreSQL, LevelDB, brokers, services, LAB equipment or physical devices. Since that audit, main `558c6d3` finalized the Device Health V1 Core query boundary and main `46f3846` committed the ESP8266 observer-reachability correction. Current contracts are documented in [Device Health history V1](device-health-history.md) and [Collection and ingestion](collection-and-ingestion.md). This page retains the original audit scope and findings; it is not a claim that the audit snapshot is the current source baseline.

At the time of the final comparison, the parallel checkout showed Device Health edits in `apps/api/src/app/modules/devices/device-firmware-diagnostics.ts` and its spec, `apps/api/src/app/modules/portal/portal.controller.ts`, `libs/domain-devices/src/lib/device-health-query.ts` and its spec, plus `docs/device-health-history.md`. Re-read these paths after that milestone is complete; this list is a snapshot, not a claim that it is exhaustive or final.

## Findings

| Area | Finding | Handbook treatment |
| --- | --- | --- |
| Repository entry point | Root README was the generated Nx starter and did not describe Energrid's actual shape. | Replaced it with a short product summary and links into the handbook. |
| Documentation structure | Many useful topic notes existed, but no maintained index, clear status vocabulary or unified system map. | Added a VitePress index/site and linked existing notes without deleting them. |
| Core and API boundary | The repository contains distinct NestJS API/Core apps, but their shared Postgres migrations could be mistaken for a single service/database deployment. | Described app ownership and the independent connection configuration; migration location is not presented as app dependency. |
| Identity and inventory | Existing enrollment/physical inventory contracts distinguish logical enrollments, physical assets, claims, components, endpoints and assignments. | Added lifecycle guide/ERD and separated observed evidence from verification and approval. |
| MQTT/HTTP | Protocol guides were distributed and reachability could be conflated with identity/admission. | Added ingestion/verification diagrams and failure/recovery behavior from adapters/stores. |
| PostgreSQL and LevelDB | Existing persistence notes covered some subsystems, while store ownership/default paths and memory-vs-durable boundaries were not mapped together. | Added a persistence index with schema and key-family references. |
| Health | The historical audit distinguished persisted firmware diagnostics from the basic in-memory `DeviceHealthService`. | Main now also has a protocol-independent, typed Core query boundary over the persisted diagnostic history; see the current health guide. The basic in-memory freshness estimate remains distinct. |
| Command authority/audit | Control checks are present, but device command history is runtime state and operational logs are bounded in memory. Auth audit rows do not create a durable command ledger. | Explicitly documents the current limit as an open gap. |
| Device Lab | The Node simulator and Python fixture scripts were not summarized together. Python fake HTTP is not the firmware identity/diagnostics contract. | Added a boundary guide with non-production example commands and limitations. |
| Existing docs | Focused docs remain valuable, but some are dated plans, reviews or environment-specific procedures. | Kept them intact, grouped them in the index and called out that date/status must be checked. |

## Implemented in the audited checkout

- Nx workspace with separate `apps/api`, `apps/core`, `apps/portal` and `apps/api-e2e` projects plus domain/shared libraries.
- Tenant/site-scoped enrollment, physical inventory and logical component assignment migrations and PostgreSQL adapters.
- MQTT observation routes, durable QoS 1 admission path, LevelDB observation decision/state store and generic measurement history outbox.
- HTTP polling with bounded Energrid identity verification before trusted observation use; separate bounded diagnostics collection and persisted Device Health history V1.
- Enrollment and control gates, supported MQTT/HTTP switch bindings, pending/published/failure and later state confirmation.
- Device Health V1 storage, retention, migration, event provenance and authenticated Core query boundary, including deterministic statistics and site-scoped read models; see `docs/device-health-history.md`.

## Unverified or future work

- No durable, user-attributed device-command audit ledger is visible in this checkout.
- No stable Python Device Lab SDK or direct Python observation contract is present.
- Existing environment-specific procedures need owner review for current live hosts, service managers, secrets, network paths and exact rollout state; source checkout cannot prove live deployment configuration.
- Migration completeness, production retention jobs and deployment-specific LevelDB backups require environment verification, which is outside this documentation audit.
- Some older design/review documents may no longer describe the preferred product direction; their own scope labels should be retained until owners decide to supersede them.

## Device Health query reconciliation (completed in main)

The query milestone is implemented in the current main history. Its contracts, authorization, limits, unsupported/unavailable metrics, migration, retention and event time semantics are described in `docs/device-health-history.md` and linked to source. A future change to that API or storage contract should repeat the source/test reconciliation against the then-current main commit.
