# Generic measurement history

`telemetry.measurements` is the shared append-only history for approved numeric measurements. It is separate from `telemetry.readings` and `telemetry.hourly`, whose electrical schema and rollups remain unchanged.

## Canonical metric/unit pairs

| Metric | Unit | Validation |
| --- | --- | --- |
| `temperature` | `Cel` | At least absolute zero |
| `humidity` | `%RH` | 0 through 100 |
| `pressure` | `hPa` | Nonnegative |
| `power` | `W` | Any finite signed value |

Unknown pairs fail closed. Add a future metric by adding a trusted `MeasurementDefinition` in application code; the database stores metric and unit as text and does not require a per-metric table or a closed enum migration. Definitions may add finite minimum/maximum bounds. A changed meaning or canonical unit should use a new metric key or an explicit contract version migration, rather than silently reinterpreting old rows.

Every sample carries tenant/site scope, stable enrolled `deviceId`, optional associated physical inventory ID, component, channel, metric/unit/value/quality, source, safe provenance reference, sample ID, and observed/received UTC instants. A sample ID must be stable for retries and unique across a source restart; source counters must include a boot/session epoch or be combined with stable source observation identity. Exact replays remain duplicates after an API restart; reusing the key with changed content is a conflict. Invalid quality is represented only with a null value. Raw payloads, endpoint URLs, secrets, and IP addresses are not provenance values.

The PostgreSQL adapter is internal to `TelemetryModule` and has no controller or public arbitrary-write endpoint. Its table foreign keys require an existing enrollment and, when supplied, a physical device in the same tenant/site. Application callers must additionally be trusted ingestion code that has verified approved installation and per-field/source observation authority. M1.1 does not wire a source to this repository.

## M1.3 history write policy

The internal history writer is called only after the trusted observation ingress accepts an authorized numeric field. It does not replace the LevelDB latest-state store. The writer uses `evidenceId` plus source, selector, and metric to derive a stable sample ID, so a firmware boot session and API restart do not make a repeated HTTP sample new. A replayed LevelDB decision retries a failed history write with the same identity.

The decision is made in the same PostgreSQL transaction as the insert, under a per-stream advisory lock. It reads the last committed history row, so the threshold and heartbeat baseline survive process restarts and concurrent poll delivery. The first sample is stored; later samples are stored when the absolute numeric change reaches the configured threshold or the maximum heartbeat interval has elapsed. Sub-threshold samples are skipped. Backwards receive-clock movement delays a heartbeat until time catches up, while a meaningful value change can still be stored.

Defaults are generic metric policies, not device-specific behavior: temperature `0.3 Cel` / 15 minutes, humidity `2 %RH` / 15 minutes, pressure `1 hPa` / 15 minutes, and power `5 W` / 5 minutes. Override them with `TELEMETRY_HISTORY_POLICIES_JSON`, for example `{"temperature":{"meaningfulChange":0.5,"maxHeartbeatMs":900000}}`. New metrics require both a trusted canonical metric/unit definition and a history policy.

History writes are enabled only when `TELEMETRY_HISTORY_ENABLED=true`; this also requires `TELEMETRY_DATABASE_URL`. Keep that URL pointed at the intended database and apply the existing measurement migration separately. M1.3 does not run migrations or enable history in production.

PostgreSQL errors are logged with device, metric, and a sanitized database error code. They do not fail or roll back the already committed LevelDB observation. There is no durable PostgreSQL outbox in this chunk: a later delivery of the same HTTP sample or a later accepted sample retries against the last committed row, but a long outage can lose intermediate historical points while latest authorized state remains available in LevelDB. MQTT continues on its existing route; wiring that route to history requires a source-provided retry-stable sample identity and is not changed here.
