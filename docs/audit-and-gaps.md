# Documentation audit and remaining gaps

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
