# Portal authentication V1

Energrid Portal accounts live in PostgreSQL under `auth.users`. Passwords use Argon2id. Browser sessions use 15-minute HS256 access JWTs and opaque 256-bit refresh cookies; PostgreSQL stores only SHA-256 refresh-token hashes. Refresh rotates in a locked transaction, and reuse revokes the session. Every authenticated API request checks the account, session revocation, session version, and expiry in PostgreSQL. Roles are `admin`, `installer`, and `viewer`; V1 bootstrap creates only an explicitly requested administrator.

The migration `apps/core/migrations/1792782300000_production-auth-v1.js` creates the `auth` schema, users, sessions, refresh-token history, audit events, and login/refresh rate-limit tables. It is ordered after the existing generic measurement migration. It does not edit that migration or change electrical telemetry.

## Local Mac setup

The root `.env` in this checkout points PostgreSQL at the Pi. Local development must not use that database. Run this once from the repository root:

```sh
pnpm auth:dev:setup
```

The setup creates the dedicated loopback database `energrid_auth_local`, applies the repository migrations there through the existing `node-pg-migrate` runner, and creates ignored, mode-0600 `.env.auth.local` with a random local JWT key. It does not copy production secrets and refuses a non-loopback database. The local PostgreSQL role is the current Mac account; the generated local password placeholder is accepted only because the local PostgreSQL install uses loopback trust authentication. If local PostgreSQL is unavailable or cannot create databases, setup fails without falling back to `.env`'s Pi host.

Then explicitly create the local administrator. The password is entered twice without terminal echo and is not printed or stored as plaintext:

```sh
pnpm auth:bootstrap-admin -- admin@example.test
```

WebStorm green-arrow commands:

- `api` / `pnpm api`: API reads root `.env`, then local `.env.auth.local` overrides its PostgreSQL and auth values outside production.
- `core` / `pnpm core`: Core reads root `.env`, then the same local overrides outside production.
- `portal:local` / `pnpm portal:local`: Vite on port 4300 proxies to `127.0.0.1:3000`; the browser uses the local API account and local database.
- `portal:pi` / `pnpm portal:pi`: Vite proxies to the Pi API; accounts, sessions, trusted origin and signing keys are the Pi's. Local accounts are not copied or accepted there. The Pi must be separately migrated and deployed before this route can authenticate.

The checked-in `.idea/workspace.xml` currently has `api`, `core`, `portal`, and `portal:local` run configurations; there is no `portal:pi` green-arrow entry in that file. The `pnpm portal:pi` command is available without changing personal WebStorm settings.

If `.env.auth.local` is missing, development API startup fails explicitly because JWT keys are required; it never invents a shared fallback key. The setup file is ignored and must remain local. Remove a local account with the administrator recovery workflow or delete the isolated local database only when you intend to discard local account/session data.

## HTTP contract and authorization

- `POST /auth/login`: exact trusted `Origin`; generic invalid-credential response; returns a short access token and safe profile, and sets the refresh and CSRF cookies.
- `POST /auth/refresh`: exact trusted `Origin`, double-submit CSRF header/cookie, rotates the opaque refresh cookie, returns a new access token.
- `POST /auth/logout`: access JWT plus exact origin and CSRF; revokes the current server session, then clears cookies.
- `POST /auth/logout-all`: access JWT plus exact origin and CSRF; increments the account session version and revokes all sessions.
- `GET /auth/me`: access JWT; returns only the public profile.

The access token stays in browser memory and is sent as a Bearer header. The refresh cookie is HttpOnly, SameSite=Lax, host-only, and Secure in production. V1 local HTTP uses separate `energrid_*` cookie names; production uses `__Host-energrid_*`. Portal API calls share one auth client, which coordinates refresh in browser tabs and retries a 401 once. It does not refresh after a 403.

Portal state, discovery, enrollment, network intelligence, device proxy HTTP routes, assistant, energy, weather, and panel operations require an administrator session in V1. `/`, `/portal` (a redirect to an explicitly trusted Portal origin), `/voice/protocol`, `/voice/config`, `/voice/client`, health, and Swagger documentation expose only public shell/health/runtime metadata. Voice WebSocket messages require a current administrator access JWT. Device-proxy WebSocket upgrades remain denied because the proxy protocol does not yet preserve deterministic per-device command authorization; the HTTP proxy is authenticated and read-only by default. No authenticated user role bypasses device installation, measurement, control, safety, or execution authority.

