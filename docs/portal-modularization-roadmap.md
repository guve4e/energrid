# Energrid Portal modularization — verified migration ledger

**Status (2026-11-03): P1 build and focused tests passed on Mac; P1 commit/browser acceptance not independently confirmed. P2a tests reported 364 passed / 1 unrelated Finance date-dependent failure; P2a final build/browser/commit unconfirmed. P2b candidate pending Mac verification.**

## Intent

Replace `apps/portal/src/App.vue`'s multiple feature responsibilities with a thin application shell, cohesive feature pages, composables and typed contracts. Reuse existing Vue components and domain helpers rather than rebuilding working interfaces. Preserve current local-first operation, supported authentication/site selection, discovery, enrollment, command authorization, read-only observation and live state reconciliation.

The baseline source archive used for this candidate had `App.vue` at **7,356 lines** (script through line 4,555). Existing feature UI includes `components/devices/*`, `components/discovery/*`, `components/home/*`, `components/energy/*`, `components/weather/*`, and `components/expenses/*`. Size alone does not prove a design defect: the primary issue is responsibility, state and side-effect ownership in the root component.

## Boundaries

- **Application shell**: authenticated session, site selection, navigation, cross-feature notifications and layout. No feature-specific HTTP or EventSource clients.
- **Feature page**: display, interactions and feature-specific presentation state; only communicates through typed props/events and its own composables.
- **Feature composable**: loading/retry, subscriptions, explicit lifecycle cleanup, optimistic state and application decisions.
- **Shared UI**: only stable repeated design responsibilities; do not build a universal device component.
- **API adapters and contracts**: typed request/response contracts and authorization-aware transport; no direct URL literals spread across components.
- **Core/real hardware**: unchanged in the Portal-only migration. Never change command, observer or enrollment policy to satisfy a UI extraction.

## Incremental migration ledger

| Stage | Scope | Acceptance | Status |
|---|---|---|---|
| P0 — snapshot | Record working API/Portal behavior and baseline test/build results | Site selection, login, virtual Shelly discover/enroll, ON/OFF, externally changed state, route navigation | Functional baseline established earlier; exact suite evidence per change required |
| P1 — MQTT Bus | Move complete bus view, topic tree, history, pipeline model, fetch/publish and SSE lifecycle out of App.vue | Model/component tests; refresh, publish, SSE dedup, navigation teardown and reentry, site isolation; Portal build | **Mac tests/build reported passing; browser acceptance and commit not confirmed** |
| P2 — Discovery | P2a: live/remembered inventory and history; P2b: authorized scan lifecycle and pending-enrollment decisions; P2c: endpoint/AI investigation and onboarding orchestration | Site/session isolation, explicit scan and enrollment approval, fresh vs remembered evidence | **P2a and P2b focused tests reported passing; P2c candidate, Mac build and UI acceptance pending** |
| P3 — Devices | Device list/detail page, explicit device control and state stream composables; reuse existing device components | Lab Shelly new enrollment, switch ON/OFF, independent Lab state changes reflected, no duplicate SSE | Not started |
| P4 — Voice/assistant | Isolate transport, microphone/wake state, action confirmation and UI | Login/log out, permission denial, reconnect, cleanup; provider independence | Not started |
| P5 — Remaining pages / app shell | Move executions, systems, logs and cross-feature side effects; retain existing energy, weather, finance components without rewriting them | Route/navigation/session regressions; App shell owns only cross-cutting concerns | Not started |
| P6 — Backend (separate stream) | Audit controllers, registry, discovery and polling after Portal stabilization | Route/auth compatibility; persistence/idempotency; dependency graph and integration tests | Not started |

## P1 implementation decision

- `features/bus/BusPage.vue` owns the complete route content.
- `features/bus/useMqttBus.ts` owns fetching, authenticated publishing, SSE lifetime, filtering/selection, and refresh state.
- `features/bus/mqtt-model.ts` owns typed MQTT diagnostics, topic tree, duplicate suppression, and read-only pipeline interpretation.
- `features/bus/MqttTopicTree.vue` and `MqttMessageHistory.vue` render reusable **within-feature** views; no broad shared API until another genuine consumer appears.
- `shared/format-bytes.ts` is used by both Bus and existing voice diagnostics, removing duplicated formatting.
- `App.vue` no longer owns Bus-specific HTTP calls, stream lifecycle, topic state, or its large template section.

