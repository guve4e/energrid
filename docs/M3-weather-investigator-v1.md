# M3 Weather Investigator V1 (LAB)

## Local setup

This capability is opt-in and runs only when `ENERGRID_LAB_MODE=true`. It uses the existing Core PostgreSQL connection and the existing Open-Meteo weather provider. Generate a random local bridge token with `openssl rand -hex 32`, then set the same value in the API and Core environments; it must never be exposed to the Portal browser:

```sh
ENERGRID_LAB_MODE=true
WEATHER_INVESTIGATOR_ENABLED=true
WEATHER_INVESTIGATOR_INTERVAL_MINUTES=60
WEATHER_INVESTIGATOR_API_TOKEN=<same-random-local-token-in-api-and-core>
WEATHER_INVESTIGATOR_TENANT_ID=<authorized-lab-tenant-id>
WEATHER_INVESTIGATOR_SITE_ID=<authorized-lab-site-id>
```

To use the existing provider-independent API LLM gateway in Mac LAB, additionally set these values only in the LAB processes. `WEATHER_INVESTIGATOR_SITE_ID` is the locally scoped site key; the opaque ID is a random non-customer identifier used for inference and must be at least eight characters. The API consent map must contain exactly that opaque ID for the one authorized LAB site. Other sites remain disabled unless explicitly added.

```sh
# Core
WEATHER_INVESTIGATOR_PROVIDER=api-llm
WEATHER_INVESTIGATOR_OPAQUE_SITE_ID=<random-opaque-lab-site-id>
ENERGRID_API_URL=http://127.0.0.1:3000

# API
WEATHER_LLM_SITE_CONSENT_JSON='{"<random-opaque-lab-site-id>":true}'
```

Core sends only normalized 72-hour forecast fields, the prior normalized forecast, coordinates rounded to two decimal places, and the opaque site ID. It omits tenant IDs, local site IDs, display location labels, device observations, credentials, and network information. Inference travels through the Core to API bridge and the existing `LlmGatewayService`; that service uses the configured provider and requires its normal cloud-consent option. Do not add a second provider or copy credentials into Core.

Configure each installation in the Core environment with site ID, tenant ID, display location and coordinates. The map is keyed by site ID:

```sh
WEATHER_SITE_LOCATIONS_JSON='{"site-id":{"tenantId":"tenant-id","siteId":"site-id","location":"Vidin","latitude":43.9916,"longitude":22.8728}}'
```

**Fail-closed site identity (Patch 06):** The shared Core LAB token is restricted to the one exact `WEATHER_INVESTIGATOR_TENANT_ID` / `WEATHER_INVESTIGATOR_SITE_ID` pair configured in Core. All Investigator HTTP endpoints require both identifiers explicitly and reject other pairs, even if the caller has the bridge token. This is a **single-site LAB constraint**, not general multi-tenant identity or production-ready RBAC. The Portal administrator bridge and existing assistant pass their server-resolved scope; those scopes must match Core configuration.

For investigation runs, a matching, valid `WEATHER_SITE_LOCATIONS_JSON` entry is mandatory. Missing, malformed, mismatched, or out-of-range site coordinates reject the run **before a provider fetch, DB lock or write**. There is no fallback to the default Vidin coordinates. The scheduler also requires this map entry for its configured LAB site. Configuring only the token is insufficient.

Before applying the migration, verify the Core PostgreSQL host and database identify the isolated Mac LAB database (loopback host and a dedicated LAB database). Never run the migration against the Pi or the shared `energrid` database. Then run the additive migration and start the existing Core, API and Portal services:

```sh
pnpm core:migrate:up
pnpm core
pnpm api
pnpm portal:local
```

Sign in to the Portal and open **Weather**. Use **Run investigation** to run immediately. The investigation scheduler starts at Core boot and repeats every 15 minutes by default (configurable). The Portal refreshes persisted findings, where they can be acknowledged or dismissed. The Assistant answers weather questions in Bulgarian from the same site's saved evidence, including forecast capture time, provider/model and hourly evidence references.

## Data and policy

- Each run stores a normalized, bounded 72-hour hourly snapshot. The latest 48 snapshots per tenant/site are retained, plus older snapshots referenced by findings; referenced evidence is not deleted by the snapshot cleanup. A separate bounded finding/evidence archival policy is still required.
- Findings are unique by tenant, site and event episode. New episodes receive an event-type + UTC start-instant key; an overlapping episode of the same type/location reuses its prior persisted key across forecast changes. Non-overlapping episodes on the same date remain separate. Legacy date-based keys are retained when overlapping existing events are found.
- The fixture provider remains the default for tests and offline operation. Live LLM selection is opt-in, LAB-only, and additionally gated by the API's exact opaque-site consent map.
- LLM findings are checked against cited local forecast hours and event-specific measurements before persistence. The evidence validator requires continuous cited hourly coverage for the entire claimed event window. Event severity cannot exceed conservative forecast-only limits (rain: low; snow/freeze/hail: moderate; wind: moderate at 50 km/h or high at 70 km/h; forecast thunderstorm: high). These values are provisional engineering policy, **not** official alert thresholds or calibrated probabilities.
- Until verification/calibration exists, inferred findings may only declare low confidence. The fixture emits separate findings for non-contiguous weather occurrences. LLM output that overstates severity, event duration or confidence is rejected and evaluated through the existing deterministic LAB fallback.
- Official warnings are rejected until there is a verified, normalized authoritative alert-evidence contract. A boolean `alertsAvailable` flag or unverified text is not sufficient.
- Open-Meteo does not provide official warning coverage in the current provider. The system reports this as unavailable and does not generate official warning severity.
- Recommendations are checks only. This capability has no device-control path and does not implement Android push or voice announcements.

