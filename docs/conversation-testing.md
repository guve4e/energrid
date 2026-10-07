# Estimator conversation checks

The frontend remains the existing chat widget. Core calculates catalog-backed amounts; the assistant routes customer messages and preserves the draft. Replies give a short range first, acknowledge AC corrections, and expand the breakdown on request. No additional model call is used to rewrite prices.

## Offline (no AI cost or database writes)

In `energrid`:

```sh
node node_modules/jest/bin/jest.js --config apps/core/jest.config.cts --runInBand --runTestsByPath apps/core/src/app/estimator-v2/residential-conversation.spec.ts apps/core/src/app/estimator-v2/estimator-v2.spec.ts
```

In `pandora-core`:

```sh
NX_DAEMON=false node node_modules/nx/bin/nx.js test @org/assistant-service --runInBand
```

These check routing, draft corrections, price consistency, missing prices, exclusions, short replies, and optional controls. Extracted facts are mocked in offline checks; these do not prove model understanding.

## Live, explicit opt-in

After building both services, run Pandora API on 3001, the assistant on 3010, and read-only estimator Core on 3021. The assistant needs `CORE_API_BASE_URL=http://127.0.0.1:3001/api` and `ENERGRID_CORE_BASE_URL=http://127.0.0.1:3021/core`.

In `pandora-core`:

```sh
node assistant-service/scripts/test-conversation.cjs --live
```

Optional `ASSISTANT_TEST_URL=http://127.0.0.1:3011/assistant` targets a separate test assistant. Only localhost targets are allowed. The test creates one stored synthetic conversation and sends four turns through actual routing, extraction, catalog calculation and reply persistence. It uses paid model requests and stops at the first failure. Running without `--live` makes no requests. It does not book inspections or persist a quote.

Replay: `Remont v 3 staen apartament` → `Da, 4 klimatika` → `GOre doulu÷` → `pokaji razbivkata`.

The suite requires a labour range immediately, preserved AC quantity, stable totals on follow-ups and a detailed breakdown on request. A first live run passed on 2026-09-25. Local catalog example: 780–1590 EUR initially, 800–1640 EUR after four AC feeds. These are partial labour-scope calculations, not market prices or complete renovation quotes.

## Human tone check

Automation catches specific failures, not every awkward conversation. Occasionally review a synthetic transcript for: answering the current question, avoiding repeated questions, labelling assumptions, explaining exclusions, and not pushing an inspection before offering an available basic estimate. Add each real regression as a new scenario. Do not replace price assertions with subjective model scoring.
