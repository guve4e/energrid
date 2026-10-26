# Device Health history V1

Device health history is stored in the existing `~/.energrid/device-firmware-diagnostics`
LevelDB. The existing firmware diagnostics record remains the current-state and recent
raw-sample read model. New history keys use the same database, tenant/site/device key
partition, and LevelDB batch writer; no second database is added. Legacy event and
failure arrays are migrated lazily, per device, on that device's first successful
diagnostic write or recorded collection-failure write after this code is active. A
polling timeout can therefore migrate history while the device is unreachable; a device
that is never polled or otherwise written remains unmigrated. Reads and API startup do
not trigger migration. Completion markers and migrated rows share the triggering write's
atomic batch.

## Retention defaults

| Evidence | Default | Configuration |
| --- | ---: | --- |
| Raw diagnostic samples | 7 days | `HOME_DEVICE_HEALTH_RAW_DAYS` (1–30) |
| Hourly summaries | 90 days | `HOME_DEVICE_HEALTH_HOURLY_DAYS` (1–3650) |
| Daily summaries | 730 days | `HOME_DEVICE_HEALTH_DAILY_DAYS` (1–7300) |
| Significant events | 3650 days | `HOME_DEVICE_HEALTH_EVENT_DAYS` (365–7300; default 10 years) |
| Communication failures | 90 days | `HOME_DEVICE_HEALTH_FAILURE_DAYS` (1–3650) |
| Expected sample interval | 60 seconds | `HOME_FIRMWARE_DIAGNOSTICS_INTERVAL_MS` (15–900 seconds) |

The existing recorder view still returns its recent compatibility window (up to 100
events and 1,440 failures). The history query merges compatibility-view rows and
independently keyed event/failure rows by ID so legacy history remains visible during
migration. Therefore, successfully reading an event through the API does not prove it
has been migrated; the per-device completion marker and keyed rows are the migration
evidence. Migration copies the legacy arrays as they exist at first migration into
those keys. Later compatibility-view
rotation cannot evict migrated events; new events are appended to keyed history. Rows
and per-device completion markers share one atomic LevelDB batch, so restart recovery
cannot leave a completion marker without its rows and retrying is idempotent. The
compatibility arrays remain in place; migration does not delete them. The ordinary
retention sweep may later expire rows outside the configured windows.

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

New event records expose `observedAt` with its `server-detection-time` basis, a separate
`detectedAt`, HTTP diagnostics source, and a reference to the supporting diagnostic
snapshot. A reboot event may also carry `inferredBootAt`, calculated as collection time
minus firmware-reported uptime. This is an estimate only; it is not a device-reported
wall-clock timestamp or an exact physical reboot time. Boot-session transitions use the
first collected sample (or summary-first observation) for that session, never the
inferred estimate. If only an explicit server-detection event exists, the transition
reports that detection basis. Legacy events keep their original timestamps and absent
provenance stays unknown; migration does not manufacture a source or timestamp basis.
The `kind:bootSessionId` key remains the deduplication key for new events.

Historical Boiler Room evidence illustrates why the distinction matters: the stored
`reboot-detected` event is timestamped `2026-10-25T19:27:34.513Z`, while a later sample
for that same boot session at `20:20:35.762Z` reports uptime `14,918,604 ms`. Subtracting
that uptime estimates a boot near `16:11:57.158Z`, roughly 3 hours 15 minutes before the
server detection timestamp. The available record does not include a contemporaneous
sample at the event time, so this is not enough to establish an exact physical reboot
time or determine whether detection was delayed. The event timestamp must be read as
when the server detected/reported the session, and the uptime-derived value as an
estimate only. Pre-existing events are not rewritten to add evidence they never stored.

## Read-only query

Authenticated Portal administrators can request current-site history through:

`GET /portal/device-health/history?granularity=hourly&deviceId=<logical-id>&from=<UTC ISO>&to=<UTC ISO>&timezone=Europe%2FSofia&limit=500`

`deviceId` is optional for a site-wide timeline. Supported granularities are `raw`,
`hourly`, `daily`, `events`, and `failures`; `limit` is capped at 1,000. Tenant and site
are resolved by the server from the authorized Portal context, never from query input.
Ranges are bounded to 730 days. Hourly and daily requests use UTC-aligned boundaries so
their summary values do not silently include samples from outside the requested window.
Raw requests must fit inside the configured raw-sample retention window; older requests
must use hourly or daily rollups.
The optional cursor continues the deterministic time/device/record ordering. A site
query is limited to 100 approved diagnostic devices and 20,000 evidence records; use a
single `deviceId` when a larger range exceeds that bound.

The authenticated API adapter reads the existing LevelDB history and passes normalized
records to the pure `DeviceHealthQueryService` in `libs/domain-devices`. The response
adds typed per-device and site analysis to the existing `records` contract: gauge
min/max/weighted average/count and first/latest values; coverage and missing counts;
boot-session counter series; reported reset evidence; significant events with detection
time, timestamp basis, source and evidence references; and failures.
Counter values (including uptime) are never averaged across boot sessions. Metrics with
no samples are `unavailable`; unknown requested metrics are `unsupported`. All stored
and returned instants remain UTC. `timezone` identifies the presentation zone for API
clients to format timestamps.

Failure correlation reports the elapsed time from a failed collection attempt until a
later successful sample is observed. It is a recovery delay, not a claim about device
downtime. The current collector does not expose request duration, so that field is
explicitly `null` rather than estimated.

This V1 endpoint exposes stored history only. It does not collect diagnostics, infer
device availability, or change enrollment or device state.