## Verification

Run the deterministic weather investigator and Portal bridge tests without live weather or LLM requests:

```sh
pnpm exec jest --config apps/core/jest.config.cts --runInBand --runTestsByPath \
  apps/core/src/app/weather/weather-investigator.spec.ts \
  apps/core/src/app/weather/weather-investigator.service.spec.ts \
  apps/core/src/app/weather/weather-investigator.controller.spec.ts
pnpm exec jest --config apps/api/jest.config.cts --runInBand --runTestsByPath \
  apps/api/src/app/modules/portal/portal-weather.controller.spec.ts \
  apps/api/src/app/modules/portal/weather-assistant-query.service.spec.ts
```

`pnpm exec tsc -p apps/core/tsconfig.app.json --noEmit`, `pnpm exec tsc -p apps/api/tsconfig.app.json --noEmit`, and a Portal Vite production build are also part of local verification. Live inference and migration must be verified only after the Core is configured for an isolated Mac LAB database and the single authorized opaque site ID is set in both processes. Official warning ingestion remains unavailable from the current provider.

## Evidence-bound validator patch (Patch 02; locally verified, not deployed)

Patch 02 was applied on the developer's Mac after Patch 01. The three focused investigator test suites passed **23/23** after Patch 02 and **27/27** after Patch 03. Core typecheck and documentation build completed without reported errors. It enforces forecast-hour coverage and provisional severity/confidence limits; it does **not** establish calibrated warning severity, production runtime integration or notification delivery. Committed as part of `0bda117`.

## Event identity and notification timestamp correction (Patch 03; locally verified, not deployed)

The previous `event_type:calendar-date` key could merge separate same-day storms, and `first_notified_at=now()` incorrectly implied delivery when a finding was merely prepared. The service now identifies separate event episodes and reuses keys for overlapping revisions. `notification_state=prepared` is not a delivered notification; `first_notified_at` must remain `NULL` until a real delivery succeeds.

A data-only migration clears those historically fabricated notification timestamps. Its original schema and correction SQL were verified against a disposable PostgreSQL database with synthetic evidence and a finding; the original `energrid` database was not changed by the test. The migration was **not** executed against the real database, and the production migration runner was not tested. Existing date-based keys remain compatible; no mass rekey is performed.

Snapshot pruning now preserves referenced evidence, avoiding the immediate foreign-key deletion problem. It can therefore retain more than 48 snapshots. Finding/evidence archival and delivery infrastructure (outbox, receipts, retries, channel deduplication, preferences) remain **unimplemented**. The actual PostgreSQL retention lifecycle beyond the synthetic migration case is not verified. Committed as part of `0bda117`.

## Site-scoped Weather read-model V1 (Patch 05; focused local verification passed, not deployed)

Core exposes a LAB-only, token-protected `GET /core/weather/investigator/read-model?tenantId=...&siteId=...`. Both scope identifiers are explicit. The API's administrator-only `GET /portal/weather/read-model` resolves the active tenant/site server-side and does not expose the Core token to the browser. The existing assistant weather-query path reads the same contract; its keyword routing is not yet a typed LLM tool interface. The older investigator `context` endpoint remains for existing LAB consumers.

The version-1 projection reports site scope, generation time, `available | partial | stale | unavailable` status, quality reasons, captured forecast timestamp, provider/model, 24-hour coverage, forecast hours, active validated findings, and `officialAlerts.status=unsupported`. It only projects persisted evidence; it neither calls upstream providers nor creates weather findings. Its initial policy requires captured evidence no older than 30 minutes (or more than 5 minutes in the future) and 24 contiguous valid hourly records. Findings must reference the latest saved snapshot. Stale/incomplete evidence withholds actionable findings and forecast hours while preserving diagnostic metadata. `automationEligible=false` in this LAB version.

**Local verification (4 November 2026):** Core read-model/investigator tests passed **21/21**; API Portal weather bridge/assistant tests passed **8/8**. Core and API typechecks were reported green. No migration was introduced. This does not verify production deployment, multi-tenant enforcement, runtime provider health or notifications.

**Open gates:** The shared Core investigator token does not bind a caller to a specific tenant/site; the unknown-site-to-default-location fallback remains; typed LLM tool registration, official warnings, calibrated severity and production notification policy/delivery are not implemented. Do not expose this LAB read-model as a production alert authority without those controls.

## Patch 07 — Read-only Weather assistant tools (local acceptance, 5 November 2026)

