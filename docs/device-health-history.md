# Device Health history V1

Device health history is stored in the existing `~/.energrid/device-firmware-diagnostics`
LevelDB. The existing firmware diagnostics record remains the current-state and recent
raw-sample read model. New history keys use the same database, tenant/site/device key
partition, and LevelDB batch writer; no database or migration is added.

## Retention defaults

| Evidence | Default | Configuration |
| --- | ---: | --- |
| Raw diagnostic samples | 7 days | `HOME_DEVICE_HEALTH_RAW_DAYS` (1–30) |
| Hourly summaries | 90 days | `HOME_DEVICE_HEALTH_HOURLY_DAYS` (1–3650) |
| Daily summaries | 730 days | `HOME_DEVICE_HEALTH_DAILY_DAYS` (1–7300) |
| Significant events | 3650 days | `HOME_DEVICE_HEALTH_EVENT_DAYS` (1–7300; default 10 years) |
| Communication failures | 90 days | `HOME_DEVICE_HEALTH_FAILURE_DAYS` (1–3650) |
| Expected sample interval | 60 seconds | `HOME_FIRMWARE_DIAGNOSTICS_INTERVAL_MS` (15–900 seconds) |

The existing recorder view still returns its recent compatibility window (up to 100
events and 1,440 failures). The history query reads the independently keyed full event
and failure histories within their own retention windows. The first successful write
after this version is deployed migrates the already retained V1 event/failure arrays
into those keys. No existing LevelDB data is deleted or rewritten at startup.

## Aggregation and recovery

UTC hour/day boundaries are used for storage. Gauge summaries preserve min, max, sum,
valid count, first/last values and times, missing count, unit, and evidence source. The
average is `sum / sampleCount`; null metrics are excluded from the value count and are
reflected in missing coverage. Daily summaries are derived from the 24 hourly buckets
while hourly evidence is retained, preserving extrema and weighted sums. A very late
sample (older than the hourly window) updates its retained daily bucket with a separate
idempotency marker.

Uptime and firmware counters are stored as first/last values and deltas per boot
session. A decrease within a boot session marks a reset and makes the delta unknown;
values from separate sessions are never averaged together. Missing whole hours are
visible as gaps between bucket timestamps; an absent bucket means “no recorded sample,”
not “offline.” Partial buckets and within-window missing samples have explicit coverage
fields.

Summary writes, sample idempotency markers, compatibility view updates, and raw-window
pruning are committed in one LevelDB batch. A restart therefore either sees the old raw
window and old summaries or the new summaries and pruned raw window. Hourly sample
markers are retained with hourly summaries; late-daily markers are retained with daily
summaries. Retention cleanup is performed at most once per device per day.

Event timestamps are collector detection times because the current ESP firmware does
not report a wall clock. Event records include HTTP diagnostics provenance and the
`kind:bootSessionId` deduplication key. Legacy event records are annotated with that
provenance during migration; their timestamps are not rewritten.

## Read-only query

Authenticated Portal administrators can request current-site history through:

`GET /portal/device-health/history?granularity=hourly&deviceId=<logical-id>&from=<UTC ISO>&to=<UTC ISO>&limit=500`

`deviceId` is optional for a site-wide timeline. Supported granularities are `raw`,
`hourly`, `daily`, `events`, and `failures`; `limit` is capped at 1,000. Tenant and site
are resolved by the server from the authorized Portal context, never from query input.

This V1 endpoint exposes stored history only. It does not collect diagnostics, infer
device availability, or change enrollment or device state.
