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

## Daily verification and automatic observations

The hourly cycle also saves populated daily precipitation totals, maximum gusts, and minimum/maximum temperatures for each usable model and for `daily-cautious:weather-v1`, the **actual per-day selection** used by the daily cards. Its input retains the chosen source model, agreement state, selection reason and original fetch time. This is a selection policy, not a trained blend. Each issued-hour snapshot is immutable. Negative temperatures are valid; missing values are not recorded as zero.

Daily lead time is the difference between local calendar dates, from 1 to 10 days ahead. It is not a fixed 24/72/168/240-hour lead: the exact issue timestamp is retained and displayed. Today is excluded because a whole-day prediction issued after midnight would include already-observed weather. Existing hourly verification covers shorter windows. No old forecast is reconstructed from today's model output.

Daily evaluation uses only the same source, location, metric and exact local-day interval. The existing hourly path sums precipitation and maximizes gusts **only when every one-hour measurement interval is present**. Local days have 23, 24 or 25 hours in `Europe/Sofia`. Missing measurements, duplicate coverage, misaligned intervals and unknown values do not become zero. A complete precipitation day can be scored even when gust observations are missing. Precipitation includes liquid-equivalent snow; it is not liquid rain alone. Average wind speed is not substituted for peak gusts.

The native daily path stores reports in `weather_station_daily_observations`, not in the hourly observation table. A report date is not an observation instant: `lastReportDate` is separate from `lastObservedAt`. Daily rain is never divided into invented hourly amounts. Each metric is independently available, so missing gusts do not prevent recording rain or daily temperatures.

Native daily reports are scored only after the station's reporting-day convention is verified against station/operator evidence. A date string, a `00:00:00` label, or a timezone in metadata alone does not prove the period. Until verification, reports have null interval boundaries and `period_basis=unverified`; they remain visible as collection evidence but unscored. Verified reports must match the forecast's date, metric, source, location, timezone and exact UTC interval, with a nonempty period reference. The saved score retains the daily observation ID and `station-daily-local-calendar-day` time basis, separate from `complete-hourly-intervals`.

Observations are immutable. Identical reports are harmless duplicates. If the provider revises a previously stored daily value, the batch is rolled back and the collection status reports the revision; existing observations and scores are not silently rewritten.

`GET /core/weather/performance` preserves the hourly response and adds:

- `daily.summary`: errors by provider, model/policy version, metric, calendar lead day and observation source; both saved-snapshot counts and distinct verified-day counts.
- `daily.recent`: latest saved prediction per day/model/metric/lead/source, its issue time, measured result and error.
- `daily.pending`: future predictions and past predictions awaiting complete measurements.
- `collection`: source configuration, current collection status, station coordinates/distance, granularity, latest measurement or report date, next collection time and received metric names. No credential is returned.

Snapshots within a day are correlated. The portal bases its limited-evidence warning on distinct verified days, not on inflated snapshot counts. These summaries are not a fair model ranking unless they cover the same days and lead windows. They do not change model weights automatically.

The optional Meteostat adapter uses fixed official `/stations/meta` and `/stations/hourly` or `/stations/daily` endpoints, `model=false`, `units=metric`, a timeout and no redirects. Hourly requests specify `tz=UTC`; the daily endpoint has no timezone parameter. It verifies station identity and coordinates, rejects stations more than 25 km from the configured Vidin forecast location, and displays the actual distance. Nearby measurements remain a **station proxy**, not a measurement at the house. A 14-day lookback picks up delayed reports; missing metrics remain missing. Upstream errors never expose credentials and do not stop forecast evaluation.

Collection requires explicit opt-in. A database-backed atomic claim limits each source to one attempt per 24 hours, including failures and across process restarts. Metadata plus data normally use two requests per day, approximately 60 per 30 days; this is a request budget, not a guarantee about a provider's current pricing. Collection status is persisted with that claim. The forecast scheduler still records predictions hourly.

Configure these variables **on core only** to enable collection:

```text
WEATHER_OBSERVATION_PROVIDER=meteostat
WEATHER_OBSERVATION_COLLECTION_ENABLED=true
METEOSTAT_STATION_ID=<verified station ID>
METEOSTAT_API_KEY=<RapidAPI credential>
METEOSTAT_GRANULARITY=hourly
METEOSTAT_INTERVAL_LABEL=<start or end>
```

