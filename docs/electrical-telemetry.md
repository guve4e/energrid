# Electrical telemetry and history

## Status and boundaries

This adds a native Energrid electrical reading contract, a local durable outbox, PostgreSQL persistence, a repeatable hourly summary worker and an alternate reader behind the existing Energy page. It does not import or modify old Mongo records. The existing `gm-be` collector remains untouched.

New recording is **disabled by default**. `ENERGY_HISTORY_SOURCE=legacy` is the default, so the current page continues to use its Mongo adapter. The operator chose to keep that history until the boiler's approved meter/channel assignment is confirmed. No actual Shelly identity, installation date or channel is inferred from the word `boiler`.

```text
Native site-bus readings / supported Shelly messages
  -> device adapter
  -> approved physical device with read-power capability
  -> runtime-validated ElectricalReading v1
  -> local disk outbox (fsync; MQTT QoS 1 acknowledgment only after admission)
  -> retry/replay worker
  -> telemetry.readings + durable dirty-hour queue (one transaction)
  -> UTC hourly summaries (background worker)

History reader -> pure consumption analysis -> portal API -> any dashboard
```

The domain library has no PostgreSQL, Nest or vendor dependency. Persistence and scheduling live in the API telemetry module. The existing repository migration runner supplies the database schema; core does not ingest or own the API's live telemetry pipeline.

## Reading contract

`libs/domain-telemetry/src/lib/electrical-reading.ts` defines the versioned runtime contract, not just TypeScript interfaces. Only explicit electrical measurements are recorded. Generic `values.power`, switch states, temperatures and old framework objects are not silently interpreted as this contract.

Native example on `energrid/<tenant>/<site>/devices/<approved-device-id>/telemetry`:

```json
{
  "deviceId": "meter-1",
  "readings": [
    {
      "schemaVersion": 1,
      "channel": "em1:0",
      "metric": "power",
      "value": 2500,
      "unit": "W",
      "quality": "measured",
      "observedAt": "2026-10-11T08:00:00.000Z",
      "timestampBasis": "device-observed"
    }
  ]
}
```

The topic and envelope device ID must agree. Tenant/site/device identity comes from the approved registry; receipt time and adapter provenance come from Energrid, never from untrusted per-reading overrides. Site-bus access still requires broker ACLs and trusted publishers. This feature is not a replacement for broker authentication; existing registry announcements remain a trusted administrative bus surface.

Supported canonical metrics:

| Metric                | Unit | Meaning                                                             |
| --------------------- | ---- | ------------------------------------------------------------------- |
| `power`               | W    | Instantaneous signed active power; positive import, negative export |
| `energy_import_total` | kWh  | Cumulative imported-energy counter                                  |
| `energy_export_total` | kWh  | Cumulative exported-energy counter                                  |

Non-finite values, ambiguous units, invalid IDs, unsupported versions and invalid calendar timestamps are rejected. A known broken sample uses `quality: invalid` and `value: null`; it breaks integration continuity. Device timestamps over five minutes ahead of receipt are rejected. Old timestamps are accepted for deliberate replay/backfill.

