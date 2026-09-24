# Weather assessment

Forecast recording, measured-observation scoring, river corrections, portal integration, and activation instructions are described in [forecast verification](../../../../../docs/forecast-verification.md). Database migration and a measured outdoor weather source are required to activate full scoring.

The dashboard requests DWD ICON Seamless and NCEP GFS Seamless through Open-Meteo. Each model retains its identity, fetch time, normalized UTC timestamps, units and availability. Both share one delivery service: model agreement is not independent-provider redundancy or a calibrated confidence probability.

Requests run concurrently, have an eight-second timeout, and are deduplicated while in flight. Available responses are cached for ten minutes; failed requests for one minute. No synthetic weather is returned on failure. Missing, invalid, stale or incomplete risk data produces an unknown assessment. Data fetched over 30 minutes ago or current readings over two hours old are stale. These are initial engineering policy values, not validated meteorological guarantees.

A usable assessment requires current gust/code fields and seven consecutive hourly readings covering the current hour through +6 hours, including gust, weather code, precipitation and rain probability. This validates risk inputs, not every measurement. Models are compared at matching hours. Disagreement means different severity, gust spread >=20 km/h, or rain probability spread >=40 percentage points. The most cautious usable severity is selected; forecasts are not averaged. Equal severity retains model order (ICON first). An unavailable model stays visible in source status.

The response preserves existing dashboard fields and adds `comparison`, `dataQuality`, `model`, `availability` and `units`. Unknown risk/severity and nullable current readings are intentional API changes; external consumers must handle them. `automationEligible` is always false. No device command integration is enabled.

RainViewer remains a separate client-side radar history display with source attribution and age labels. It is not ingested as quantitative rainfall, storm direction, or arrival-time evidence. API intelligence therefore reports radar evidence unavailable. Public RainViewer nowcast was discontinued; do not label past frames as future forecasts.

## Verification

From repository root:

```sh
node node_modules/jest/bin/jest.js --config apps/core/jest.config.cts --runInBand
node node_modules/typescript/bin/tsc -p apps/core/tsconfig.app.json --noEmit
```

Tests use fake weather responses and no external credentials. Existing river-engine tests share the runner. Live smoke checks during implementation verified both selected model requests and normalized usable responses, without calling device or paid AI services.

## Next increments

1. Make site/location configuration explicit (current location remains Vidin) and persist forecast runs with model issue time. Fetch time alone is not model-run age.
2. Add an independently hosted forecast or official warning adapter with documented coverage, units, license and availability. Keep source failures separate.
3. Add local temperature/rain/wind sensors and measure forecast error for the actual site before assigning learned weights or calibrated confidence.
4. For radar intelligence, select a source with quantitative data and coverage for the site, then test motion/arrival estimates against observations. Map tiles alone do not establish a precise storm ETA or hail forecast.
5. Add device-specific policies in dry-run mode, then test missing data, manual overrides, cooldowns and repeated forecasts before enabling execution.

References checked 23 September 2026:
- https://open-meteo.com/en/docs
- https://open-meteo.com/en/docs/ensemble-api
- https://www.rainviewer.com/api/transition-faq.html
- https://www.rainviewer.com/api/weather-maps-api.html
