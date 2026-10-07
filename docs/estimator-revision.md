# Estimator revision — 24 September 2026

## Flow and ownership

The public UI is `/estimator` in the sibling `landing-backbone` repository. It calls
`POST /core/estimator/assistant-step-v2` with `{ message, draft? }`. The server fixes
the tenant to `energrid`. The existing `assistant-step` endpoint remains compatible
with its `ESTIMATOR_V2_ENABLED` switch; existing external assistant clients are not migrated automatically.

One structured OpenAI extraction per message identifies the job and updated facts.
The existing `OPENAI_SMALL_MODEL` setting is retained (default `gpt-4.1-mini`). The
API key remains server-side. Requests have a 20-second deadline, a 700-token output
limit and `store: false`; extraction failures do not silently reuse a previous quote.
Follow-up questions and line explanations are deterministic, with no extra model call.
Official API reference: https://developers.openai.com/api/docs/guides/structured-outputs

Pricing comes from active rows in `pricing_catalog`, cached for up to 60 seconds by
the appliance catalog service. LLM output contains facts, never authoritative prices.
Incoming drafts are validated and price fields discarded. Topic changes clear
unrelated scope details. The frontend keeps the draft only in memory and shows
item quantities, unit rates, totals and exclusions. It supports printing to PDF.

## Supported calculations

- Boiler and cooker connections: `rangePreview`, with itemised min/max amounts,
  appliance quantity, extra metres **per appliance**, and separate requested chasing.
- New power points: the existing deterministic point/route calculation, including
  its disclosed shared-route chasing assumption. Point counts and per-point lengths
  must be supplied; apartment area is not converted into invented quantities.
- Panels: current active `panel_standard`, `panel_modern`, `panel_full_protection`,
  `panel_custom`, plus `boiler_panel`. Custom-panel price is explicitly a minimum.
- AC connection: an explicit individual-assessment response if `ac_connection`
  is absent. The inspected catalog had no active AC connection price.

This is one job category per conversation. Mixed projects, lighting and smart-device
catalog items are not yet assembled into one conversational bill of quantities.
Do not promise a complete house estimate from floor area alone. Different routes
should be estimated separately. Labor estimates exclude materials and are subject
to inspection; tax treatment is not configured in the catalog and is not invented.

## Existing stored estimates

`projects`, `estimates` and `estimate_lines` are written transactionally by the
existing `/core/estimator/persist` endpoint, which recalculates from the catalog.
The public preview does **not** call persistence or claim to have submitted a lead.
Range previews must not be passed to that single-subtotal persistence contract.
A confirmed range-quote workflow needs an explicit range schema/version before use.

## Activation

1. Deploy the updated core service and `landing-backbone` together.
2. Configure server-side `OPENAI_API_KEY`; retain or choose `OPENAI_SMALL_MODEL`.
3. Route the frontend's `/core` prefix to the core service, or set
   `NUXT_PUBLIC_CORE_API_BASE_URL` to the actual HTTPS API. Local development defaults
   to `http://localhost:3020/core`; production defaults to same-origin `/core`.
4. Preserve gateway request limits on the public LLM endpoint to control spend.

No catalog prices or production database rows were changed. Repository seeds still
do not recreate all current live range/panel rows; do not replace the live catalog
with the old seed script. No deployment or service restart was performed.

## Verification

- Core Jest coverage includes incomplete requests, scope switches, decimal lengths,
  conflicting connection details, multi-appliance ranges, chasing, explanations,
  malformed drafts, structured extraction and upstream failure/refusal handling.
- Domain-estimator tests cover deterministic totals and invalid catalog/input values.
- `ESTIMATOR_LIVE_TEST=true` opts into `estimator-live.integration.spec.ts`: two real
  extraction requests with synthetic details and read-only catalog queries. It passed
  on 24 September 2026. Default test runs skip it and incur no API cost.
- Frontend: `npm test` covers weather source/accuracy rendering and stale-state
  cleanup; `npm run build` validates the Nuxt app. Browser visual inspection was
  blocked by an unavailable administrator-policy security check.