### Explicit non-goals and follow-up risks

- The existing bus EventSource authenticates using a token in its URL's `token` parameter. This candidate retains the backend contract; review token transport separately, without silently breaking live diagnostics.
- Several other features still rely on the full `/portal/state` snapshot and own global root state. They must migrate independently, not as part of P1.
- `App.vue` previously logged bus failures through a generic state error; the new Bus page displays its own loading error and continues to emit operational logs to the shell.
- No backend, schema, Finance, receipt, weather, Lab, or physical device changes are authorized in P1.

## Verification gates for P1

1. Apply patch cleanly on **the current local checkout**; exclude other contributor changes and uncommitted files.
2. Focused `vitest` model/page/component tests pass, including SSE cleanup after route unmount and token changes.
3. Existing `portal:build` and full current Portal test suite pass.
4. Manual smoke test: login; Bus navigation; tree selection/filtering; refresh; publish only to safe **Lab debug topic**; live event; navigate away/back; site change; logout. Do not publish to physical command topics.
5. Review staged diff for duplicated logic and unexpected `App.vue` behavior changes. Commit only after evidence is recorded; update this ledger with results and commit hash.

**Do not interpret passing P1 as approval of the remaining Portal architecture.**

## P2a — discovery inventory and memory read model (2026-11-03)

**Candidate, not approved.** The Discovery route keeps its existing authorized scan, investigation, and enrollment handlers. `features/discovery/DiscoveryNetworkInventory.vue` owns the searchable network list, filter, read-only discovery memory view and presentation actions. `discovery-network.ts` owns live-versus-remembered precedence, filters and summaries. `useDiscoveryMemory.ts` owns the authenticated memory read, loading/error state and site/session invalidation. `useDiscoveryNetworkModel.ts` provides the same read model to the Discovery view and current cross-page consumers (device setup and AI review); do not duplicate the precedence policy.

- Live device responses override remembered evidence by MAC identity or endpoint. Unmatched remembered devices have `status: unknown`, regardless of prior status. No inference grants control or enrollment.
- Verified enrollment badges still depend on site-filtered enrolled physical devices and a complete MAC identity; the UI does not authorize enrollment.
- Scan and approval API calls remain in the existing Portal shell **temporarily**. P2b will move the remaining AI investigations, pending approvals and scan ownership into cohesive Discovery orchestration after independent tests exist. This is an intermediate milestone, **not a completed Discovery migration**.
- Test scenarios introduced: MAC/endpoint collision, historical reachability, filtering and search, selected-device verification marker, live/historical counts, site-data replacement, in-flight response invalidation on scope/logout, view-state persistence across navigation, history controls, and presentation event forwarding.
- Required Mac gates: Portal Vite Vitest config with jsdom, focused discovery tests, full Portal suite with Finance date-test baseline documented separately, `portal:build`, `git diff --check`, and manual Virtual Lab Discovery behavior. Do not rewrite Finance tests or grant device control to satisfy UI refactoring.
- P1 verification reported: 351 passing / 1 failing Finance date-sensitive test with expected October versus current November, plus successful Portal production build. The unrelated jsdom navigation warning is not a test failure. P1 browser check and commit not independently evidenced in this artifact.

## P2b — authorized scan and enrollment decision boundaries (2026-11-03)

**Candidate; requires Mac build, test and browser acceptance.** The shell delegates network scan lifecycle to `features/discovery/useDiscoveryScan.ts` and manual candidate decisions to `features/discovery/useDiscoveryDecisions.ts`. These are separate concerns: scanning collects read-only evidence; identity verification never enrolls a device; only an explicit authorized approve request can change enrollment.