The interval label must be verified against the selected station's original accumulation/gust time convention; it is deliberately not guessed from a timestamp. `end` means the preceding hour; `start` means the following hour. Instantaneous temperature timestamps are not shifted. Source identity includes station and interval convention, so changing either cannot silently combine their evidence. The existing authenticated private station ingestion remains available as an alternative; do not configure it as the automatic station source.

For native daily reports, use `METEOSTAT_GRANULARITY=daily`; an hourly interval label is not needed. Leave the period settings unverified unless supported by original station/operator documentation:

```text
METEOSTAT_DAILY_PERIOD_VERIFIED=false
METEOSTAT_DAILY_TIMEZONE=Europe/Sofia
METEOSTAT_DAILY_PERIOD_REFERENCE=
```

Setting the verified flag to true also requires a nonempty reference and station metadata timezone matching `Europe/Sofia`. Source identities distinguish `meteostat:15502:daily-unverified`, `meteostat:15502:daily-local-Europe-Sofia-v1`, and the existing hourly interval conventions. Changing conventions cannot silently combine their evidence.

At implementation time, no Meteostat credential or station was configured in this installation. Public metadata for `15502` (Vidin) lists `43.8167,22.8833`, about 19.5 km away, and its public station page shows daily history but no hourly inventory. The supplied daily sample contains rain and minimum/maximum temperatures but null gusts; it does not establish exact daily period boundaries. This is **not confirmation of usable hourly rain/gust coverage**. No automatic fallback to reanalysis, interpolated point data or model-filled measurements is used. Collection remains disabled at the user's request; obtaining a key does not itself enable collection.

