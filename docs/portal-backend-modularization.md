# Portal HTTP boundary modularization (P6)

Source inventory: 2026-11-03 tracked-backend archive. This document records verified source structure, proposed boundaries, and acceptance evidence separately.

## Baseline (verified from source)

- `apps/api/src/app/modules/portal/portal.controller.ts`: 2,204 lines, 64 Nest HTTP/SSE method decorators, 24 constructor parameters plus four property-injected collaborators.
- Controller-wide policy: `@Controller('portal')`, `@UseGuards(AccessJwtGuard, RoleGuard)`, `@RequireRoles('admin')`. The root GET redirect has its own `@PublicRoute()` metadata.
- A global `PortalSiteContextInterceptor` resolves the authorized site for an administrator before the handler is subscribed. Its asynchronous-context behavior needs separate integration verification; do not remove or bypass it during controller splits.
- Existing tests construct `PortalController` directly. Constructor changes require coordinated test-harness updates rather than retaining dead injectable fields.

## P6a candidate: telemetry and MQTT diagnostics controllers

Route handlers moved **without changing paths or handler logic**:

- `PortalDeviceTelemetryController`: `GET devices/:deviceId/observations`, `GET devices/:deviceId/read-model`, `GET devices/:deviceId/measurements`, `GET devices/:deviceId/electrical-measurements`, `GET devices/:deviceId/firmware-diagnostics`, `GET device-health/history`.
- `PortalMqttDiagnosticsController`: `GET mqtt/evidence/:deviceId/status`, `GET bus/mqtt`, `SSE bus/mqtt/events`, `POST bus/mqtt/publish`.
- `PortalController` still owns the authorized device-state SSE and device control/enrollment. Its `PortalDeviceMeasurementsService` dependency remains because it is used during state restoration.
- Shared defensive admin assertion moved to `portal-authorization.ts`; `portal.controller.ts` re-exports it temporarily to preserve imports in other modules.
- Both new controllers repeat the original class-level JWT/admin guards, Swagger exclusion and `portal` route prefix. The module explicitly registers both.
- Test harnesses updated to match the shorter `PortalController` constructor; new tests cover route metadata, class-level guards, scoped observation access, unapproved firmware-denial and MQTT publish authorization.

Static verification performed outside the repository runtime: 64 original route signatures exactly match the 64 signatures across the three candidate controllers, without duplicates; changed TS files parse/transpile; `git diff --check` passes. **Nest dependency injection, Jest, TypeScript project build and live HTTP tests are not verified in this source-only environment.**

## Required acceptance before commit

1. Confirm patch applies to the current Mac checkout, with unrelated work preserved.
2. Run focused Portal and device reconciliation Jest specs, then the API build and relevant full API test suite. Resolve any new warnings or unhandled rejections rather than relaxing tests.
3. Confirm the 10 routes still carry JWT/admin guard metadata and correct HTTP/SSE paths. Verify anonymous/forbidden requests are rejected by the actual HTTP pipeline.
4. Exercise read-only measurements/history, MQTT Bus SSE and debug publish on Virtual Lab, keeping physical Home loads untouched.
5. Review staged diff, commit only the backend Portal refactor and its tests/docs. Record commit hash and actual test results.

## Subsequent controller boundaries (planned, not implemented)

- P6b: Discovery inventory, network snapshots and memory **read-only** queries.
- P6c: Operator-authorized scans, site-local evidence intake, reconciliation and endpoint operations. Review ownership checks, active-probe consent, and retry/timeout semantics first.
- P6d: AI investigation and proposal execution, with consent gates and deterministic approval kept distinct.
- P6e: Device commissioning, enrollment decisions, control configuration and command requests. Preserve exact physical identity, authorization, readback and audit invariants.
- P6f: Site/session, state restoration, assistant chat and operational-state SSE. Confirm authorized-site context survives every async boundary.
- Then audit Registry (3,097 lines), LAN Discovery (2,318 lines) and HTTP Polling (1,274 lines), with ownership and persistence boundaries rather than mechanical method extraction.

Definition of done: cohesive module ownership and small dependency surfaces, equivalent HTTP and authorization behavior, negative/security tests, full relevant regression tests, browser/Virtual Lab acceptance, and a reviewed commit. Line reduction alone is not acceptance.

## P6a accepted and P6b candidate (2026-11-03)

