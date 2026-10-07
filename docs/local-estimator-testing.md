# Local backend testing

The frontend stays as the original page and floating chat widget. The separate estimator
conversation/plan UI and local launcher have been withdrawn; the test frontend on port
5174 has been stopped. No new frontend design is required for the estimator.

## Isolated estimator API

From the Energrid repository:

```sh
NX_DAEMON=false npx nx run core:build:development
LOCAL_ESTIMATOR_ONLY=true CORE_PORT=3021 node dist/apps/core/main.js
```

The API uses the existing server .env for the catalog and OpenAI key. Local-only mode
binds to loopback, enables PostgreSQL default_transaction_read_only, and starts only
estimator modules. It does not start weather collectors or device automation.

Explicit replay (four paid model calls, no quote writes):

```sh
node apps/core/scripts/test-local-estimator.cjs --live
```

The studio example retains property type, area, construction stage and appliances
across turns. The backend keeps a versioned circuit proposal and assumptions internally.
Replies acknowledge new facts, use short paragraphs and ask a relevant follow-up.
They do not require customers to complete a new form or type an exact acceptance phrase.

The initial circuit template covers studios up to 40 m². Boiler/AC presence comes from
the customer. Cooker/washer circuits are provisional until confirmed and can be removed.
No cable sections, breaker ratings or regulatory certification are inferred from area.
Whole-dwelling pricing still requires quantities, routes and site/design review.

## Existing floating widget

The original widget uses its configured Pandora assistant API. For local full-stack
testing, run Pandora with ENERGRID_CORE_BASE_URL=http://127.0.0.1:3021/core and point
the frontend's existing NUXT_PUBLIC_ASSISTANT_API_BASE_URL to that local assistant's
/assistant URL. Configure CORS_ORIGINS to include the frontend origin. The assistant
defaults to port 3010 and uses its own database/configuration; it is not started by the
isolated estimator command above. Unlike the isolated estimator, the full assistant
persists conversations in its configured database.

Pandora's Energrid handoff now uses assistant-step-v2 and carries bounded prior customer
messages. It preserves price ranges and clears stale prices for planning proposals.
Other tenant routes are unchanged. These changes have not been deployed to hosted services.

Technical background for the protection-device distinction:
https://www.electrical-installation.org/enwiki/Form_factors_of_RCDs