The authenticated House Agent uses `weather_get_forecast` (6 or 24 hours) and
`weather_get_findings` through the existing versioned, site-scoped Weather Core
read model. The old Portal weather keyword shortcut is replaced by the ordinary
assistant conversation. These tools cannot select another tenant/site, call
upstream providers, issue device commands, or deliver notifications.

**Local verification:** Focused API tests and TypeScript checks were reported
passing after applying the source patch. On 5 November 2026 the local
`energrid_auth_local` PostgreSQL database received the two Weather Investigator
migrations. A manual LAB investigation returned HTTP 201 / `completed` with a
saved forecast and zero findings (zero findings is not an error). The Portal
assistant subsequently returned a Bulgarian six-hour rainfall answer with
Open-Meteo / `icon_seamless` source, captured-at timestamp, hourly precipitation
and probability data, and explicitly unavailable official warnings. This
confirms a working local user-facing evidence path, not production acceptance.

**Open:** End-to-end tool-call tracing, unattended scheduled refresh/recovery,
production tenant authorization and ingress, official warning ingestion,
notification outbox/delivery, and user-facing Markdown/time-zone formatting.
The production Pi database and public deployment were not migrated or changed
as part of this local acceptance.

## Patch 08 — Assistant readability and Weather diagnostics (proposed; 5 November 2026)

The LAB Weather read-model forecast adds a `timeZone` property sourced from
Core's existing `WEATHER_TIMEZONE` (`Europe/Sofia`). The assistant tool keeps
UTC ISO timestamps as canonical evidence and adds Bulgarian-local display
labels (`capturedAtLocal`, `hours[].localTime`, and finding event-time labels).
If an older Core omits the timezone or returns an invalid one, the tool labels
its formatted times as `UTC`; it must not infer Sofia from the API or browser
host timezone. **This is the existing Bulgarian Weather LAB policy, not yet
per-site timezone configuration for international installations.**

The two read-only Weather tools also expose bounded diagnostic `reasonCode`
values on unavailable/stale/partial results, distinguishing Core HTTP
unauthorized/forbidden/not-found, upstream timeout/connectivity, failed scope
or contract verification, and incomplete/stale forecast evidence. Core response
bodies, API tokens, site identifiers and transport exception details are not
included in these diagnostics. This does not introduce an alert engine or
change the authorization boundary.

The Portal chat renders a deliberately limited **bold** and `inline code`
subset of assistant formatting using escaped Vue text nodes rather than
`v-html`. Other Markdown (including links) is still displayed literally.
User messages remain plain text. The old welcome caveat claiming no connected
tools is replaced with a capability-neutral statement.

**Verification pending:** Apply on the Mac checkout based on committed
`758bb5664fa608ac9a6c3b75bf6f63a0a3ab5755`; run the focused Core/API
Jest and Portal Vitest suites, Core/API TypeScript checks, Portal build and
documentation build. No live assistant acceptance, Pi migration, push or
deployment is claimed for Patch 08. The shared observability instrumenter
(`instrumentLocalTools`) was not in the selective review ZIP; end-to-end
trace persistence, operator-facing Weather health, scheduled refresh/recovery,
full site timezone policy, and notification delivery remain separate gates.

## Patch 09 — Automatic Weather readiness (Core locally runtime-verified; not deployed)

The existing `WeatherInvestigatorScheduler` remains the only owner of background LAB
investigations. It starts an initial run when Core boots, retries temporary failures
with bounded backoff, and schedules periodic refreshes (default 15 minutes, below
the 30-minute read-model freshness limit; explicit intervals still apply). On shutdown,
it cancels the next timer and never re-arms a timer after an in-flight run completes.
No chat request causes a provider fetch, and no new worker, migration, or notification
pipeline is introduced.

A protected, scope-bound `GET /core/weather/investigator/health` projects the
scheduler's **process-local** last attempt/outcome/next attempt alongside the
persisted Weather V1 read model. It distinguishes ready, collecting, no snapshot,
disabled, misconfigured, provider unavailable, collection failed, storage unavailable,
partial and stale evidence. Configuration and database errors are presented as
stable status codes: no secret, SQL exception, or coordinates are included. A fresh
forecast is still required for assistant weather facts; health information does not
change the read-model's authority or enable automated device commands.

An existing, uncommitted admin-only Portal bridge and Weather page integration expose
`GET /portal/weather/investigator/health` for the server-resolved tenant/site, and
display the latest collection attempt, success, next scheduled attempt, source and
coverage. Those API/Portal changes are outside the Core Patch 09 commit and remain
uncommitted; the Core health endpoint is independently usable. A failure of this
health call does not erase the independent dashboard. It is an operator diagnostic
view, **not** an official weather-warning feed. LAB collection history is not durable
across process restart; forecast evidence remains persisted in PostgreSQL.

Core scheduler/controller/projection tests and an isolated single-process LAB
startup, refresh, persistence and restart cycle passed. Focused Core tests, Core
build and handbook build passed. A real upstream outage, multi-process scheduling,
database-stall timeout behavior and production operation were not verified. The
public DWD route, production authorization, notification delivery and provider-owned
alert calibration remain separate work.
