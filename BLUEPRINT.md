# DirectNEXT — Build Blueprint

Living roadmap so we don't lose track between sessions. Update the checkboxes
as steps land. This file lives at the repo root — commit it alongside code
changes so the history shows what changed and why.

Source material this is derived from: `Agent Technical Reference v2`,
`Platform Development Plan`, `Architecture & Ecosystem Brief`, `Demo` (all
uploaded once, not re-uploaded each session — just referenced here).

---

## Ground rules (don't relitigate these)

- **No real PHI, ever.** Everything is synthetic. Free/public data sources
  only (see Data Sources section below).
- **Rules are the floor.** Any LLM-backed check can only *tighten* a
  decision (add a hold/flag), never loosen one a deterministic rule already
  made. If an LLM call fails or is unavailable, fall back to rules-only —
  never block on an AI outage.
- **No new hosting unless the agent is genuinely a separate party.**
  Default to adding a function inside the existing backend that calls a free
  LLM API. Only spin up a new Render service the way we did for
  payer-simulator (separate DB table, separate console) when that's
  actually warranted.
- **Every step here should be small enough to deploy and test on its own** —
  same incremental pattern as everything built so far.

---

## Status board

| # | Step | Agent(s) | Status |
|---|------|----------|--------|
| 1 | A03 narrative check via free LLM (drug pre-selection + contraindication flag) | A03 | ✅ Done — 2026-08-24 |
| 1b | Correction: A01 built + sequenced BEFORE A03 (was missing entirely; A03 was wrongly doing A01's insurance-completeness job) | A01, A03 | ✅ Done — 2026-08-24 |
| 1c | A01 gates before any record is created; cost-estimate UI removed (speculative before a therapy is chosen) | A01, storefront | ✅ Done — 2026-08-24 |
| 1d | Telehealth + Pharmacy partner consoles — real clinician-entered clinical data instead of synthesized; minimum-necessary field contracts actually wired up via `scopeFields()` for the first time | A02-adjacent, contracts | ✅ Done — 2026-08-24 |
| 1e | Pharmacy multi-status fulfillment workflow (PA/payment/dispense/ship/deliver), structured eRx-lite prescription, drug+quantity pricing module, patient payment-method choice, pharmacy↔telehealth info-request channel, telehealth now sees full identity (name/DOB) not just patient_ref. `insurance_pa` and `logistics` folded into pharmacy sub-statuses. | A01/A02/A06-adjacent | ✅ Done — 2026-08-24 |
| 1f | Bug fixes: silent write failures on patient payment endpoints (raw REST for writes behind requirePatientAuth); phantom `safety_check` stage removed; pharmacy console now sees patient name/DOB; storefront `req()` header-merge bug (POST bodies silently unparsed when an Authorization header was added); payer→backend callback now checks response status instead of assuming success; SLA values set to real targets (intake 3 min, telehealth 2h); "Simulate/remind partner" now available on every stage, non-destructively for console-owned ones; dashboard shows pharmacy sub-status as its own column | A01/A03/payer/pharmacy | ✅ Done — 2026-08-25 |
| 1g | Storefront redesigned as a single-drug DTP site (fictional "Clarivex®" for plaque psoriasis) — persona-segmented hero, persistent Important Safety Information module, disease→drug→cost→support information architecture, structurally inspired by real DTC pharma sites (Repatha.com) with entirely original fictional content. Condition is no longer patient-chosen; the whole channel is one product. | storefront | ✅ Done — 2026-08-25 |
| 1h | Dashboard audit trail bug fixed — was silently truncated to `.slice(-6)`, making any journey past a couple of stages look like it only had current-step history; now shows the full trail in a scrollable panel. Added a patient-facing "download my complete journey" JSON export (own data only, behind existing patient auth) — a pharma-side/compliance version of this is explicitly deferred, since it would need real dashboard authentication first (the dashboard is currently unauthenticated by design, specifically because it never carries PHI). | dashboard, patient portal | ✅ Done — 2026-08-25 |
| 2 | A01 upgraded to LLM-assisted benefits/coverage parsing (beyond the current rule-only version) | A01 | 🔲 Not started |
| 3 | A02 real rule-based clinical routing (partner + licensure table — currently one implicit telehealth partner, not a routing decision yet) | A02 | 🔲 Not started |
| 4 | A05 heuristic abandonment/friction worklist on the pharma dashboard | A05 | 🔲 Not started |
| 5 | A04 per-partner dwell-time baselines (beyond flat SLA sweep) | A04 | 🔲 Not started |
| 6 | A08 hardening — fail-closed ledger test, anomaly detector stub | A08 | 🔲 Not started |
| 7 | A07 heuristic adherence/refill scoring, wired into the refill stage | A07 | 🔲 Not started |
| 8 | Agent registry relabeling — plane (M-ORCH/M-GOV), EU AI Act tier, kill-switch runbook fields | mesh-wide | 🔲 Not started |
| 9 | Real payment gateway integration (currently a demo "pay now" button, no real money movement) | A06-adjacent | 🔲 Not started |
| 10 | Optional field-level encryption for PHI columns (defense-in-depth on top of the existing RLS/view boundary) — discussed, not yet built | infra | 🔲 Not started |
| 11 | Dashboard authentication + a "compliance" role — needed before an internal (pharma-side) full-journey PHI export can be built safely | infra | 🔲 Not started |

## Current SLA targets (backend/src/workflow.js)

| Stage | SLA | Basis |
|---|---|---|
| Intake & Consent | 3 minutes | Synchronous check (A01+A03 both evaluate within the same request) — this SLA is really "how long is it OK for a held journey to sit unnoticed," not a processing time |
| Telehealth Visit | 2 hours | Upper bound of a stated 1–2 hour clinician response target — the SLA is the breach threshold, not the expected time |
| Pharmacy Fulfillment | 96 hours | Placeholder — not yet derived from a real target, covers the whole PA/payment/dispense/ship sub-flow |
| Adherence & Refill | 720 hours (30 days) | Placeholder — matches a typical monthly refill cadence, not tuned further |

The SLA sweep (backend/src/sla-sweep.js) now runs every 60 seconds (was every
5 minutes) — needed once intake's SLA dropped to 3 minutes, or a breach
could sit undetected for up to 5 minutes.

Mark a row ✅ **Done** (with the date and commit/file list) once it's deployed
and tested — not just written.

---

## Step 1 + 1b — A03 narrative check, A01-before-A03 sequencing, and the completeness/consent handoff (done)

**What it does now:**
- **A01** runs first, *before any patient/journey record is created*. It's
  the single gate for: intake completeness, consent captured, and (if the
  patient chose insurance) the insurance fields needed to attempt a
  coverage check. A rejection here creates nothing — no patient, no auth
  account, no journey — and is still logged to the audit trail with
  `journeyId: null` since there's nothing to attach it to yet.
- **A03** runs second, only once A01 has cleared. It no longer duplicates
  any completeness/consent checking — it's purely the clinical/policy layer
  now: the Gemini-backed narrative check for drug pre-selection and any
  contraindication-adjacent mention.
- The storefront no longer shows an insurance-vs-direct cost estimate at
  intake — removed because the actual therapy hasn't been chosen yet (that
  happens at the telehealth visit), so any cost figure shown before that
  would be speculative and potentially misleading.