The old `PORTAL_CONTROL_TOKEN` has no browser or API authorization path. MQTT ingestion remains machine-to-machine and unchanged. The voice replay CLI now obtains a short-lived account JWT; it does not accept the legacy token.

## Production requirements and migration safety

Production API environment must provide:

- `NODE_ENV=production` and PostgreSQL `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` (and `PGSSL=true` when required).
- `AUTH_JWT_KEYS_JSON` with an active secret of at least 32 random bytes, `AUTH_JWT_ACTIVE_KID`, `AUTH_JWT_ISSUER`, and `AUTH_JWT_AUDIENCE`.
- `AUTH_TRUSTED_ORIGINS` as an explicit comma-separated list of exact HTTPS origins. An exact loopback HTTP origin may be added only for the local `portal:pi` Vite workflow; cookies remain Secure. Wildcards and arbitrary HTTP origins are rejected.
- A TLS-terminating reverse proxy and protected systemd environment file. Never place secrets in repository files, command-line arguments, or logs.

The API fails startup on missing production keys, trusted origins, or PostgreSQL credentials. The local `AUTH_DATABASE_URL` override is accepted only outside production and only for loopback. Production uses the configured PostgreSQL connection.

### Pi 5 Argon2 runtime

The API pins `argon2` to `0.45.1`; the lockfile includes the package's prebuilt Linux ARM64 glibc N-API binary. On the Pi, install from the repository lockfile with `pnpm install --frozen-lockfile` and build there. Do not run `npm install argon2` or copy `node_modules` from macOS. The Pi install should use the packaged `prebuilds/linux-arm64/argon2.armv8.glibc.node`; it should not need a compiler toolchain. If install falls back to `node-gyp`, stop and diagnose the package/OS/ABI mismatch rather than adding build tools to production.

After install, verify the actual runtime without touching user accounts:

```sh
node -e "const a=require('argon2'); const p={type:a.argon2id,memoryCost:19456,timeCost:2,parallelism:1}; a.hash('energrid-runtime-smoke-test-only',p).then(h=>a.verify(h,'energrid-runtime-smoke-test-only')).then(ok=>{if(!ok)process.exit(1); console.log(process.platform,process.arch,'argon2id ok')}).catch(()=>process.exit(1))"
```

The API bounds concurrent login work to eight requests and concurrent Argon2 work to two operations per process. Excess work gets HTTP 429 rather than an unbounded database/hash queue; the hash working set is roughly 38 MiB at the configured 19 MiB per operation. The benchmark in this review ran on the Apple Silicon development host only; the Pi's latency and memory still need measurement after authorized SSH access is restored.

**Do not run `pnpm core:migrate:up` on the Pi as a shortcut.** Production was previously observed missing ledger entry `1792484400000_generic-measurement-history-v1`; blindly running all pending migrations could apply M1.1. Before any production auth migration, take and verify a protected off-host backup, inspect the live `pgmigrations` ledger and actual tables, and verify this auth migration against an isolated copy of the current production schema. After the protected deployment environment has exported `DATABASE_URL`, apply only the auth migration from the release checkout with:

```sh
pnpm exec node-pg-migrate up 1792782300000_production-auth-v1 \
  -m apps/core/migrations --database-url-var DATABASE_URL --check-order=false
```

In `node-pg-migrate` 9.0.0, the positional migration name is an exact file filter (`options.file`), not “run every pending migration up to this timestamp.” This command was rehearsed against a local isolated baseline with the generic-measurement migration deliberately absent: only the auth migration ran. The rehearsal used a local migration-built baseline, not a production database copy; the production clone rehearsal and off-host backup remain release gates.

Do not place the database URL in the command line or shell history. This task has not migrated or deployed production. Do not run the auth down migration after creating accounts: it drops the entire `auth` schema. For rollback after account creation, restore the coordinated API/Portal release while preserving the auth schema, or restore the pre-deployment database backup if the migration itself must be reversed.

Bootstrap refuses if an administrator already exists. Recovery is explicit and restricted to an existing administrator; it increments the session version and revokes all sessions. Expired-session cleanup is available as `pnpm auth:cleanup` and should be scheduled only against the intended production environment after deployment.
