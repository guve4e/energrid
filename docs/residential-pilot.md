# Residential conversation pilot

This is an opt-in backend experiment, not the default website chat. The existing widget, normal assistant endpoint, other tenants, pricing catalogue and weather work are unchanged. Do not promote it just because unit tests pass; run and review the live scenarios below.

## Responsibilities

- Pandora owns the conversation: explicit facts with customer evidence, active estimate snapshot, proposed alternative, pending offer and revision.
- Core exposes read-only catalogue/template context and residential calculation. These endpoints do not call an LLM or write a quote.
- The model interprets intent and writes an explanation. It does not calculate prices. Responses use strict structured output, disabled provider storage and the configured model (currently `gpt-4.1-mini`).
- Reading an explanation or price list never recalculates the active estimate. A comparison stores a separate candidate. Acceptance uses its snapshot. A correction invalidates the old candidate.
- Prices are rendered from server references. The writer gets price handles instead of raw money. Missing required estimate totals are inserted by the server; invalid monetary output is rejected in favour of a factual fallback.
- Conversation state and both messages commit together with a revision check. A repeated turn ID returns its recorded reply without another model call (last ten turns retained). Concurrent losers receive a conflict and cannot overwrite newer state; they can still incur model usage.
- Every model request records tokens and estimated cost. Cost uses the configured model's existing rate table; the actual returned model version remains recorded. Early pilot runs before the accounting correction have null cost entries, not zero costs.

The pilot deliberately does not load the legacy instruction telling the assistant to refuse approximate prices and push inspections. Before rollout, reconcile that tenant profile explicitly. This pilot only covers residential estimates, not general lead capture or booking.

## Run locally

Core, from `/Users/valentinkormanov/www/energrid`:

```sh
NX_DAEMON=false node node_modules/nx/bin/nx.js run core:build:development
LOCAL_ESTIMATOR_ONLY=true ESTIMATOR_PILOT_ENABLED=true CORE_PORT=3022 node dist/apps/core/main.js
```

Assistant, from `/Users/valentinkormanov/www/pandora-core`:

```sh
NX_DAEMON=false node node_modules/nx/bin/nx.js run @org/assistant-service:build
PORT=3011 ENERGRID_PILOT_ENABLED=true CORE_API_BASE_URL=http://127.0.0.1:3001/api ENERGRID_CORE_BASE_URL=http://127.0.0.1:3022/core node assistant-service/dist/main.js
```

Both use their existing environment configuration. Core local estimator mode uses read-only database sessions. Assistant test conversations and usage are persisted in its configured database. No migration is required for pilot state: it lives in conversation metadata.

In a third terminal, from Pandora:

```sh
node assistant-service/scripts/pilot-chat.mjs
```

Use `/exit` to finish. This is a terminal test only; do not change the website's API URL to 3011 expecting the legacy widget to use these different endpoints.

## Replay and inspect

```sh
node assistant-service/scripts/pilot-replay.mjs
node assistant-service/scripts/pilot-layout-replay.mjs
node assistant-service/scripts/pilot-future-replay.mjs
node assistant-service/scripts/pilot-sockets-replay.mjs
node assistant-service/scripts/pilot-pricing-replay.mjs
```

These call the real configured model and incur API usage. The first asserts typo handling, explanation without mutation, hypothetical comparison, acceptance, retry deduplication, a question after “yes” and a price-list reply. The second asserts explicit studio/house layouts, including separate kitchen and terrace lighting spaces. During synthetic testing only, start the assistant with `ENERGRID_PILOT_DIAGNOSTICS=true` to return model decisions and validation failures; scripts then assert no validation fallback occurred. Leave that flag off for ordinary use.

API: `POST /assistant/pilot/conversations` creates a conversation; `POST /assistant/pilot/conversations/:id/messages` accepts `{message, turnId, expectedRevision}`. The response includes `reply`, `turnRevision` and current state. Reused turn IDs with different text and stale revisions are rejected. Legacy message submission rejects pilot conversations, preventing mixed owners.

## Verification and remaining rollout work

Assistant unit tests: 43 passing. The earlier full Core suite had 81 passing, 9 skipped; the added education test and catalogue adapter test both pass. Both builds pass. These test deterministic state guarantees, calculator/catalogue behaviour and provider request/accounting, not the quality of every possible model interpretation.

Live replay on 2026-09-29 passed all eight turns plus an idempotent retry: studio conversation `9c03c277-fce4-4592-a29f-203e95b3cabe`, five-space studio `7e5df1e4-9401-479d-a128-b56f5cd217c0`, six-space house `8f226939-e191-4869-8750-8736eeaa1735`. No invalid-price fallback was used in that replay. Earlier failed runs informed regression checks; this single successful replay is not evidence of universal model reliability. Remaining language issues include unnecessary follow-up questions and some formal wording; review with real business examples before promotion.

The successful replay recorded 16 model calls and an estimated USD 0.017758. All synthetic pilot calls on 2026-09-29 totalled 56 calls / 139,780 tokens, approximately USD 0.0617092 recomputed using the repository's existing input/output rates, including runs before cost recording was corrected. These are application API estimates, not billed totals or Codex usage; no current-provider-pricing claim is made. After the successful replay, deterministic rendering was adjusted to clarify comparisons and remove duplicate unit labels; unit tests and the build passed again.

Before enabling the existing widget: review live replies for intent, understandable Bulgarian, clear assumptions and scope; adapt the current API contract to opt-in per-conversation mode; cover catalogue/model outages and concurrent delivery end to end; reconcile the tenant profile; and verify normal lead-capture behaviour separately. No production promotion or profile migration has been done.

