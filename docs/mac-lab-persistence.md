# Mac LAB persistence configuration

Verified on 2026-10-25 after restarting the local API and Core. This describes the Mac LAB runtime; it does not describe Raspberry Pi production.

## Runtime selection

- Start the API with `pnpm api`, Core with `pnpm core`, and Portal with `pnpm portal:local` from the repository root.
- In non-production mode, both `apps/api/src/main.ts` and `apps/core/src/main.ts` load `.env.auth.local` with `override: true`. That file is the effective local override even when the parent shell and `.env` contain different PostgreSQL variables.
- Portal runs on port `4300` and proxies `/portal` and `/auth` to `http://127.0.0.1:3000`. Core listens on port `3020`.
- Portal device requests currently resolve to tenant `tenant-demo`, site `site-home`. These are the API defaults because `.env.auth.local` does not override them.
- PostgreSQL is the local Homebrew PostgreSQL 14 instance on `127.0.0.1:5432`, data directory `/opt/homebrew/var/postgresql@14`.

## Authoritative stores

| Data | Effective store | Notes |
| --- | --- | --- |
| Enrollment and device inventory | `energrid_auth_local`, schema `device_inventory` | Authoritative enrollments for the three ESP8266 devices and two Shelly switch components. |
| Installation records and approvals | `$HOME/.energrid/local-development/registry` | LevelDB selected by `HOME_DEVICE_STORE_DIRECTORY`. Records include installation and observation authority. |
| Discovery memory | `$HOME/.energrid/local-development/discovery` | LevelDB selected by `HOME_DISCOVERY_MEMORY_DIRECTORY`. |
| Observation decisions and latest pipeline state | `$HOME/.energrid/local-development/observations` | LevelDB selected by `HOME_OBSERVATION_STORE_DIRECTORY`; HTTP observation polling is enabled. The binding JSON remains supplied by `.env` because the local override does not replace that setting. |
| Temperature/humidity history | `energrid_m13c_stage_20261024_1`, schema `telemetry`, table `measurements` | Selected by `TELEMETRY_DATABASE_URL`; `TELEMETRY_HISTORY_ENABLED=true`. It is a separate PostgreSQL database from enrollment. |
| Measurement history retry queue | `$HOME/.energrid/measurement-history-outbox` | LevelDB default used when `TELEMETRY_HISTORY_OUTBOX_DIRECTORY` is unset. |

Do not treat the `device_inventory.enrollments` rows found in the telemetry database as authoritative enrollment state. That database currently has only a partial enrollment copy. The API enrollment provider uses `DATABASE_URL` from `.env.auth.local` and `energrid_auth_local`.

## Why earlier inspections disagreed

The repository-root `.env` also contains a network PostgreSQL target. It is not the Mac LAB API/Core target after `.env.auth.local` is loaded. The earlier inspected database was that alternate target: it showed only a subset of device enrollments and did not contain the active telemetry history tables. No records were deleted or moved to resolve this.

The Portal inventory summary and Device Details are also projections from different sources. The inventory list can report an ESP8266's generic capability as `unknown`, while Device Details reports its approved `temperature` and `humidity` bindings and reads history from the separate telemetry database. `324b44` is offline, so its retained values are correctly stale while its history remains available. This UI projection difference does not mean enrollment or history is missing.

## Read-model endpoint

The API exposes `GET /portal/devices/:deviceId/read-model` in `PortalController`; it requires an administrator bearer token. After restart, the device-specific route returned `401`, while invalid control paths returned `404`, confirming the route is matched and the authentication boundary is active. I did not bypass that boundary to read its response body. The current Portal Device Details panel still loads current observations and historical measurements through its existing measurement endpoints; it does not yet call the read-model route.

## Snapshot and restart record

The 2026-10-25 recovery snapshot is at `$HOME/.energrid/lab-backups/mac-lab-20261025-073521`. It contains schema-scoped PostgreSQL dumps for both active databases and clean copies of the four active LevelDB stores. The PostgreSQL dumps were validated with `pg_restore --list` before API/Core restart.

After restart, the enrollment table still had five rows for the five distinct normalized device IDs. The active telemetry database retained temperature and humidity history for all three ESP8266 sensors. At verification time, `3254b7` was online with fresh values; `324864` and `324b44` were offline/stale with history retained. The inspected Shelly Plus 1 was fresh and showed relay state only in Device Details, with no measurement cards. No migration, re-enrollment, approval change, or Raspberry Pi operation was performed.