Sources: [Meteostat hourly API](https://dev.meteostat.net/api/stations/hourly), [daily API](https://dev.meteostat.net/api/stations/daily), [station metadata](https://dev.meteostat.net/api/stations/meta), [Vidin station](https://meteostat.net/en/station/15502).

## River corrections

The river scheduler now calls its evaluator even when collection fails. Recording uses the actual prediction issue time while retaining the older input reading time, and deduplicates within each issue hour. Version `vidin-local-linear-v2` distinguishes this issue policy from old records.

The evaluator matches station AND provider to avoid crossing gauge/source identities, waits until the full ±90-minute matching window closes, and joins eligible readings before limiting the batch so unmatched old forecasts cannot block later ones. It saves the matched provider/time and compares against persistence. The standalone evaluation script uses the same service.

Existing river scrapers do not establish reliable observation-time provenance: APPD supplies fetch time; DanubePortal parsing assumes a timezone. New river evaluations are therefore explicitly labeled `provider-time-unverified` and remain provisional. They are not evidence of precise measured-time forecast accuracy. Legacy records are preserved and reported separately; unscored legacy records are not automatically rescored under the new rules. Historical data has not been rewritten.

Only the existing local Vidin 6/24-hour forecast is recorded/scored by this river path. Regional propagation and analogue forecasts still need their own station-specific recording adapters before their separate accuracy can be claimed.

## Activation

The original verification migration is already applied in this installation. Daily verification adds the independent, reversible migration `1791936000000_daily-weather-verification.js`; it does not modify existing forecasts, observations or legacy Mongo data. Inspect pending migrations before using the general workflow below: do not apply unrelated migrations just to enable this table.

On 2026-10-14 the daily migration was applied on its own to the current core database, core was rebuilt/restarted, and the first 52 available daily metric predictions were recorded. Observation collection remains unconfigured; no measured accuracy is claimed. Other pending migrations were not applied.

On 2026-10-15, `1792022400000_station-daily-observations.js` was dry-run and applied on its own. It adds native daily observation storage, persistent collection claims, daily temperature forecast metrics, and score provenance. Core was rebuilt/restarted with `WEATHER_OBSERVATION_COLLECTION_ENABLED=false`. No sample observations were imported into application data, no API key was configured, and unrelated pending migrations and legacy Mongo collections were untouched. Its down migration refuses destructive rollback when new temperature forecasts or native daily observations exist.

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

## Daily explorer data

`GET /core/weather/dashboard` also returns `dayDetails`, ordered to match `daily`.
The portal weather bridge forwards this unchanged. Room dashboards can consume the
same data without inheriting the general page's layout or selection state.

Each entry contains the local calendar `date`, `timezone`, UTC `startsAt`/`endsAt`,
the day's chosen `sourceProvider`/`sourceModel`, all available hourly parameters,
coverage, statistics, and the available models' daily forecasts for comparison.
Hourly data always comes from the source selected for that particular day.
Daily totals remain the provider's daily totals; they are not replaced by sums of
partially available hourly data.

Coverage distinguishes complete, partial, and unavailable hourly forecasts. It
counts 23 or 25 hours on daylight-saving transition dates. Null measurements remain
null; hourly lines break at missing intervals. Wet hours and rain windows count
available hours with at least 0.1 mm of forecast precipitation. Humidity and pressure
averages use available values only. Statistics are forecasts, not observations.

The general page and portal default to today in the forecast timezone, preserve a
chosen date across refreshes, and fall back to today or the first forecast date when
the chosen date leaves the horizon. Selecting a day does not change current weather
or recent radar observations. No storage migration is needed for these details.

## Separate dashboard rain map

The rain map remains in `landing-backbone/public/weather`; it is not added to the portal. It now has one continuous observed-to-forecast timeline, initially paused at the available radar frame nearest 15 minutes ago. Recent observed frames continue into hourly forecast frames across a labeled Now marker. One play/pause control loops the complete selected timeline. A native range input reaches every frame; up to 13 sampled dot controls keep the line compact on phones. The dots are navigation landmarks, not the total frame count. Actual observed/forecast counts, dates, selected time and model run remain visible in Sofia time. The horizon can end today, in 24 hours, or at the last available forecast (default).

Observed data comes from fresh, validated past RainViewer frames using their supplied opaque tile paths. The player does not reconstruct paths from timestamps or accept a different tile host. RainViewer's public archive is two hours at ten-minute intervals (normally 13 frames including both endpoints), but the unified timeline starts near now rather than at the beginning of that archive.

Forecast maps come directly from DWD's public `Icon-eu_reg00625_fd_sl_TOTPREC01H` WMS layer, with no API key. Its metadata declares a 0.0625-degree ICON-EU grid, hourly precipitation totals, coverage including Vidin, and forecast steps +1 through +78 hours from each model run. The adapter parses the layer-specific WMS capabilities using the browser's XML parser, validates location coverage, rejects malformed dimensions and runs older than 18 hours, and emits only future times declared for that exact run. Every map request pins both valid time and `DIM_REFERENCE_TIME`; it cannot silently pick a different model run. The displayed amount is accumulation over the preceding hour, not an instantaneous rain intensity or a daily total. An official DWD color legend is available when a forecast frame is selected.

The map removes the old layer when crossing from radar to forecast, labels the selected source explicitly, and hides the live storm diagnostics on forecast frames. Native zoom 7 bounds unnecessary requests for both sources; images can be enlarged on the map. Providers refresh independently of the core weather API and fail independently: a failed radar source cannot hide a valid forecast, and a failed forecast refresh removes its old frames without hiding fresh radar. Total failure clears overlays, timestamps and playback. No forecast map is used as a measured observation, no verification scores or learned weights change, and external Meteostat collection remains disabled.

RainViewer discontinued public future/nowcast frames on January 1, 2026. Future frames here are therefore explicitly **DWD hourly model forecasts**, not RainViewer radar extrapolation, a trained Energrid blend, or ten-minute nowcasts. No intermediate rain movement or missing frames are invented.

Sources: [RainViewer transition FAQ](https://www.rainviewer.com/api/transition-faq.html), [weather maps API](https://www.rainviewer.com/api/weather-maps-api.html), [DWD geoservices](https://www.dwd.de/DE/leistungen/geodienste/help/nutzung_geodienste.html), [live ICON-EU hourly precipitation capabilities](https://maps.dwd.de/geoserver/dwd/Icon-eu_reg00625_fd_sl_TOTPREC01H/wms?service=WMS&version=1.3.0&request=GetCapabilities).

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

Next evidence work: verify a station's daily reporting period or a real hourly source, reliable river observation timestamps, station-specific scoring for regional river models, and longer prospective evaluation before changing model weights or enabling devices.