Known limits: normally up to two model requests per turn (breakdown and missing-layout replies skip the writer). A rejected informational reply gets one bounded formatting repair using the same catalogue and unchanged estimate, so that path can use three calls. No transport retries or repair loops. Bounded recent history and residential scope only. Source-message evidence does not prove every interpretation is correct. Monetary validation is a guard, not a proof of all natural-language claims. Panel labour and route allowances remain catalogue/template business assumptions requiring review; they are not a certified electrical design.

## House / future equipment regression

The interpreter now records `heatPumpPlan` and `evChargerPlan` (`future`, `now`, `none`). They are retained but not priced as ordinary appliance points. Replies quoting an estimate explicitly exclude those supply lines, protection devices, preparation and installation. A missing house room count produces a clarification rather than an invented three-room assumption.

`breakdown` is a display-only operation. It renders saved catalogue labels and amounts directly; the combined 20 socket/switch installations stay labelled as 14 sockets plus 6 switches. Acknowledging a breakdown offer cannot apply a candidate or fail because no candidate exists. Updated estimates have a coordinator-owned breakdown offer. Source evidence is the original latest message attached by the server, not a model-transcribed quote; interpretation still requires validation by replay and review.

Protection explanations are read from `residential_estimate_templates.config.education`. Supported keys: `circuitSeparation`, `protection`, `panelScope`, `futureEquipment`, `surgeProtection`. Each may override the bundled Bulgarian guidance with a string up to 3000 characters. No rates or existing database rows were changed for this fix. In particular, a labour price does not establish the number of shared or individual protective devices.

Live regression `4f4a25c0-ea6e-4767-900b-f46354ad8b72` passed the small-house → future heat pump/EV → `DObre` → `Obre` → `Davai` → shared-DTZ question sequence on 2026-09-29. It retained the estimate throughout the follow-ups, displayed six switches correctly, excluded future equipment, and did not return a 409. Some prose still needs editorial review (extra questions and analogies); the pilot remains separate from the website.

Guidance references (technical background, not a claim about Bulgarian legal requirements): [Schneider Electric on accumulated leakage and circuit subdivision](https://www.electrical-installation.org/enwiki/Sensitivity_of_RCDs_to_disturbances), [EV installation design](https://www.electrical-installation.org/enwiki/EV_charging_-_electrical_installation_design). Explain the benefit of separating faults, distinguish overload protection from leakage protection, and require equipment-specific design for heat pumps/EV charging. Do not promise that protective devices eliminate all shock risk or label every shared-RCD design unlawful.

## Adjustable starting quantities

The active database template was verified through Core on 2026-09-29: `bg-basic-v1`, with 3 sockets per living room, 3 kitchen sockets, 1 per corridor and 1 per bathroom. Thus 3 living rooms plus one corridor/bathroom starts at 14 sockets. This is one parameterized template, not separate approved floor plans or bedroom-specific database profiles. `pricing_catalog` holds rates. Changing template defaults or catalogue rates does not require rewriting the formula; use a new template version when preserving previous assumptions matters.

The template is a commercial basic example, not a regulatory minimum, unlimited electrical capacity or a limit on customer quantities. Room count includes living spaces, so Bulgarian “тристаен” must not be equated to English “three-bedroom.” Kitchen separation, terraces and actual counts remain customer-specific.

The question “A moje li kolkoto kontakta iskam az?” must be read-only until a count is supplied. Invalid model-generated quantities now preserve all saved state and route to an explanation/clarification rather than returning a customer-facing 400. A mocked invalid quantity is covered by a service test; Core/API failures remain errors and are not converted into prices.

Live replay `30fe57f6-02df-491c-b9ca-3078e0aadf0b` passed on 2026-09-29: initial three-room estimate, `da` for breakdown, the exact flexibility question with unchanged state, then an explicit total of 20 sockets updating the estimate to 960–1950 EUR at the current catalogue rates.

## Price explanations and admin conversations

The writer distinguishes a supply point with a route up to 3 m from mounting its socket/switch. At the verified catalogue rates these are 20 EUR and 10 EUR respectively; the combined socket example is calculated from the catalogue, not hardcoded. Installing a light fitting is excluded and must not inherit the socket mounting rate. Price clarification must explain the relevant amounts directly. A formatting repair reuses the same saved estimate and cannot change quantities.

On 2026-09-29 the exact customer question confusing 10/20 EUR passed the two-turn live replay in conversation `2ca8e716-9150-4d35-8bff-e21136ffc31d`: it explained both correct rates and excluded light-fitting installation without changing the estimate. Earlier runs omitted rates or returned the validation fallback, including a run with the current policy; this remains an intermittent model-reliability limitation, not a universally resolved failure. The 43 assistant tests cover successful and unsuccessful bounded repairs. The assistant build passes.

Database verification found 120 Energrid conversations, including the reported pilot conversation with 14 messages, in `assistant.conversations` and `assistant.messages`. This verifies the locally configured database, not the Pi's runtime configuration. The existing admin frontend requests `/tenant/conversations` and `/tenant/conversations/:id/messages`; the local API lacked those handlers. Added authenticated tenant-scoped list/message handlers, including pilot conversations without leads. Four focused API tests, the API build, and a read-only database query check pass; a different tenant identity returns no matching conversations. No schema migration or frontend change is required.

The API fix has not been deployed to the Pi. Its repository path and restart/deployment procedure still need confirmation. The terminal pilot on port 3011 is separate from the website and production services.
