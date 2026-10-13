# Legacy Power History

The Energrid portal's `/energy/` page is a read-only consumer of explicitly assigned legacy power devices. The existing `gm-be` collector remains the writer. This feature does not migrate documents, publish MQTT messages, modify device settings, or calculate bills.

Native electrical recording and hourly summaries are described in [Electrical Telemetry](electrical-telemetry.md). The page stays on this legacy source by default; native recording and changing the page's history source are separate, explicit operations.

## Boundaries

- `libs/domain-telemetry`: canonical power observations, asset metadata, reader port and pure interval calculations. No Nest, MongoDB, MQTT or legacy document types.
- `apps/api/.../energy/legacy-*`: the anti-corruption adapter. Only here do `deviceId`, `type`, BSON dates and nested `value.value` exist.
- `EnergyService`: validates bounded requests, restricts assignments to the configured portal tenant/site and invokes the reader port.
- `EnergyController`: authorized, GET-only endpoints under `/portal/energy`.
- `apps/portal/.../energy`: renders normalized summaries. Room dashboards can consume the same endpoints without duplicating calculation logic.

## Configuration

Set `LEGACY_TELEMETRY_MONGO_URI` through the deployment's secret configuration. Use a MongoDB account restricted to reading the legacy database. The adapter only performs reads, but it cannot remove privileges from an existing administrative account. Never commit the connection string.

`LEGACY_TELEMETRY_DATABASE` defaults to `mqtt`. `LEGACY_TELEMETRY_ASSETS` is an explicit JSON array, for example:

```json
[
  {
    "id": "boiler",
    "displayName": "Boiler",
    "tenantId": "your-portal-tenant-id",
    "siteId": "your-portal-site-id",
    "sourceDeviceId": "boiler",
    "timezone": "Europe/Sofia",
    "activeThresholdW": 500,
    "capacityLiters": 80,
    "schedule": { "start": "04:00", "end": "06:00" }
  }
]
```

Assignments must match `PORTAL_TENANT_ID` (default `tenant-demo`) and `PORTAL_SITE_ID` / `HOME_SITE_ID` (default `site-home`). They are explicit operator-approved history bindings, not automatic discovery and not permission to control devices. Each source device should be bound only after its ownership is verified.

An optional `schedule.effectiveFrom`, a local `YYYY-MM-DD`, prevents applying a schedule to earlier history. The user confirmed early May but not an exact date, so no date is invented. Without this field, the configured window is a reference schedule throughout the requested period, not proof that the contactor was active then.

No temperature readings are fetched. `temp-bolier-room` is an outside-temperature sensor, not a tank-water probe. Temperature roles will be assigned separately when that feature is implemented.

## Read Contract

- `GET /portal/energy/assets`: canonical assets assigned to this portal tenant/site, plus connection configuration status.
- `GET /portal/energy/assets/:assetId/history?from=<UTC ISO instant>&to=<UTC ISO instant>`: summary, local daily buckets and hourly buckets with unique UTC boundaries.
- Both require the portal bearer token. This follows the portal's existing single-tenant authorization model; it is not a multi-tenant identity system.
- Reads use the existing `(deviceId, type, timestamp)` index. Only `type: power` is queried, within a maximum 31-day window, plus five-minute boundary lookups.
- Queries have timeouts and a 100,000-reading cap. A larger result fails explicitly rather than silently truncating energy.
- Configure the local portal proxy to the local API to view new API code. The standard portal defaults to the Pi API unless `PORTAL_API_PROXY_TARGET` is set.

## Calculation Rules

- Power is watts, energy is kWh, timestamps are UTC, and local day/schedule interpretation uses the assigned IANA timezone.
- Missing legacy units mean watts because this adapter binds specifically to the collector's power metric. Explicit `kW` is converted; other units are rejected. Null, booleans, empty strings, non-finite and negative values are not zero.
- Energy is a **power-step estimate**: hold the earlier power over a bracketed interval, only when both endpoints are valid and at most five minutes apart. This is not a cumulative energy meter total.
- No extrapolation after the last reading and no bridging outages. Invalid values and conflicting duplicate timestamps break continuity. Identical duplicate timestamps do not duplicate energy.
- Coverage is valid integrated seconds divided by the requested elapsed seconds. Estimates represent covered intervals only and are never scaled up to fill missing time.
- First/last days can be partial. The page shows the requested hours per day. DST days can have 23 or 25 hours; repeated local hours retain separate UTC intervals.
- Average power is time-weighted. Peak power is the largest held power in covered intervals. Active time is time at or above the configured threshold.
- Outside-schedule energy is a reference-window comparison, not a tariff calculation. No prices or night-tariff calendars are assumed.
- Legacy timestamps are collector receipt times, not verified device measurement times; this provenance is returned and displayed.
- Capacity is metadata. Without tank temperature and usage evidence, power history does not establish hot-water comfort or whether a thermostat setpoint was reached.

The cumulative counter mismatch and unreliable filtered `energy_delta` history are intentionally not used. Correct counter ingestion and a verified tariff calendar can be added behind separate ports later. Fair before/after comparisons must also account for weather, usage and coverage.

## Unit Tests

```text
pnpm exec jest --config libs/domain-telemetry/jest.config.cts --runInBand
pnpm exec jest --config apps/api/jest.config.cts --runInBand --testPathPatterns modules/energy
pnpm exec vitest run --config apps/portal/vitest.config.ts src/components/energy/EnergyDashboard.spec.ts src/portal-route.spec.ts
```

The calculations, strict normalization, configuration, query bounds, isolation, authorization and UI states are tested with local fixtures and mocked readers. Unit tests do not require a live database.
