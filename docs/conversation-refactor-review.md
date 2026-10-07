# Energrid conversation review and proposed change map

Reviewed 2026-09-28. This is a design review, not an implementation or deployment. Application code, running services, and database configuration were not changed by this review.

## Decision

Keep the frontend, Pandora conversation storage, Energrid Core, pricing catalog, residential template table and deterministic calculators. Replace the competing interpretation paths with one Energrid conversation coordinator in Pandora. Core should validate and calculate structured inputs; it should not reinterpret the same customer message using a second model.

Separate services are not the root problem. Split decision-making, contradictory instructions and incomplete shared context are.

## Evidence from the current implementation

| Location | Observed behavior | Consequence |
| --- | --- | --- |
| Pandora `chat/chat.service.ts` | Keyword/regex gate forces some messages to the estimator; others go to AI routing. | Typos change the entire conversation path. |
| Pandora `ai/ai.service.ts` | A text-generating call chooses `assistant_reply` or `call_estimator`. Invalid routing JSON falls back to raw generated text. | This is a text router, not a validated tool loop. |
| Active `assistant.assistant_configs` row for Energrid | Says: “If the user asks for price, explain what affects the price and guide toward inspection. Do not calculate or guess numbers.” Tone is “confident, technical, professional, but approachable”. | The observed inspection pitches and terminology are encouraged by stored instructions. “Never invent prices” must remain, but quoting calculator results must be explicitly allowed. |
| Pandora `ai/prompts.ts` | Adds lead qualification, 1–3 questions and moving toward consultation/contact capture. | Competes with the user's goal of a useful initial estimate and one clear question. |
| Profile loading | `estimator.mode` and `hints` are loaded, but the inspected routing prompt does not consume those hints. | Editing hints alone would not reliably change behavior. |
| General AI context | Receives history plus stage, `hasDraft` and a summary of the last price. No complete draft, pending offer, catalog rows, or priced scope. | It cannot reliably explain inclusions or act on “yes”. The lastPreview TypeScript interface also omits range fields even though runtime summaries can contain them. |
| Core `estimator-v2.service.ts` | Residential keyword follow-up handler OR a separate extraction model, followed by merging and calculation. | A second interpretation boundary; information questions can become updates if misclassified. |
| Core response generation | Fixed reply branches independently detect explanations, corrections and requests for details. | Correct totals can still produce an irrelevant or repetitive answer. |
| Draft | Confirmed fields and a template version exist; one `pendingOffer=breakdown` value is supported. | Useful foundation, but no general comparison, pending change proposal, source evidence or state revision. |
| Estimate persistence in conversation | Orchestrator stores `coreDraft` and price summary, not the full priced snapshot/assumptions. | The general assistant loses the detailed basis of the quote. A read-only explanation currently recalculates with the active catalog, so a catalog edit can change the price even without a customer change. |
| `ConversationsService` | Current user message is included in history and separately passed as the latest message. Meta update and assistant-message insert are separate writes; no expected state revision. | Duplicate input and possible concurrent-turn/lost-update inconsistencies. |
| Cost accounting | Pandora records routing usage. Core extraction uses a separate request and does not return its usage through this flow. General replies can trigger extra conversation analysis; estimator replies return early. | The displayed tenant usage is not a complete accounting of conversation cost. |

These findings come from source inspection and a read-only query of the active Energrid profile. No claim is made that every unused-looking helper is dead code; references must be checked before deletion.

## Target responsibilities

Pandora owns the conversation, authenticated tenant, history, state revision, pending choices and final natural-language answer. One LLM interprets customer intent and requests bounded backend operations. It sees both assistant questions and customer answers, with their roles preserved.

Core owns catalog/template reads, field validation, default expansion, circuit proposals and arithmetic. Add a typed residential calculation endpoint accepting structured facts and template version, without invoking extraction. Existing preview APIs do not yet provide the complete residential contract; this needs a small adapter, not a new calculator.

The LLM must not supply prices, tariff codes selected without validation, a tenant identity, or a persisted estimate total. Tool results supply those facts. A model proposes operations; application code validates and executes them.

## Operations and state contract

| Customer intent | Allowed operation | Persistent effect |
| --- | --- | --- |
| “What is a smart relay?” / panel question | Read current scope and relevant catalog descriptions | No change to confirmed facts or estimate |
| “What would two relays cost?” | Calculate a comparison against the current revision | Store a labelled candidate if offered; active estimate unchanged |
| “Add two relays” / “Actually, four ACs” | Validate explicit fact changes, calculate, commit | New state revision and estimate snapshot |
| “Yes” | Resolve a specific pending offer | Breakdown offer only shows detail; accepting a specific candidate applies that candidate; ambiguous assent asks a short clarification |
| Unclear “ve stai” | Ask for clarification | Preserve existing facts; no invented count |
| Price list | Read catalog | No change to the estimate; do not invent a public URL |
| Greeting, service question, off-topic | Conversational answer with bounded business context | No quote mutation |

Proposed versioned state, initially compatible with the existing metadata JSON:

- `schemaVersion`, `revision`.
- `confirmedFacts`: value and source customer-message ID; corrections supersede values explicitly.
- `templateVersion`, derived assumptions and proposed circuits separate from confirmed facts.
- `activeEstimate`: complete lines, included/excluded work, totals, currency, template snapshot, catalog rate snapshot and calculation timestamp.
- `pendingOffer`: kind, referenced estimate/candidate revision and proposed change, if any.
- `candidateEstimate`: optional comparison, not the active quote.