- P6a is accepted locally in commit `7c9e645` (nine scoped files, reported green targeted tests and API build). This archive-derived workspace reconstructs the accepted P6a patch, not subsequent changes from the Mac.
- **P6b candidate** moves five read-only discovery endpoints to `PortalNetworkDiscoveryReadController`: `GET network/snapshots`, `GET network/capabilities`, `GET network/snapshots/:fromScanId/compare/:toScanId`, `GET network/memory`, and `GET network/memory/summary`.
- The controller retains the exact `portal` prefix, class-level JWT and administrator guards, defensive runtime administrator assertion, original method signatures and read-model projections. Active tenant/site ownership still derives from the registry snapshot and is passed to discovery-memory store methods, not accepted from request parameters.
- Existing `PortalController` retains scanning, observer evidence intake, installer notes, investigation, reconciliation, enrollment, physical actions, and its `discoveryOwner()` helper. The snapshot recovery proposal remains **read-only** and does not modify inventory or routes.
- The new controller has three required collaborators (registry, memory, LAN discovery) plus the original optional physical-inventory token. `PortalModule` registers it explicitly. Constructor injections of `PortalController` remain unchanged because those dependencies are still used by its other handlers.
- Source-only patch verification must include **all 64 HTTP/SSE route signatures matching the accepted P6a baseline**, no duplicate registrations, TypeScript parsing, `git diff --check`, and clean application against the reconstructed P6a baseline. Tests must cover administrator denial before access, active-site scope, missing foreign-site snapshots, projections, and capabilities. This is **not** a verified Nest/HTTP result until the Mac Jest and API build pass.
- Do **not** mix P6b with the concurrent Finance, receipt, Jest config or package changes; don't stage those paths or run broad Git cleanup. Preserve `origin/main` divergence for separate inspection.

### P6b acceptance checklist

1. Apply P6b after `7c9e645`; confirm the new controller and the 5 removed `PortalController` methods, then run focused Jest tests and uncached API build.
2. Run API routing/auth integration tests, including unauthorized/forbidden requests and active-site selection through `PortalSiteContextInterceptor`; direct-method Jest tests do not establish HTTP guard/interceptor behavior.
3. Compare real Virtual Lab snapshot/memory results before and after the change for the same selected site, including a foreign-site request and a missing comparison snapshot. Leave physical control untouched.
4. Review and stage exactly the P6b patch paths; commit only after acceptance. Record commit SHA, tests, and observed results in docs rather than marking unverified tests green.

## P6c candidate: consent-gated network scans and read-only Shelly verification

Built from P6b source **including the Jest isolation correction**. P6b's focused suite (19/19) and API build were reported green on the Mac, but its final Git commit and authenticated HTTP smoke tests are not yet confirmed in this workspace. **Commit P6b separately before applying/staging P6c.**

- `PortalNetworkDiscoveryScanController` owns the existing `POST network/scan` and `POST discovery/:deviceId/verify-shelly` routes. These are the only two routes moved in P6c. It has exactly two injected collaborators: `DeviceLanDiscoveryService` and `DeviceRegistryService`. Controller-level JWT/admin guards, runtime administrator assertions, route signatures, scope consent, 180-second timeout, request close-listener cleanup and original response shapes remain.
- `portal-discovery-candidate.ts` owns the shared **site-stamped candidate registration policy** and the ownership comparison used by both this controller and the remaining Portal flows. It does not approve, enroll, configure, or switch devices.
- Six existing `portal-control.spec.ts` cases are pointed at the new controller rather than retained as dead wrappers on the old controller. A new focused suite tests guard execution, route registration, unauthorized denial before any scan, invalid/duplicate scopes, consent, active-site verification, foreign-site response rejection (not merely skipping registry writes), site stamping, timeout, and disconnect cleanup.
- **Safety correction (cross-site):** previously, a mismatched scan owner prevented registry registration but the endpoint still returned foreign-site scan results. It now fails with a forbidden response and does not register candidates. The scanner itself may already have persisted its own site-owned evidence; this controller check does not undo that work.
- **Safety correction (disconnect):** an adapter may ignore its `AbortSignal`. An already-disconnected HTTP request could previously receive a late scan response and still write candidates into the active registry. The new scan handler rejects late results after cancellation and performs no candidate registration. This is a deliberate, narrow behavioral hardening; verify it with the new regression test and the Virtual Lab before acceptance.
- **Not included:** site-local Shelly evidence intake/reconciliation, bounded endpoint probes, AI investigations, and control/enrollment. They retain their existing handlers and require separately scoped work. No physical Home scanning or switching is required for verification.

Source-only verification: **64 original P6b HTTP/SSE signatures preserved without duplicates**, TypeScript syntax/transpile checks and `git diff --check` passed. NestDI, Jest, uncached API build, and authenticated HTTP/Virtual Lab behavior are **not verified here**. To accept: run the new scan suite plus `portal-control.spec.ts`, P6b boundary tests and LAN-discovery tests, compile the API without Nx cache, verify authenticated scan/verify via Virtual Lab, then review and commit only P6c paths. This extraction alone does not resolve the registry or LAN-discovery service internals.

## P6b/P6c locally committed; P6d candidate (2026-11-04)

Reported Mac Git checkpoints: P6b `194222f` (network discovery reads) and P6c `3227ff4` (consent-gated network scanning), both following committed P6a `7c9e645`. P6c focused tests and an uncached API build were reported green after fixing duplicate scope-ID rejection. **Authenticated live HTTP/Virtual Lab checks were not reported and remain open**. The Finance/receipt and Jest/package working-tree changes are not part of this sequence.