**Files touched:**
- `supabase/migration-4.sql` — `patients.narrative`
- `supabase/migration-5.sql` — registers A01, adds `journeys.pa_required`
- `backend/src/agents.js` — `checkEligibility` (A01) now owns completeness
  + consent + insurance-field checks; `checkIntakeCompleteness` removed
  (folded into A01); `guardrailCheck` (A03) stripped down to just the NLP
  layer
- `backend/src/routes/intake.js` — A01 gates before any DB writes; A03 runs
  after, purely clinical
- `storefront/src/App.jsx` — narrative textarea; cost-comparison UI and
  `THERAPY_PRICING` removed entirely; step renamed "Coverage" (was
  "Coverage & Cost")

**New env var:** `GEMINI_API_KEY` on the backend only. Free at
https://aistudio.google.com/apikey.

**Fallback behavior:** A03's LLM layer fails open to rules-only if Gemini
is unavailable. A01 is pure rules (no LLM) — if the A01 agent itself is
killed via the dashboard, it fails open per its ORCH plane (never blocks a
patient), though in practice a genuinely incomplete submission would then
just hit a database constraint error instead of a friendly message — an
acceptable edge case for a killed demo agent, not worth over-engineering.

## Step 1d — Telehealth + Pharmacy partner consoles (done)

