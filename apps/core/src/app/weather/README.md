# Weather assessment

## Rain map numerical forecast tiles

The public `/core/weather/radar-forecast` endpoint supplies the forecast overlay used by Landing Backbone's `/weather/` map. The browser requests published DWD WMS capabilities through Core, then asks Core for an XYZ PNG tile pinned to the selected `REFERENCE_TIME` run and hourly valid time. Core fetches a bounded WCS GeoTIFF crop for that tile, validates the coverage metadata and PixelIsArea/EPSG:4326 grid, and renders precipitation amounts in `kg/m²` (equivalent to mm for the hourly accumulation) to PNG. RainViewer observations remain a separate browser layer.

The renderer uses source cell centers after applying the PixelIsArea half-cell offset. Exact zero is transparent, positive values use the versioned `precip-v6` palette, and missing coverage has a distinct hatch. It does not infer precipitation from pixel colors or interpolate across no-data. WCS crops use a one-cell halo snapped to DWD's 0.0625-degree global grid. Successful tiles are coalesced in flight and held in a 64 MiB per-process LRU keyed by product, run, valid time, XYZ coordinate and palette version.

The upstream dependency is DWD GeoServer WCS/WMS. Each upstream fetch has a 12-second abort timeout and responses are capped at 3 MiB. A WCS `No data available` XML exception is retried twice (three attempts total), then returned as HTTP 503. Other upstream HTTP/network failures return 502 and timeouts return 504. XML exceptions and malformed TIFFs never become successful cached PNGs. Unsupported or unadvertised run/time pairs return 404; invalid time/tile/palette inputs return 400. Error responses are `no-store`; only successful timestamp-and-palette-specific PNG URLs are immutable-cacheable for one day.

The route is intentionally public and read-only because the public Weather page has no user session. Core currently enables permissive CORS globally. Each process admits at most four upstream requests and 24 queued requests; each TCP peer may hold at most three active requests and 16 queued requests. Waiting peer queues are served round-robin. Overloads receive HTTP 503, and all limits release on timeout/failure. The peer key is the socket address (forwarded IP headers are not trusted); a reverse proxy therefore groups its callers under that proxy address. These in-process controls are not a distributed request-rate limit. The production ingress must preserve peer identity or enforce its own client rate limits before this can be considered abuse-resistant across users.

The Pi deployment helper builds Core, API and the separate `apps/portal` application from one clean committed `main` checkout. It does not build or publish Landing Backbone. Production inspection on 3 November 2026 found the configured Pi (`pi5`) running release `17af81dd3e39147f6e8ac193c8b8317e2e943337`; the local DWD capabilities route returned 404. Its active `portal.energrid.bg` Nginx server has neither a `/core` proxy location nor `limit_req`/`limit_conn`; `/core/...` falls through to the portal SPA. The new route must be deployed to the actual Core origin and routed before the frontend can use it. The public `energrid.bg` origin and the Landing Backbone publisher are separate/unresolved; see the release status in [audit and remaining gaps](../../../../../docs/audit-and-gaps.md). Do not treat the Pi helper as a deployment path for the public Weather page without confirming that origin mapping.

Release smoke checks, after the public route is installed, are:

```sh
curl -fsS https://energrid.bg/core/weather/radar-forecast/capabilities
: "${RUN:?choose an advertised run} ${VALID:?choose its advertised hour} ${X:?choose an XYZ x} ${Y:?choose an XYZ y}"
curl -sS -D - -o /dev/null "https://energrid.bg/core/weather/radar-forecast/${RUN}/${VALID}/8/${X}/${Y}.png?palette=precip-v6&grid=2"
```

The first response must be XML capabilities (not an HTML fallback) and advertise the selected run/hour. The second must be `200 image/png` with matching `X-Forecast-Run` and `X-Forecast-Valid-Time`. Then open `https://energrid.bg/weather/`, select the first DWD frame, scrub forward, pan and zoom, and confirm RainViewer still works before/after the boundary. The existing Pi script checks `/core/weather/performance`, `/`, and API health; it does not smoke-test the DWD route. `npm run rollback:pi` rolls back that Pi's shared API/Core/portal release only; the public `energrid.bg` Core origin and Landing Backbone artifact have no confirmed rollback command in this checkout.

Verified locally on 3 November 2026 from Core working tree based on `ddd19eef`: DWD advertised run `2026-11-03T06:00:00.000Z`. A Vidin-region tile at valid time `2026-11-03T09:00:00Z` returned HTTP 200, `image/png`, 256×256, with immutable success caching; its deterministic PNG decode contained 65,536 positive-precipitation pixels, zero transparent pixels and 142 distinct RGBA colors. In the actual Weather page at `http://localhost:5173/weather/`, the last RainViewer frame, first DWD forecast frame and subsequent hourly frames (10:00Z–14:00Z) loaded; zoom 11 around Vidin and keyboard pan loaded 15/15 forecast tiles. Stopping the local Core process produced the visible “map partly unavailable” state and hatch for a newly selected forecast hour; restarting Core and reselecting that same hour loaded 15/15 tiles again. Rain Intelligence displayed its available weather result. This is a local development check, not production deployment acceptance; the separate River Intelligence request still returns 500 because the local database lacks `river_readings`.

Focused Core coverage exercises fractional-second DWD capabilities, published-time validation, exhausted WCS no-data and network failures, no-store error responses, recovery, precipitation fixtures, missing data and adjacent XYZ edges. See the current status, deployment order and remaining ingress checks in [audit and remaining gaps](../../../../../docs/audit-and-gaps.md).

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