Meaningful protections must be implemented in code, not only prompts: read operations cannot mutate state; comparison operates on a copy; writes require validated fields, the expected revision and an explicit change/acceptance action. Referencing a message alone does not prove customer consent; ambiguous model decisions must return a clarification rather than commit. Retry the same turn idempotently. Commit the state and associated assistant turn atomically, or serialize turns with an equivalent tested mechanism.

## Prompt and configuration changes

Create one Energrid policy that resolves conflicting instructions deliberately. Keep company facts separate from behavioral directives. Preserve factual business configuration and other tenants' existing behavior.

- Quote verified estimates when available; do not invent a price or replace it with an inspection pitch.
- Explain in everyday Bulgarian, including Bulgarian written in Latin letters. Default to a few short sentences and at most one useful question.
- Explain technical terms only when needed. Do not upsell smart devices simply because the customer asks what they are.
- Assume only published template defaults and identify important assumptions. Clarify unclear evidence rather than confidently guessing.
- Offer inspection when it resolves an identified uncertainty or the customer requests it. No appointment confirmation without an actual booking mechanism and explicit user request.
- Information, comparison and requested change are distinct actions, including in mixed sentences.

Migrate the conflicting active profile entries as an explicit, reviewable configuration change with a saved rollback copy. Do not just append contradictory instructions at the end of another prompt.

## Concrete change map

| Component | Change |
| --- | --- |
| Frontend/chat widget | Keep the present API and appearance. |
| Catalog + template repositories, calculator functions | Keep; expose typed calculation/read results. Audit calculation semantics separately rather than changing pricing during this refactor. |
| Pandora `ConversationsService` | Keep request entry point and persistence. Add coordinator, bounded context, versioned state and retry/concurrency handling. |
| Pandora `ChatService` and `AiService` | New Energrid mode bypasses keyword routing. Use a bounded structured operation loop, then compose a natural answer from verified results. Preserve legacy path for other tenants and rollback. |
| Shared AI client | Add a separate validated operation interface; its current `generateText` wrapper has no tool support. Avoid changing unrelated callers. Verify exact provider API details at implementation time. |
| Core estimator | Reuse residential and appliance calculations. Add non-LLM structured calculation adapter; keep existing assistant-step-v2 during transition. |
| Core extraction + fixed follow-up replies | Keep on legacy path until replay passes; then remove from the new conversation path. No further keyword patches as the primary design. |
| Profile/config | Remove inspection-first conflict and technical-tone mandate for the new mode; actually consume the intended estimating policy. |
| Usage recording | Record every model step, including final composition and any retry. Avoid routine full-history analysis during simple estimate turns. |

## First implementation slice

1. Freeze a fixture catalog/template and save all reported transcripts as scenarios with behavioral assertions. Preserve current calculator totals; this is not a tariff redesign.
2. Add the structured residential calculator adapter, state snapshot and operation validation. Prove read versus comparison versus update independently of the model.
3. Add one Energrid-only conversation coordinator behind an opt-in mode using the existing frontend contract. Give it the canonical facts, last relevant turns, pending offer and required catalog results. Remove duplicated latest-message injection in that path.
4. Replay a studio and a house, with typos, separate kitchen/terrace, relay explanation, hypothetical relay comparison, explicit addition, “yes, but…” and price-list questions. Check state after each turn, not just the text.
5. Compare old/new transcripts using fresh isolated conversation IDs and the same price fixtures. Review tone manually; switch only local test traffic initially. Keep mode selection on each conversation so an in-progress chat does not bounce between engines.

Do not delete the old path, alter catalog prices, introduce a frontend redesign or migrate all historical conversations in this slice.

## Acceptance gates

- All confirmed-layout tests retain the five lighting spaces; uncertain room count remains unknown until clarified.
- Information questions leave confirmed facts and the active estimate snapshot byte-for-byte unchanged, including when catalog prices are subsequently edited.
- “What would two cost?” produces a comparison; “add two” applies it once. Duplicate delivery does not add twice.
- A leading “yes” does not override a substantive question. Stale proposals cannot overwrite a newer correction.
- Displayed rates, units and totals agree with tool results; model-generated numbers are not authoritative. Use structured price references and server validation, with a factual fallback if validation fails.
- No forced inspection before an available basic estimate; no unsupported appointment confirmation.
- Catalog/API/model failures are distinguishable and never become a fabricated quote.
- Tests include new paraphrases/typos not copied into prompt examples, so success measures more than memorized strings.
- Record full per-turn usage, latency, operation selection and state revision without logging customer message contents by default.

## Cost and limits

One conversational owner does not mean one model request per turn. A practical bounded loop may need an interpretation/tool-selection call and a final response call for calculation turns; simple informed answers may use one. Set a request/tool-round cap, measure actual usage and compare against the current router + extraction + optional analysis path before claiming savings. Reuse unchanged snapshots and omit unnecessary catalog rows/history.

Remaining domain limits stay visible: the current range covers listed labour, not the complete renovation; route-length allowances and panel labour assumptions need business review; an ambiguous appliance word such as “печка” is not automatically proof of two separate appliances. The conversation refactor must not hide these issues behind more fluent prose.

Recommended next action: implement the residential slice above after reviewing this map. No service consolidation or broad rewrite is justified by the evidence.
