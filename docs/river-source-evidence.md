# River source observation evidence (M1b candidate)

## M2.1 offline APPD daily-data experiment (verified 5 November 2026)

The offline files in `data/river-history/raw/{novo-selo,lom}/` contain the official APPD daily PDFs for 2024 and 2025. The extraction CLI is `apps/core/scripts/river-history/extract-appd-annual.py`; it retains the APPD open-data URL, document year, station, river kilometre, gauge-zero elevation and datum, calendar date, daily mean water level (cm), discharge (m³/s) and temperature (°C). Blank metric values remain blank. Negative levels are valid relative to gauge zero; no observation timestamp is inferred.

Independent reconciliation scans the PDF text with `pdftotext -raw`, normalizes form-feed page separators, reads the printed date and H (cm) column, and compares every date/value to the extracted level CSV. The report is `data/river-history/reports/validation/appd-levels-2024-2025.json`: Novo Selo and Lom each have 366/366 dates in leap-year 2024 and 365/365 in 2025; zero duplicate dates, missing dates, or level mismatches across 1,462 rows. Four negative Novo Selo readings on 7–10 July 2025 (−2, −9, −12, −9 cm) match the source PDF. The PDF states Novo Selo km 833.600, gauge zero −26.75 m and Baltic Sea–Kronstadt datum; Lom km 743.300, gauge zero +22.65 m and the same datum. Source URLs point to APPD's open-data page. Discharge/temperature are extracted from the same rows when present; the reconciliation report specifically checks the level column.

The isolated baseline report is `data/river-history/reports/validation/lom-persistence-2025.json`. It uses 2024 as development history and evaluates every target date from 2025-01-01 through 2025-12-31. For target date *t* and horizon *h*, prediction is the level dated *t−h*; thus only information dated no later than the forecast origin is used. The complete 2024 series supplies the origins for the first two January targets; all 365 dates are scored at both horizons. At +1 day, MAE is 12.0356 cm (rising 149 / 14.1342 cm; falling 202 / 11.3218 cm; unchanged 14 / 0.0000 cm). At +2 days, MAE is 21.8822 cm (rising 149 / 25.5101 cm; falling 202 / 20.2277 cm; unchanged 14 / 7.1429 cm). Direction is classified from the actual target-day change versus the preceding day; these subsets are descriptive evaluation, not predictor inputs.

APPD's annual daily tables do not establish when a reading was published or first became available. The availability assumption is therefore hypothetical, and these retrospective scores are **not real-time operational accuracy**. The data supports a reproducible next-stage offline investigation, but not a claim of operational forecast readiness or a production forecast change.

## M2.2 upstream forecast experiment (offline, verified 5 November 2026)

The reproducible comparison is `apps/core/scripts/river-history/backtest-daily-persistence.py`; machine-readable results are `data/river-history/reports/validation/upstream-forecast-2025.json`. All three predictors were compared on the same 365 Lom target dates in 2025 at both horizons. Persistence predicts the Lom level at issue date. Local trend adds `alpha ×` the most recent daily Lom level change. Upstream-informed adds `beta ×` a lagged Novo Selo daily level change to that local trend. Changes are within-station differences, so the gauges' distinct zero elevations are not mixed as absolute levels.

Model selection used 2024 only. The predefined local coefficient set was −0.5, 0, 0.5, 1, 1.5. Upstream candidates added coefficients −1, −0.5, 0.5, 1 and daily lags 1–7. For each horizon, 2024 MAE selected local alpha 0.5 and upstream alpha 0.5, beta 0.5, lag 6 days. No 2025 error selected parameters. Inputs end no later than issue date `target − horizon`; absent upstream history makes a candidate date ineligible during development. The reported 2025 comparison is paired on the common eligible target dates.