**What it does:** two new static pages, each calling new backend endpoints
under `/api/partner/*`. This is the first place `contracts.js`'s
`scopeFields()` is actually used for a real partner boundary (it existed
since early on but nothing called it until now):

- **Telehealth console** — sees `patient_ref`, `condition`, `narrative`,
  `preferred_contact`. Never insurance/payer info — this is the
  prescribing firewall (a clinician's decision shouldn't correlate with
  what a payer might reimburse). The clinician documents the visit
  themselves (diagnosis, prescribed therapy, medical necessity) instead of
  the platform synthesizing it — that's what now feeds the prior auth
  request. Any "Guardrail advisory" flag from A03 shows here, since the
  clinician is the actual human it was meant for.
- **Pharmacy console** — sees `patient_ref`, `shipping_address`,
  `prescription` only. Never diagnosis, narrative, or insurance detail —
  none of it is needed to dispense and ship.

The pharma dashboard's "Simulate next" button no longer works on
`telehealth`, `insurance_pa`, or `pharmacy` — those three stages only move
from their own partner console now. `logistics` and `refill` still use the
generic simulate button since they don't have dedicated consoles yet (Step
9).

**Files touched:**
- `backend/src/contracts.js` — real telehealth/pharmacy field scopes
- `backend/src/routes/partners.js` (new) — queue + complete endpoints for both
- `backend/src/routes/journeys.js` — `simulate-next` now refuses all three console-owned stages
- `backend/src/eligibility-check.js` — removed `synthesizeClinicalSummary` (superseded by real clinician input)
- `backend/src/index.js` — mounts `partnersRouter` at `/api/partner`
- `dashboard/src/App.jsx` — greys out "Simulate next" for all three console-owned stages
- `partner-consoles/` (new folder, new deploy) — `index.html`, `telehealth.html`, `pharmacy.html`

**Deployment:** two new Render **Static Sites**, each with its own URL —
same Vite pattern as storefront/dashboard, not plain static HTML:
- Root Directory: `telehealth-console`, Build Command:
  `npm install && npm run build`, Publish Directory: `dist`, Environment
  variable: `VITE_API_URL` = backend URL
- Root Directory: `pharmacy-console`, same build command and publish
  directory, same `VITE_API_URL`

No manual URL-pasting on the page itself — it's baked in at build time,
identically to how the storefront and dashboard already work. Add both new
site URLs to the backend's `ALLOWED_ORIGINS`.

## Step 1e — Pharmacy status workflow, structured eRx, pricing, cross-partner requests (done)

This is a real workflow redesign, not an addition on top of the old one —
`insurance_pa` and `logistics` no longer exist as separate top-level
stages. `STAGES` is now just `intake → safety_check → telehealth →
pharmacy → refill`. Everything that used to be a separate stage — prior
auth, payment, dispensing, shipping — is now a `pharmacy_status`
sub-state, matching how this actually works in practice (pharmacy-
initiated PA at the point of dispensing, not an automatic upstream gate).

**The new flow:**
1. Telehealth completes a visit with a **structured, eRx-lite
   prescription** (drug name, NDC, strength, form, SIG, quantity, days
   supply, refills — not a single free-text "therapy" string) — this is
   what NCPDP SCRIPT's NewRx message actually carries, minus the literal
   EDI segment syntax, which adds nothing to a demo.
2. The backend's **pricing module** (`backend/src/pricing.js`) computes a
   cash price and an insurance-copay estimate from the drug + quantity,
   the moment the prescription is written. Deterministic/synthetic, same
   stub pattern as every other agent here.
3. The journey advances straight to `pharmacy`
   (`pharmacy_status: prescription_received`), and the prescription +
   pricing are visible on **both** the patient's dashboard and the
   pharmacy console at the same time.
4. The **patient** picks cash or insurance on their own dashboard
   (`POST /api/patient/fill-payment-choice`). Cash immediately opens a
   demo payment request; insurance just records the choice.
5. If insurance: the **pharmacy** (not the platform automatically) clicks
   "Initiate prior authorization" in their console, which fires the same
   payer-simulator flow built earlier, now correctly framed as a
   pharmacy-initiated PA using the clinical justification the clinician
   already documented — not a bare eligibility check.
