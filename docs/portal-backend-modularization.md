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
