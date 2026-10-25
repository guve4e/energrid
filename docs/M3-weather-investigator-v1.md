# M3 Weather Investigator V1 (LAB)

## Local setup

This capability is opt-in and runs only when `ENERGRID_LAB_MODE=true`. It uses the existing Core PostgreSQL connection and the existing Open-Meteo weather provider. Generate a random local bridge token with `openssl rand -hex 32`, then set the same value in the API and Core environments; it must never be exposed to the Portal browser:

```sh
ENERGRID_LAB_MODE=true
WEATHER_INVESTIGATOR_ENABLED=true
WEATHER_INVESTIGATOR_INTERVAL_MINUTES=60
WEATHER_INVESTIGATOR_API_TOKEN=<same-random-local-token-in-api-and-core>
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

If no map entry exists, the existing Core location is used (`WEATHER_LOCATION`, `WEATHER_LATITUDE`, `WEATHER_LONGITUDE`, defaulting to Vidin). Invalid coordinates fall back to those defaults.

Before applying the migration, verify the Core PostgreSQL host and database identify the isolated Mac LAB database (loopback host and a dedicated LAB database). Never run the migration against the Pi or the shared `energrid` database. Then run the additive migration and start the existing Core, API and Portal services:

```sh
pnpm core:migrate:up
pnpm core
pnpm api
pnpm portal:local
```

Sign in to the Portal and open **Weather**. Use **Run investigation** to run immediately. The investigation scheduler starts at Core boot and repeats every 60 minutes by default. The Portal refreshes persisted findings, where they can be acknowledged or dismissed. The Assistant answers weather questions in Bulgarian from the same site's saved evidence, including forecast capture time, provider/model and hourly evidence references.

## Data and policy

- Each run stores a normalized, bounded 72-hour hourly snapshot. At most 48 snapshots per tenant/site are retained.
- Findings are unique by tenant, site, event type and local forecast date. Repeated evaluations update a pending finding rather than creating a second notification row.
- The fixture provider remains the default for tests and offline operation. Live LLM selection is opt-in, LAB-only, and additionally gated by the API's exact opaque-site consent map.
- LLM findings are checked against cited local forecast hours and event-specific measurements before persistence. Unsupported findings and official-warning claims without authoritative alert evidence are rejected.
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