6. If cash: the patient sees a "Pay $X now" button on their dashboard
   (`POST /api/patient/pay`) — a demo action, no real payment gateway
   integrated (flagged explicitly, see limitations).
7. Once approved/paid, the pharmacy console shows Dispense → Mark in
   transit → Mark delivered, in order. Delivery is what finally advances
   the journey to `refill`.
8. **Pharmacy → telehealth info requests**: at any point, the pharmacy can
   request clinical notes or lab results from the clinician who saw the
   patient (`pharmacy_requests` table) — always through the backend, the
   clinician responds in their own console, never a direct pharmacy-to-
   telehealth link anywhere in the system.

**Corrected earlier design:** the telehealth console now sees the
patient's real name and DOB (`FIELD_CONTRACTS.telehealth` was withholding
this — overcautious; the actual firewall is insurance/payer information,
not the patient's identity from their own clinician).

**Files touched:**
- `supabase/migration-6.sql` — pharmacy_status, fill_payment_method,
  prescription, pricing_quotes, pharmacy_requests, payment_requests;
  updates `journey_dashboard_view` to include pharmacy_status (not PHI)
- `backend/src/workflow.js` — STAGES simplified to 5 stages
- `backend/src/contracts.js` — telehealth scope corrected; pharmacy scope
  extended
- `backend/src/pricing.js` (new)
- `backend/src/eligibility-check.js` — now pharmacy-triggered, updates
  `pharmacy_status` instead of advancing `current_stage`
- `backend/src/routes/eligibility.js` — payer callback updates
  `pharmacy_status`
- `backend/src/routes/partners.js` — major rewrite: structured
  prescription capture, full pharmacy status transitions, request-info
  channel
- `backend/src/routes/patient.js` — `fill-payment-choice`, `pay` endpoints;
  `/me` returns prescription/pricing/pharmacy status
- `backend/src/routes/intake.js`, `backend/src/routes/journeys.js` — updated
  for the simplified stage list
- `storefront/src/App.jsx`, `storefront/src/api.js` — payment-choice UI on
  the patient portal
- `dashboard/src/App.jsx` — shows pharmacy_status alongside stage
- `telehealth-console/` — structured prescription form, pharmacy-requests
  panel
- `pharmacy-console/` — full status-driven action UI, request-info form,
  pricing display

## Known limitations after this step

- No real payment gateway — the "pay now" button is a demo action that
  flips a status, no money moves. Real Stripe/gateway integration is
  future work (Step 9).
- The pharmacy-level PA reuses the same payer-simulator as the earlier
  medical eligibility concept; a real system would likely have these be
  genuinely distinct payer-side systems (medical benefit vs. pharmacy
  benefit/PBM). Simplified here to one payer-simulator for the demo.
- `journeys.pharmacy_status` values aren't enforced by a database
  constraint (kept as free text for flexibility) — a typo in a status
  string wouldn't be caught by Postgres, only by the application code
  matching against the known set.

---

## Data sources reference (don't re-derive this each time)

| Need | Source | Free? | Notes |
|---|---|---|---|
| ICD-10-CM codes | CMS.gov / CDC NCHS | Yes | Direct download |
| NDC drug codes | FDA NDC Directory | Yes | Public |
| RxNorm | NLM/UMLS | Yes | Free account (US) |
| SNOMED CT (US ed.) | NLM/UMLS | Yes | Free account (US use) |
| FHIR schemas | HL7.org | Yes | Open spec |
| X12 270/271 sample transactions | Payer companion guides (Aetna, BCBS, UHC publish PDFs) | Yes | Full X12 spec itself is paywalled; samples are enough |
| MedDRA | ICH | **No** | Skip — not worth licensing for a demo |
| Synthetic patient populations | Synthea (MITRE, open source) | Yes | For if we ever want richer synthetic journey history |
| Real-ish drug pricing | CMS NADAC | Yes | Public, National Average Drug Acquisition Cost |

## Free LLM API reference (verified Aug 2026 — re-verify if it's been a while, these tiers shift)

| Provider | Free tier | Notes |
|---|---|---|
| Google Gemini API | ~1,000–1,500 req/day, no card | Default choice — best capability/reliability trade-off |
| Groq | ~1,000–14,400 req/day depending on model, no card | Very fast; good fallback |

Both called via plain `fetch()` from the backend — no SDK, no new hosting.