**P6d candidate scope:** the three *existing* site-local Shelly RPC evidence routes move to `PortalSiteLocalShellyEvidenceController`, delegating to one focused `PortalSiteLocalShellyEvidenceWorkflow` application service:

- `POST network/site-local-shelly-evidence`: accepts only a configured site-local observer's operator-attested read-only report and creates a scoped immutable discovery snapshot; no automatic enrollment or device control.
- `GET network/site-local-shelly-evidence/:scanId/review`: rebuilds a site-owned reconciliation review with exact observer, scope, and inventory checks.
- `POST network/site-local-shelly-evidence/:scanId/reconcile`: requests *only* the exact enrolled component identity reconciliation through existing registry policies, preserving the explicit `enrollmentChanged: false`, `measurementAuthorityChanged: false` and `controlAuthorityChanged: false` response.

The new HTTP controller has only one dependency, the workflow. The workflow derives ownership from the live device registry on each call; it does not accept a tenant or site from the request. It preserves the original allowlist, timestamp, immutable scan-ID, physical inventory, site, component, and evidence-source checks without changing domain registry authority. `PortalModule` explicitly registers both classes; no new Core policy or switch control is introduced. The existing site-local HTTP workflow and real registry reconciliation tests are updated to use the workflow/controller rather than the removed `PortalController` methods. A focused controller test covers guards, delegation, foreign-site and missing snapshots, and invalid reconciliation inputs.

**Known pre-existing risk deliberately not changed:** `recordScan` and `recordSnapshot` are sequential writes; a concurrent duplicate report or a partial persistence failure may require recovery logic in a separate Core/persistence task. Operator-attested input is not cryptographically signed. We must not claim these cases are solved by a controller extraction.

P6d acceptance requires checking the 64-route manifest, focused Jest including the HTTP workflow and registry tests, uncached API build, `git diff --check`, authenticated admin/unauthenticated/viewer HTTP requests and site isolation against Virtual Lab; no real physical device switching. Review/commit only the scoped P6d paths after tests. **None of the Mac test/build/runtime checks have been run for this candidate yet.** AI investigation/proposal execution, endpoint probing, device enrollment/commissioning and physical control remain separately scheduled.

## P6d committed; P6e candidate — snapshot-bound investigation and identity probing (2026-11-04)

Mac verification reported P6d's focused tests and API build green, and its complete eight-file commit is `7a8970c`. The P6d commit follows P6c `3227ff4`, P6b `194222f`, and P6a `7c9e645`. Authenticated live HTTP/Virtual Lab smoke checks remain unreported for these boundaries.

**P6e candidate (not yet installed or accepted on the Mac):** extract only three existing snapshot-endpoint routes into `PortalSnapshotEndpointInvestigationController`:

- `POST network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/investigate` — site-owned snapshot lookup and LLM investigation (cloud consent remains explicit; recognized first-party Energrid devices excluded).
- `POST network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/refresh-identity` — delegates targeted identity refresh to its existing bounded adapter; the adapter retains its own operator-approval and network policy.
- `POST network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/probe-http` — read-only HTTP HEAD operation, denied unless approved and a fresh verified identity refresh is consumed. The existing adapter retains its HEAD-only, timeout, rate-limit, concurrency, private-IP and approved-network-scope restrictions.

The controller retains class-wide JWT/admin guards and runtime administrator assertions, and uses **one shared exact endpoint resolver** for the selected site-owned snapshot, scope, IP and endpoint ID. It additionally rejects a wrong-owner snapshot even if a future storage adapter accidentally returns one. The production `DeviceDiscoveryMemoryStore` already enforces ownership; this is a defensive check, not a different site-selection policy. Existing providers remain registered in `PortalModule`; the new controller is added to its controller list.

`PortalController` relinquishes these three optional collaborators and route methods; existing direct-construction tests are updated for its shorter constructor. Profile/history investigation, LLM proposal execution, installer interview, enrollment, reconciliation and device control are **not touched**. The test suite covers class guards, real guard denial, exact endpoint binding, missing/foreign-site snapshots, strict cloud/probe consent, first-party exclusion, fresh-identity requirements and rejected missing adapters. **No new probing capability or elevated authority is added.**

Source-only route/signature and syntax checks do not demonstrate Nest DI bootstrap, live authorization, or adapter behavior. To accept P6e, check clean patch application, run its new suite and existing `portal-control.spec.ts`, `read-only-http-identity-probe.spec.ts`/targeted-refresh regressions where present, then the uncached API build. Smoke test anonymous, viewer, admin and foreign-site HTTP requests **against Virtual Lab only**, with an adapter stub for safe approval-path tests; do not probe Home devices or execute physical switching. Review and stage only the P6e files, then commit separately. Concurrent Finance/receipt work is out of scope.
