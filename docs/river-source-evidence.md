# River source observation evidence (M1b candidate)

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