The supported Shelly switch/EM1/EM1Data adapter supplies typed readings, handles multiple components, and converts documented Wh counters to kWh. EM1Data uses the corresponding `em1:N` measurement channel. It does not make all Shelly products or every electrical protocol supported. Source references: [Switch status](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/#status), [EM1](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/EM1/), [EM1Data](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/EM1Data/).

## Live discovery

MQTT discovery is independent of historical recording. Enable `HOME_MQTT_INGEST_ENABLED` with the verified broker while leaving `TELEMETRY_ENABLED=false` to receive live messages without writing new history. The default Shelly subscriptions include `shelly/#`, `+/events/rpc` and `+/status/+`, covering both the shared prefix and standard Gen2+ device-root topics without subscribing to the entire broker.

The adapter also accepts the existing full-status publisher's `shelly/status/<physical-id>` format. Components at the payload root are normalized inside the adapter; conflicting topic/payload identities are rejected. EM1 and EM1Data discover the same meter channel, not two devices. Unknown supported channels remain unapproved and produce no control or historical-reading effects. The Devices page lists approved entries; pending channels appear in Discovery. This live discovery inventory is in memory and is rebuilt from incoming messages after restart. It is not proof that every device on the network has reported, and it does not change the old collector or assign an appliance to a meter.

## Storage, summaries and retention

Do not wait a month to summarize. Every committed new reading marks its UTC hour and any adjacent hour within the integration boundary dirty. Every five minutes by default, the worker rebuilds up to 500 pending hours. It also runs after startup, catching up from the durable queue. Late/backfilled points dirty the same historical buckets. Workers claim work with row locks; successful work replaces the bucket rather than adding energy again.

- `telemetry.readings`: immutable canonical samples, scoped by tenant/site/device/channel/metric/time.
- `telemetry.dirty_hours`: durable pending summary work, committed with each raw sample.
- `telemetry.hourly`: versioned UTC summaries, sample counts, invalid counts, endpoint values/times, source and timestamp provenance, sample mean/min/max, counter resets, bracketed import/export power estimates and coverage.

Identical replay at the same measurement timestamp is a no-op. A conflicting value or provenance is rejected, not silently overwritten. Read-time estimates integrate only valid bracketed intervals at most five minutes apart. Empty coverage is unknown, not zero. Counter totals are **not summed**, and the portal still labels consumption as a power estimate, not a counter-derived bill.

**No raw retention deletion is enabled.** Keep raw data until a separate retention policy is chosen and validated against archive/replay needs. Hourly summaries cannot preserve every detail of heating cycles or support arbitrary new statistics. Monthly/daily totals can be built from hourly energy/coverage; time-weighted averages must use covered time, not an average of averages. Local dates and DST stay presentation concerns; UTC hours remain unique.

The existing page reads raw history (up to 31 days) for its detailed schedule/activity calculations. A separate authorized summary endpoint supports up to 366 days; it does not claim that pending/missing summary buckets are complete. Partial meter-assignment hours require raw history.

## Durable delivery and its limits

When recording is enabled, the new Energrid subscriber uses MQTT.js instead of `mosquitto_sub`. It uses an explicit stable client ID, a persistent MQTT 3.1.1 session and QoS 1 subscriptions. MQTT.js releases PUBACK only after the admitted message's canonical readings have been committed locally. Subscription failures or QoS downgrades do not report a healthy connection. Live-only mode with recording disabled keeps the existing CLI transport.

`TelemetrySpool` uses ClassicLevel/LevelDB with `sync: true` writes, atomic sample/metadata batches and an exclusive database lock. It buffers **canonical readings**, not vendor payloads. Every replay preserves the original observed/received timestamps, units, tenant/site identity and source. A complete accepted reading batch is buffered before acknowledgment. Generic live values, invalid contracts and unapproved devices are deliberately ignored, not acknowledged as historical measurements.

Every five seconds by default, and at startup, replay drains up to 500 readings without overlapping another pass. A database failure leaves the current and later readings pending for the next pass. Removal happens only after PostgreSQL commit. An uncertain commit or restart before local removal can cause duplicate delivery; identical natural keys are idempotent. This is **at-least-once**, not an exactly-once transport. Readings timestamped only on receipt cannot always be deduplicated across broker redelivery, since the device did not supply a stable measurement timestamp.

Conflicting readings and invalid restored records are atomically moved to local quarantine, preserving the original data and a fixed reason. They do not overwrite history or block unrelated replay. Quarantine counts against capacity and is not silently deleted. Investigation/recovery is operator work; stop the API and back up the entire spool before inspecting it. There is no automatic repair, conflict overwrite or quarantine-purge endpoint.

The default capacity is 100,000 readings, including quarantine. New messages that cannot fit are not allowed to evict older readings. A full/unwritable spool makes the subscriber disconnect **without PUBACK**, retrying the persistent broker session after five seconds. An uncertain local disk write freezes that spool instance to prevent sequence-number reuse; fix disk space/permissions and restart with the same spool directory. Database outages recover automatically without that restart. Startup fails closed if the enabled spool cannot open.

Deployment requirements and limits:

- Use a persistent local disk directory, outside the checkout/build tree and outside temporary storage. Restrict it to the API service account, retain it across upgrades, and back it up. Never share it on a network filesystem or delete it to clear an alarm.
- One API process owns a spool. Each independently running subscriber needs its own spool and unique stable MQTT client ID; do not run duplicate collectors for the same measurement stream.
- Device publishers must use **QoS 1 or higher** for broker replay. A QoS 1 subscription cannot upgrade a QoS 0 publication. Debug delivery status counts received QoS 0 packets to make that limitation visible.
- Broker persistence, offline/session/in-flight queue limits, message expiry and retained-subscription configuration must be verified separately. A broker that loses its session or drops messages at its configured limits cannot be repaired by a gateway buffer.
- The gateway can preserve readings already durably admitted, not measurements a powered-off meter never produced. Disk failure, lost storage and hardware that lies about flush completion remain outside the guarantee.

Primary implementation references: [ClassicLevel locking and synchronous writes](https://github.com/Level/classic-level#api), [MQTT.js handleMessage backpressure](https://github.com/mqttjs/MQTT.js#mqttclienthandlemessagepacket-callback), [MQTT.js QoS 1 ACK implementation](https://github.com/mqttjs/MQTT.js/blob/v5.16.0/src/lib/handlers/publish.ts).

## Activation

No migration or recording activation was performed automatically. Run the existing core migration workflow against the **confirmed target PostgreSQL database**, applying `1791676800000_electrical-telemetry.js` (and preceding pending migrations as appropriate). Use a least-privilege API account with access only to the `telemetry` schema and the required read/insert/update/delete operations on its work tables; it needs no rights to old Mongo or weather data. Do not run migration rollback against history you intend to keep.

Configure privately:

```text
TELEMETRY_ENABLED=true
TELEMETRY_DATABASE_URL=<private PostgreSQL connection string>
TELEMETRY_ROLLUP_INTERVAL_MS=300000
TELEMETRY_SPOOL_DIRECTORY=<absolute persistent local directory>
TELEMETRY_REPLAY_INTERVAL_MS=5000
TELEMETRY_MAX_PENDING_WRITES=100000
HOME_MQTT_CLIENT_ID=<unique stable Energrid collector identity>
```

Enable the MQTT subscription independently with `HOME_MQTT_INGEST_ENABLED=true` and its verified broker configuration. `HOME_MQTT_TLS=true` selects verified TLS; set the broker port explicitly for that deployment. Do not disable certificate verification. Existing live state remains available with recording disabled. Do not enable this path until the physical meter/channel and approved registry identity are confirmed.

A configured `TELEMETRY_DATABASE_URL` also allows reading existing native history with recording disabled. The rollup worker runs only when `TELEMETRY_ENABLED=true`. Database configuration status is not a successful connectivity check.

To switch the Energy page, set `ENERGY_HISTORY_SOURCE=telemetry` and configure `TELEMETRY_POWER_ASSETS`. Example identifiers and dates below are illustrative, **not the actual boiler mapping**:

```json
[
  {
    "id": "boiler",
    "displayName": "Boiler",
    "tenantId": "your-tenant",
    "siteId": "your-site",
    "timezone": "Europe/Sofia",
    "activeThresholdW": 500,
    "capacityLiters": 80,
    "schedule": { "start": "04:00", "end": "06:00" },
    "meters": [{ "deviceId": "verified-registry-device", "channel": "em1:0", "from": "2026-10-11T00:00:00Z" }]
  }
]
```

Assignments are effective-dated half-open intervals. A replacement ends the old assignment using `to` and starts another `from`; assignments cannot overlap. One channel cannot be assigned to two independent appliance histories for the same interval. Read-time integration never bridges different assignments. Physical device metadata stays in the existing registry; this is not a second device catalog.

The selected source is explicit. No automatic Mongo/PostgreSQL fallback or merge occurs, which prevents duplicate energy and hides neither database outages nor missing native history. Recording can run while the page still uses legacy history; changing a history source does not backfill old records.

## Endpoints and verification

The existing portal bearer token is required:

- `/portal/energy/assets` and `/portal/energy/assets/:id/history`: same page contract, selected history source.
- `/portal/energy/telemetry/status`: enabled state, durable pending/quarantined counts and capacity, spool health and restart-required flag, replay-blocked flag, stored/duplicate/rejected/failed counts and last successful write. Queue counts are `null` until the spool opens, including when recording is disabled; uninspected storage is not reported as empty. Queue accounting survives restart; other counters are process-lifetime diagnostics, not durable audit totals. After an uncertain local write, counts are refreshed on restart. Configuration is not proof of successful database connectivity.
- `/portal/energy/telemetry/assets/:id/hourly?from=<UTC-hour>&to=<UTC-hour>`: stored power rollups for the site's explicitly assigned asset. Missing buckets are not fabricated.

Unit tests cover the contract, signed power and counter handling, timestamp boundaries, gaps, duplicate/conflicting writes, transactional work queuing, source approval, atomic bounded local admission, disk-error fail-closed behavior, restart/replay, quarantine, scheduler overlap/errors, acknowledgment timing and connection changes, dated assignments, tenant/site isolation, API authorization and portal hardware labels. An isolated temporary-directory test also checks the actual local database binding, lock and reopen behavior. PostgreSQL and MQTT are mocked; these tests do not prove a deployed migration, a physical power-loss scenario or broker configuration. No live integration test or production write is needed for the suite.
