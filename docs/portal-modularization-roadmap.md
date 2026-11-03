# Energrid Portal modularization — verified migration ledger

**Status (2026-11-03): candidate changes, not yet approved for commit.**

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
| P1 — MQTT Bus | Move complete bus view, topic tree, history, pipeline model, fetch/publish and SSE lifecycle out of App.vue | Model/component tests; refresh, publish, SSE dedup, navigation teardown and reentry, site isolation; Portal build | **Candidate; verification pending on Mac** |
| P2 — Discovery | Feature page and own network evidence/view state; preserve `NetworkDiscoveryCard`, `NetworkIntelligencePanel`, pending enrollment utilities | Candidate identity and inventory assignment, cross-site security, failed evidence, session navigation | Not started |
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
