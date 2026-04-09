# Estimator ↔ Assistant Integration (Energrid)

This document explains how the estimation system works and how it integrates with the assistant (Pandora Core).

---

# 1. Architecture Overview

## Energrid (this repo)
Responsible for:
- estimation logic (deterministic)
- pricing catalog
- draft validation rules
- preview + persist API
- database (projects, estimates, lines)

## Pandora Core (separate repo)
Responsible for:
- conversation handling
- assistant memory/session
- collecting user input
- calling Energrid APIs
- translating results to human responses

---

# 2. Estimation Flow

## Step 1 — Assistant collects data (Pandora)

Assistant builds a structured draft:

    AssistantEstimateDraft

Example:

    {
      tenantSlug: "energrid",
      includeConsultation: true,
      points: [
        {
          kind: "power_point",
          quantity: 3,
          routeLengthMeters: 4,
          wallType: "brick"
        }
      ],
      devices: [
        {
          kind: "socket_or_switch_concealed",
          quantity: 4
        }
      ],
      panels: [],
      notes: "small renovation"
    }

---

## Step 2 — Draft validation (Energrid domain)

Function:

    validateDraft(draft)

Returns:

    {
      canPreview: boolean,
      missing: string[]
    }

---

## Step 3 — Next action decision

Function:

    getDraftNextAction(draft)

Returns one of:

### A. Ask for missing data

    {
      type: "ask_missing_field",
      field: "point.routeLengthMeters",
      question: "Каква е приблизителната дължина..."
    }

### B. Ready for preview

    {
      type: "ready_for_preview"
    }

---

## Step 4 — Preview call

Pandora calls:

    POST /core/estimator/preview

With the structured draft.

Returns:
- subtotal
- confidence
- needsInspection
- assumptions
- lines[]

---

## Step 5 — Assistant response (Pandora)

Assistant converts result into human message:

Example:

    Ориентировъчната цена за труд е около 232 EUR.
    Материалите не са включени. Препоръчителен е оглед за точна оферта.

---

## Step 6 — Persist (optional)

Only when:
- user confirms
- lead is created
- project should be stored

Call:

    POST /core/estimator/persist

---

# 3. Draft Rules

## Minimum requirement for preview

At least one valid item:
- point
- device
- panel

---

## Point rules

Required:
- quantity
- routeLengthMeters

Optional:
- wallType

---

## Device rules

Required:
- quantity

---

## Panel rules

Required:
- quantity

---

# 4. Important Design Decisions

## 1. Assistant logic is NOT in Energrid

Energrid does NOT:
- manage sessions
- store conversations
- talk to users

It only:
- validates
- calculates
- persists

---

## 2. Draft is the contract

Assistant must NOT:
- call estimator with raw text
- guess missing values

Assistant MUST:
- build structured draft
- validate it
- only then call preview

---

## 3. Preview vs Persist

Preview:
- cheap
- safe
- repeatable

Persist:
- intentional
- creates project + estimate
- used for real opportunities

---

# 5. Folder Structure

Relevant parts:

    libs/domain-estimator/
      estimate.engine.ts
      estimate.types.ts
      assistant/
        assistant-estimate-draft.types.ts
        assistant-estimate-draft.rules.ts
        assistant-estimate-draft.prompts.ts
        assistant-estimate-draft.actions.ts

    apps/core/src/app/estimator/
      estimator.controller.ts
      estimator.service.ts
      estimator-persistence.service.ts
      repositories...

---

# 6. Integration Contract (Pandora → Energrid)

Pandora uses:
- validateDraft()
- getDraftNextAction()

Then calls:
- POST /core/estimator/preview
- POST /core/estimator/persist

---

# 7. What NOT to do

- Do NOT move assistant logic into Energrid
- Do NOT call estimator without validation
- Do NOT guess missing fields silently
- Do NOT mix chat logic with domain logic

---

# 8. Mental Model

Energrid = calculator + database  
Pandora = brain + conversation  

