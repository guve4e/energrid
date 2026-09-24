# Weather and river forecast verification

Forecast agreement is a comparison between models. Accuracy requires predictions saved before the event and later matched to measurements. This implementation keeps those concepts separate and does not enable automatic device control or learned model weights.

## What runs

- A Weather page in the portal shows forecast sources, disagreements, source age, measured weather scores and provisional river scores. Independent requests allow one section to remain available if another service fails. Failed refreshes clear old current forecasts.
- The API exposes only three authenticated GET routes under `/portal/weather`: `dashboard`, `performance`, and `river-performance`. They bridge to the private core service; nginx needs no new public core route.
- The weather verification scheduler runs at startup and hourly, independently of page visits. It records ICON, GFS and the selected cautious policy as separate versioned predictions. Concurrent cycles do not overlap.
- Weather predictions are immutable per location, delivery provider, model/policy version, issue-hour bucket, horizon and metric. The original fetch time, input readings and target hour are retained. Model initialization time is unavailable and stored as null, not inferred from fetch time.
- Weather lead windows are 0–1, 5–6 and 23–24 hours because forecasts use the next matching UTC hourly boundary. Hourly gust/rain windows are not recorded if they started before issue time; this normally excludes the first lead window for those metrics.
- Temperature observations are instantaneous Celsius readings (match within ±15 minutes); gusts are hourly maxima in km/h; rain is the exact hourly accumulation in mm. Interval observations must match the target window exactly. Rain probability is scored with Brier score against hourly rain >0.1 mm. Probability scores are not storm/hail accuracy.
- Evaluation waits for the matching window to close, retains the matched observation ID, and updates a forecast only once. Invalid batches are rejected before any inserts; duplicates never overwrite measurements. Backdated forecasts cannot be scored.
- Reports separate delivery provider, model version, metric, horizon and observation source. They include sample counts, MAE, RMSE, bias (observed minus predicted), Brier score and temperature skill relative to a persistence baseline from that model's issue-time current value. Baseline skill compares the same eligible samples. Small samples are visibly labeled; scores do not establish calibrated confidence or provide a fair ranking when source coverage differs.

## River corrections

The river scheduler now calls its evaluator even when collection fails. Recording uses the actual prediction issue time while retaining the older input reading time, and deduplicates within each issue hour. Version `vidin-local-linear-v2` distinguishes this issue policy from old records.

The evaluator matches station AND provider to avoid crossing gauge/source identities, waits until the full ±90-minute matching window closes, and joins eligible readings before limiting the batch so unmatched old forecasts cannot block later ones. It saves the matched provider/time and compares against persistence. The standalone evaluation script uses the same service.

Existing river scrapers do not establish reliable observation-time provenance: APPD supplies fetch time; DanubePortal parsing assumes a timezone. New river evaluations are therefore explicitly labeled `provider-time-unverified` and remain provisional. They are not evidence of precise measured-time forecast accuracy. Legacy records are preserved and reported separately; unscored legacy records are not automatically rescored under the new rules. Historical data has not been rewritten.

Only the existing local Vidin 6/24-hour forecast is recorded/scored by this river path. Regional propagation and analogue forecasts still need their own station-specific recording adapters before their separate accuracy can be claimed.

## Activation

The database migration was tested against isolated local PostgreSQL, including rollback and reapplication. It has NOT been applied to the application's database.

From the repository root, apply the migration to the intended core database using the existing migration workflow:

```sh
pnpm core:migrate:up
```

Restart/redeploy core and API after migration, and rebuild the portal. In the API environment, configure `ENERGRID_CORE_URL` as the core origin (no `/core` suffix). Default is `http://127.0.0.1:3020`; the documented Pi setup uses `http://127.0.0.1:3102`. The bridge uses the existing portal authorization mechanism. Observation ingestion remains private to core and is not exposed through that bridge.

Weather recording is enabled by default. Set `WEATHER_VERIFICATION_ENABLED=false` to disable the weather scheduler. The existing `RIVER_COLLECTOR_ENABLED` setting controls the river cycle. Recording needs the core process running; it is not an external background service.

Weather scoring requires a measured outdoor source. Configure on core:

```text
WEATHER_OBSERVATION_SOURCE=<stable outdoor station identifier>
WEATHER_OBSERVATION_TOKEN=<dedicated secret>
```

Do not substitute forecast-model “current” values or another model's forecast as observations. The installation currently remains fixed to Vidin (`43.99160,22.87280`). Confirm the outdoor station is at that location before connecting it. The core server binds source and location, rather than trusting caller-supplied labels. A source change does not mix its measurements with earlier source cohorts.

An adapter with that dedicated credential can send a batch to `POST /core/weather/observations` with `Authorization: Bearer <dedicated secret>`:

```json
{
  "observations": [
    { "metric": "temperature_c", "observedAt": "2026-09-24T12:00:00Z", "value": 21.5 },
    { "metric": "precipitation_mm", "windowStartAt": "2026-09-24T11:00:00Z", "observedAt": "2026-09-24T12:00:00Z", "value": 0.4 },
    { "metric": "gust_kmh", "windowStartAt": "2026-09-24T11:00:00Z", "observedAt": "2026-09-24T12:00:00Z", "value": 32 }
  ]
}
```

Example dates must be replaced with real measurement timestamps. Ingestion accepts up to 100 readings from the last 30 days; batches are transactional. Scoring happens on the next hourly cycle. With no station connected, the UI honestly shows “awaiting measured observations.”

## Verification commands

```sh
node node_modules/jest/bin/jest.js --projects apps/core/jest.config.cts apps/api/jest.config.cts libs/automation-core/jest.config.cts libs/domain-automation/jest.config.cts --runInBand
node node_modules/vitest/vitest.mjs run --config apps/portal/vitest.config.ts
node node_modules/vue-tsc/bin/vue-tsc.js -p apps/portal/tsconfig.json --noEmit
```

Database tests are opt-in. `FORECAST_TEST_DATABASE_URL` must point to a dedicated local database named `energrid_forecast_test`. They recreate only the `forecast_verification_test` schema there, apply the existing river schema and the new migration, exercise real SQL, and verify rollback/reapplication. Never point tests at application data.

```sh
FORECAST_TEST_DATABASE_URL=postgres://energrid_test@127.0.0.1:65432/energrid_forecast_test node node_modules/jest/bin/jest.js --config apps/core/jest.config.cts --runInBand --runTestsByPath apps/core/src/app/forecast/forecast-database.integration.spec.ts
```

Next evidence work: reliable river observation timestamps, a real outdoor weather-station adapter, station-specific scoring for regional river models, and longer prospective evaluation before changing model weights or enabling devices.
