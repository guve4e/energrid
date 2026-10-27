# Personal expenses

## Scope

Personal Expenses is an account-scoped feature in the Energrid Portal. It stores personal transactions separately from device, site, energy-telemetry and household-inventory records. Every API request requires an Energrid access token; the server scopes reads, writes, imports and deletion to the authenticated account ID.

The current milestone includes manual entry, editing and deletion, natural-language expense drafts, month and year summaries, category totals, transaction search, and import preview/commit for JSON or JSON Lines. Text capture is opt-in: the Portal asks for consent before sending the description to Energrid's configured LLM provider, and the draft is not saved until the user reviews and confirms it. Receipt image recognition and bank/payment connections are roadmap items. Receipt images and stored financial records are not sent to an LLM or financial-data provider by this implementation.

## Record and currency behavior

Records keep the original date, amount, currency, category, description, tags, and optional fuel volume. When present, the legacy EUR amount and exchange rate are retained. For imported BGN records without an EUR amount, the summary uses the fixed BGN/EUR rate `1.95583`; EUR records use their native amount. Other currencies without an imported EUR conversion remain in the transaction list but are excluded from EUR-based totals until a conversion is available.

Categories are stored as text so old and user-defined category names remain importable. Legacy MongoDB Extended JSON dates (`{"$date": ...}`), object IDs (`{"$oid": ...}`), JSON arrays, and wrapper objects containing an `expenses`, `records` or `data` array are accepted. JSON Lines files are also supported by the Portal importer.

## Import behavior

The importer first sends records to a preview endpoint. It reports valid entries, invalid records and source IDs that already exist. Confirming the preview writes records under the current signed-in account. Where a legacy MongoDB `_id` exists, it is retained as the source ID and prevents repeat imports from creating duplicates. Records without a source ID do not have this repeat-import protection.

The import endpoint accepts up to 5 MB of JSON. Keep the original export unchanged until the imported count and monthly totals have been reviewed in the Portal. Import writes are idempotent for legacy IDs, so an interrupted import can be safely retried.

## Storage and privacy

The API stores records in a dedicated LevelDB directory at `~/.energrid/personal-expenses` by default. Configure another persistent directory with `ENERGRID_PERSONAL_EXPENSES_DIRECTORY`. The directory is created with owner-only permissions on POSIX systems. The database is not encrypted by this feature; protect the host and its backups accordingly. Deployments that run the API in containers must persist this directory or the data will not survive container replacement.

The feature does not add banking credentials, receipt storage, or external financial APIs. Those integrations require a separate design that covers provider access, data consent, receipt retention, corrections and reconciliation. AI draft availability follows Energrid's LLM configuration; cloud mode requires explicit consent for each request.

## API surface

- `GET /personal-expenses` lists the signed-in account's records.
- `POST /personal-expenses` creates a transaction; `PATCH /personal-expenses/:id` edits one; `DELETE /personal-expenses/:id` deletes one.
- `POST /personal-expenses/import/preview` validates and previews a legacy export; `POST /personal-expenses/import` commits the previewed records.
- `GET /personal-expenses/ai/status` reports configured draft availability; `POST /personal-expenses/parse` extracts a reviewable draft from a text description and does not persist it.

The implementation lives in `apps/api/src/app/modules/expenses/` and `apps/portal/src/components/expenses/ExpensesDashboard.vue`.
