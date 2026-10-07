# Residential planning memory

Runtime rules are read on every estimate from `residential_estimate_templates.config` (JSONB). Migration `1790294400000_residential-estimate-templates.js` creates and seeds the table. The TypeScript constant is the seed/test reference; runtime uses the database repository. Existing conversation metadata persists `coreDraft.templateVersion`, confirmed customer fields and `pendingOffer` through Pandora's existing database writes.

`pricing_catalog.base_price` remains the source of labour prices. Template fields control sockets per room, kitchen/corridor/bathroom socket allowances, route ranges, assumed appliances, default corridor/bathroom/terrace counts, `defaultPanelCode`, and plain Bulgarian `panelDescriptions` keyed by catalog code. No rebuild is needed for changes to supported configuration values. New kinds of work or new calculation semantics still require code.

The explicit layout fields `roomCount`, `corridorCount`, `bathroomCount`, `separateKitchen`, and `terraceCount` are preserved independently. One room + corridor + bathroom + separate kitchen + terrace gives five lighting points unless the customer explicitly supplies a different lighting-point count. Do not infer floor area from the word studio.

Defaults include a boiler, separate oven and hob, washer, dishwasher, and assumed AC feeds. Dryer is opt-in. Explicit absences and counts override defaults. Assumptions are not written into customer-confirmed fields. Proposed lighting, room sockets, kitchen-counter and appliance circuits are generated deterministically. Circuit counts do not add duplicate point charges. Protection suggestions are provisional, not an assertion of regulatory compliance; sizes, common routes, bathroom/corridor circuits and panel capacity need design review.

For changes that should apply only to new conversations, insert a new version and change the unique `is_default` row in a transaction. Existing conversations retain their version. Editing an existing version deliberately affects conversations using that version on their next calculation. Prices continue to come from the active catalog; versioned planning does not freeze historical rates or constitute a saved quote.

The default panel is `panel_modern`; its current price is labour only. Its seeded description explains leakage protection in ordinary Bulgarian, without asserting complete protection from electric shock. If you change package contents, update both the appropriate catalog scope and the matching template description. The template is planning data, not an electrical compliance determination.

The additive SQL was applied directly to the configured Energrid database on 2026-09-25 after testing on disposable PostgreSQL. It did not modify existing catalog prices. It is idempotent for the seeded version; the normal migration runner can record it later. Do not run the down migration on a database with template-dependent conversations.

Core handles point definitions, panel scope, price-list questions and accepted breakdown offers directly from the draft and catalog, without paid extraction. Corrections still go through extraction. A pending offer survives an intervening question and is cleared after the breakdown.

Regression replay, from `pandora-core`:

```sh
node assistant-service/scripts/test-conversation.cjs --live --followups
```

This creates one synthetic conversation and runs the reported five-turn exchange through local services. The initial estimate uses OpenAI; the four recognized follow-ups use catalog-backed responses. Unrecognized phrasing can still use the general AI path, so this is a targeted regression test, not proof of unrestricted conversational correctness.