- `useDiscoveryScan` owns explicit bounded-network confirmation, physical-vs-Lab scope separation, authenticated scan API requests, the API's 180 s deadline grace period, cancellation, progress timers, error descriptions and site/session invalidation. The root shell still integrates successful snapshot projections, existing memory/history refresh and navigation. A stale result is rejected before this integration begins.
- `useDiscoveryDecisions` owns per-candidate busy state, approval/block requests, reconciliation acknowledgment, 25-second Shelly identity verification, dedicated errors, audit log forwarding and site/session invalidation. The root shell retains only lookup of a candidate and existing device-list navigation after an approval.
- Do not mistake a verification response for approval, let remembered evidence imply online status, or change backend authorization policy to satisfy UI tests.
- New tests cover scope selection and consent, request compatibility, duplicate suppression, cancellation, stale site/logout results, HTTP denial, reconciliation acknowledgment, approve/block distinction, and identity verification without enrollment.
- The original root-level `loadState()` and network snapshot loader are still broad and have not been refactored. Async projection operations that already began before a site reload remain a follow-up architecture concern. No claim of full Discovery isolation is made.
- **Next**: P2c isolates endpoint probes, AI/network investigations, bounded onboarding entry point, and evidence reviews. Then complete Discovery page composition; do not skip directly to Devices until the remaining ownership is resolved.

Mac acceptance gate: `pnpm exec vitest run --config apps/portal/vite.config.ts --environment jsdom apps/portal/src/features/discovery`, full Portal suite (document unchanged Finance date failure), `pnpm exec nx run portal:build`, `git diff --check`, and manual Virtual Lab scope scan, physical-scope consent, pending Shelly verify/approve, site switching and logout. Confirm actual production build output, not merely command invocation. Do not stage unrelated Finance/receipt changes.

## P2c — cohesive Discovery workspace and investigation ownership (2026-11-03)

**Candidate; NOT yet compiled or executed in the Mac Portal.** This migration is built from the accepted P2b source snapshot with the duplicate-scope scan fix. It reduces `App.vue` from approximately 5,756 to approximately 3,912 lines. This number is an architectural progress indicator, not an acceptance result.

- `DiscoveryWorkspace.vue` owns composition of both Discovery Inbox and Network Intelligence routes, reusing the existing `DiscoveryNetworkInventory` and `NetworkIntelligencePanel`. One persistent `useDiscoveryWorkspace` model survives switching between the two routes and owns site-scoped memory, snapshots and scan integration.
- `DiscoveryOnboarding.vue` owns pending-candidate review presentation, explicit verification and approval events, and approved onboarding links. The existing backend approval contract remains authoritative; device verification is not enrollment.
- `DeviceIntelligencePanel.vue`, `InvestigationHistory.vue`, `InvestigationReport.vue` and `MqttProfileReview.vue` separate independent presentation responsibilities. `useDiscoveryIntelligence` and `useMqttProfileInvestigations` retain consent-gated AI investigations, history, and read-only synthetic replay proposals; none authorize hardware control or profile installation.
- `useDiscoverySnapshots` and `useDiscoveryEndpointActions` own authenticated historical evidence and bounded endpoint operations, including site/session invalidation of stale requests. The explicit onsite approval and verification composable from P2b remains unchanged.
- `portal-state.ts` exports the existing shared Portal response types rather than re-declaring them in the root component. These contracts are moved, not redesigned.
- New behavioral tests cover site changes during async reads, consent denial, no automatic enrollment, synthetic MQTT preview safety and component event forwarding. The old Discovery page markup and related handlers have been removed from the root component.

**Known work still to complete**: `NetworkIntelligencePanel.vue` itself remains a legacy ~1,097-line feature component; splitting its distinct sections is a follow-on bounded refactor after P2c passes Mac acceptance, not a reason to rewrite a functioning enrollment view in an untested batch. The Devices feature and global application shell remain in `App.vue`. Some root-to-Devices navigation callbacks are temporarily injected into Discovery for continuity; review this interface once Devices is feature-owned. The broad `loadState()` read model and site switching are not redesigned in P2c.

**Acceptance gate**: apply the patch to the exact accepted P2b checkout, run Discovery focused Vitest with the Portal Vite config and `jsdom`, full Portal tests (document the unchanged Finance calendar-month failure independently), `portal:build`, and `git diff --check`. In the Lab site manually verify Discovery Inbox search, historical vs current evidence, Network Intelligence navigation/site switching, scan cancellation, endpoint evidence, explicit Shelly verification/approval, and the existing bidirectional device state journey. Only after those checks, inspect the staged diff and commit only Discovery and Portal type files plus this ledger. Do not stage Finance/receipt modifications or make hardware-control changes.
