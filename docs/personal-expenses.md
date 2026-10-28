# Personal expenses

## Scope

Personal Expenses is an account-scoped feature in the Energrid Portal. It stores personal transactions separately from device, site, energy-telemetry and household-inventory records. Every API request requires an Energrid access token; the server scopes reads, writes, imports and deletion to the authenticated account ID.

The existing `/personal-expenses` API and Portal retain their LevelDB behavior for compatibility. Foundation V2 adds the separate `/personal-finance` account-scoped API backed by PostgreSQL. Its text proposal parser is local and provider-independent; proposals remain drafts until an authenticated user confirms them. Receipt OCR, payment integrations, and Assistant tool registration are not part of this milestone.

## Record and currency behavior

V2 keeps original amount and currency separately from EUR amount and FX provenance. Decimal operations use base-10 integer arithmetic and PostgreSQL `numeric(38,18)`; values outside that exact storage range are rejected before persistence. Computed EUR values are rounded to cents using ties-to-even. Imported EUR amounts and FX provenance are preserved as supplied. Historical BGN records without a stored EUR amount or FX rate remain unconverted and are excluded from EUR totals; the importer does not invent an exchange rate. New expenses are restricted to EUR and USD. Currency values use three-letter ISO 4217 codes, with currency-aware minor-unit precision for item totals.

New configurable categories have account-scoped stable IDs, optional descriptions and parents, and active/archived state. Create, rename, and archive operations run transactionally and append immutable category audit events. Active names are unique case-insensitively within an account; hierarchies cannot contain cycles, and a parent with active children cannot be archived. Expenses linked to a managed category retain its stable ID, so renaming updates the displayed label without changing its classification; summaries group linked expenses by ID and legacy text expenses by their original label. Historical imports remain unlinked free-text categories and are never automatically reclassified. Legacy MongoDB Extended JSON dates (`{"$date": ...}`), object IDs (`{"$oid": ...}`), JSON arrays, and wrapper objects containing an `expenses`, `records` or `data` array are accepted. JSON Lines files are also supported by the Portal importer.

## Import behavior

The existing importer and LevelDB remain available during migration. V2 provides a transactional repository import operation with account-scoped source and legacy-record unique keys; its batch either commits fully or rolls back fully. The `/personal-finance` list and summary merge PostgreSQL records with still-unmigrated LevelDB records and suppress rows already imported by legacy ID. No backfill is run automatically.

`application/historical-reconciliation.ts` provides a database-independent reconciliation function for exported snapshots. It reports source counts, exact original-currency and month/currency totals, account mismatches, and malformed rows. An identical namespaced `legacy-mongo` source ID is the only confirmed duplicate; similar transactions are review candidates and are never automatically discarded. Date, amount and currency alone do not constitute a candidate. This function does not open MongoDB, PostgreSQL or LevelDB and does not write records. A migration is not ready to commit while there are possible duplicates, validation errors, or account mismatches.

If LevelDB cannot be read, V2 list and summary requests still return PostgreSQL records and include `legacyCoverage: "leveldb-unavailable"`; the Portal warns that totals may be incomplete. This field reports LevelDB availability only and does not certify that other historical sources have been migrated. Import preview and commit return `503 Service Unavailable` while LevelDB is unavailable because duplicate checks cannot safely cover both stores.

The existing LevelDB importer accepts up to 5 MB of JSON. The V2 PostgreSQL import accepts batches of up to 10,000 records. Keep the original export unchanged until imported counts and totals have been checked. V2 writes are idempotent for stable source IDs, so an interrupted import can be safely retried.

## Storage and privacy

The legacy API stores records in `~/.energrid/personal-expenses` by default, configurable with `ENERGRID_PERSONAL_EXPENSES_DIRECTORY`. V2 adds PostgreSQL tables for merchants, expense drafts, expenses, line items, receipt metadata and immutable provenance. Receipt storage is represented by a storage key and metadata; this milestone does not implement image upload or OCR. The migration is additive and its down migration intentionally preserves the financial tables.

V2 stores receipt metadata and a storage key, but does not upload or retain receipt files. Banking credentials and external financial APIs remain out of scope. Those integrations require a separate design for provider access, consent, retention, corrections and reconciliation. The legacy `/personal-expenses` capture endpoint continues to use Energrid's existing LLM configuration; the V2 proposal endpoint uses a local parser.

## API surface

- `GET /personal-expenses` lists the signed-in account's records.
- `POST /personal-expenses` creates a transaction; `PATCH /personal-expenses/:id` edits one; `DELETE /personal-expenses/:id` deletes one.
- `POST /personal-expenses/import/preview` validates and previews a legacy export; `POST /personal-expenses/import` commits the previewed records.
- `GET /personal-expenses/ai/status` reports configured draft availability; `POST /personal-expenses/parse` extracts a reviewable draft from a text description and does not persist it.
- `POST /personal-finance/drafts/propose` creates a locally extracted, unconfirmed draft; `GET /personal-finance/drafts/:id` reads it; `POST .../:id/confirm` confirms it transactionally; `POST .../:id/reject` rejects it.
- `GET /personal-finance/expenses` queries merged V2 and unmigrated legacy records; `GET /personal-finance/summary` returns exact EUR totals with unconverted counts.
- `GET /personal-finance/categories` lists active categories; `POST /personal-finance/categories` creates one; `PATCH /personal-finance/categories/:id` renames or reparents one; `POST /personal-finance/categories/:id/archive` archives it without deleting history.
- `POST /personal-finance/expenses/import` accepts legacy records with stable `_id`, `legacyRecordId`, or `id` keys and stores each submitted batch transactionally.

All V2 ownership derives from the authenticated account principal. The API does not use site selection or request-body account IDs. Typed application methods are available for future HouseAgent integration, but no Assistant tools are registered. PostgreSQL is configured through the existing `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and optional `PGSSL` convention; local development may use the existing loopback-only `AUTH_DATABASE_URL` override. Applying the migration remains an explicit operational step.

Product summaries aggregate line-item totals in the product's original currency and unit; they do not convert mixed-currency product prices into EUR.

The implementation lives in `apps/api/src/app/modules/expenses/` and `apps/portal/src/components/expenses/ExpensesDashboard.vue`.

## Product boundary

Finance domain types, decimal rules, validation and application use cases are kept under the expenses domain/application boundaries and do not depend on Energrid sites, devices, households, Letta or Portal code. The PostgreSQL adapter, Nest controllers and account-principal adapter remain monorepo consumers/integration points. A later standalone extraction can move the domain and application packages unchanged first, then provide a standalone authentication adapter and API host; Portal and Assistant should remain clients of those operations. No service split or deployment change is part of this milestone.

The application service is constructed behind explicit repository and extraction ports, and its category operations accept a framework-independent finance account/actor context. The Energrid controller is responsible for deriving that context from the verified authenticated principal. The PostgreSQL schema still references Energrid's `auth.users` table, and expense storage/import compatibility still reads the Energrid LevelDB store through its owning API process; these are adapter-level extraction dependencies. Currency reports currently use EUR, the account reporting-currency preference is not yet configurable, and no rates are guessed for unconverted transactions.