| Horizon / approach | MAE (cm) | Change vs persistence | Rising MAE (n) | Falling MAE (n) | Unchanged MAE (n) | Median / p90 / max absolute error (cm) |
|---|---:|---:|---:|---:|---:|---:|
| +1 persistence | 12.0356 | baseline | 14.1342 (149) | 11.3218 (202) | 0.0000 (14) | 10 / 24 / 71 |
| +1 local trend | 9.5397 | 20.7% lower | 10.8960 (149) | 8.9530 (202) | 3.5714 (14) | 7 / 21.5 / 65.5 |
| +1 upstream-informed | 12.4589 | 3.5% higher | 13.7919 (149) | 11.8292 (202) | 7.3571 (14) | 9.5 / 27 / 76 |
| +2 persistence | 21.8822 | baseline | 25.5101 (149) | 20.2277 (202) | 7.1429 (14) | 18 / 45 / 102 |
| +2 local trend | 19.0082 | 13.1% lower | 21.9832 (149) | 17.7351 (202) | 5.7143 (14) | 15.5 / 39.5 / 97.5 |
| +2 upstream-informed | 20.9315 | 4.3% lower | 24.1879 (149) | 19.2426 (202) | 10.6429 (14) | 17 / 44 / 111.5 |

Largest misses were concentrated on fast changes: persistence missed by 71 cm on 2025-04-01 at +1 and 102 cm on 2025-01-12 at +2; local trend's corresponding largest misses were 65.5 cm (2025-04-01) and 97.5 cm (2025-01-12); upstream-informed reached 76 cm (2025-04-01) and 111.5 cm (2025-01-12). Local trend improved both horizons in this single holdout year. The upstream-informed approach did not consistently beat persistence and had larger worst misses, so the evidence does not justify adding upstream model complexity. This is one retrospective year and assumes daily values are available at the issue date; true publication latency remains unknown, so operational accuracy cannot be claimed.

**Status:** prepared source change; database migration and end-to-end collection are **not yet verified or deployed**. Do not run the full Core migration backlog on the Pi or another shared database for this milestone.

## The two distinct records

- `river_source_observations` retains *parsed source evidence*: provider/station, level, discharge, river kilometre, source-reported date/time text, time-quality classification, optional verified `observed_at`, and first/last fetch instants. Repeated polls of identical reported values update `last_fetched_at` and `poll_count` instead of fabricating new gauge measurements. A change to the readings creates a new evidence identity. Data with an unknown measurement instant remains useful for display and source troubleshooting, **not time-series prediction**.
- Legacy `river_readings` remains the existing hourly prediction/history table. M1a already refuses new writes unless observation time is verified. M1b **does not** reclassify, delete, convert or retroactively validate its older rows. Existing historical trend and verification queries may still read old unverified rows: those outputs must not be treated as calibrated predictions until separately audited.

Both paths are owned by the existing `RiverCollectorService`; no additional polling scheduler is introduced. The new archive writer is **off by default** (`RIVER_SOURCE_EVIDENCE_ENABLED=true` enables it only after the target database migration is verified). The new store is a single persistence class, not a generic data ingestion framework. Neither Portal nor LLM tools automatically consume the raw evidence table.

## Identity and limitations

`source_key` is a SHA-256 hash of the provider, station, source-reported date/time text, observation time/basis and measurement values, explicitly excluding the fetch instant. This is **source-content deduplication**, not proof of a unique physical gauge measurement. If an unknown-timestamp source returns the same values again after changing away and back, the matching content shares one row; `first_fetched_at` and `last_fetched_at` record the observed fetch span, not a continuous level measurement.

Station names and datum references are not yet normalized or verified across providers. `river_km` is not gauge elevation. No automatic alert or prediction is enabled by these raw records.

## Before accepting or enabling collection

1. Confirm an isolated database target and backup. Verify which prior Core migrations are recorded, then apply only `1793923200000_river-source-observation-evidence.js` through a reviewed, isolated migration procedure. Do not automatically migrate the Pi.
2. Run focused `river-source-observation.store.spec.ts`, provenance and existing River tests plus the Core typecheck.
3. Exercise duplicate polling and changed-value ingestion against an isolated PostgreSQL database; confirm `source_key` uniqueness, `poll_count`, and the distinct original time/fetch time columns.
4. Set `RIVER_SOURCE_EVIDENCE_ENABLED=true` only in the isolated development Core environment, restart Core, and verify a fresh collector cycle records unverified APPD/DanubePortal evidence without inserting trusted hourly `river_readings` rows or forecasts.
5. Only after these checks, review station metadata, measurement time semantics, old river history and the forecast evaluator for separate remediation.
