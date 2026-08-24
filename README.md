# DirectNEXT — working demo

Three deployable pieces, one Postgres database:

```
storefront/   Patient-facing registration site  (React + Vite → static site)
backend/      Workflow engine + API             (Node/Express → web service)
dashboard/    Pharma-facing workflow dashboard   (React + Vite → static site)
supabase/     Postgres schema (run once)
```

**Data flow:** storefront → backend `/api/intake` → Supabase (`patients`, `journeys`,
`journey_events`, `audit_log`) → dashboard reads only a PHI-free view of that same data.

The backend is the only thing holding the Supabase **service role key**, and the
only thing that ever reads the `patients` table. The dashboard never requests
name, date of birth, address, or clinical detail — those columns aren't in the
view or API response it calls, so there's nothing to accidentally leak in the
UI. See `supabase/schema.sql` and `backend/src/contracts.js` for exactly how
that boundary is drawn.

---

## 1. Supabase — run the schema

1. Open your Supabase project → **SQL Editor** → New query.
2. Paste the entire contents of `supabase/schema.sql` and run it.
3. Go to **Project Settings → API** and copy two values you'll need in step 3:
   - **Project URL**
   - **service_role key** (not the `anon` key — the backend needs the one
     that can bypass Row Level Security to read/write `patients`)

## 2. GitHub — push this repo

```bash
cd directnext-demo
git init
git add .
git commit -m "DirectNEXT demo"
gh repo create directnext-demo --private --source=. --push
# or: create a repo on github.com, then
#   git remote add origin <your-repo-url>
#   git push -u origin main
```

## 3. Render — three services

You already have Render connected to GitHub, so for each of the three:
**New → select the service type below → connect this repo → set the root
directory → set build/start commands and env vars.**

### Backend (Web Service)
- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `SUPABASE_URL` = your project URL
  - `SUPABASE_SERVICE_ROLE_KEY` = your service role key
  - `ALLOWED_ORIGINS` = the storefront and dashboard URLs Render gives you,
    comma-separated (you'll fill this in after step 3b/3c exist — Render lets
    you edit env vars and redeploy anytime)
- After it deploys, note its URL, e.g. `https://directnext-backend.onrender.com`
- Check `https://YOUR-BACKEND-URL/healthz` returns `{"ok":true}`

### Storefront (Static Site)
- Root directory: `storefront`
- Build command: `npm install && npm run build`
- Publish directory: `dist`
- Environment variable: `VITE_API_URL` = your backend URL from above

### Dashboard (Static Site)
- Root directory: `dashboard`
- Build command: `npm install && npm run build`
- Publish directory: `dist`
- Environment variable: `VITE_API_URL` = your backend URL from above

Then go back to the **backend** service and set `ALLOWED_ORIGINS` to the
storefront and dashboard URLs Render just gave you, and redeploy the backend
so CORS allows them.

> Render's free web services spin down after inactivity and take ~30–60s to
> wake back up on the next request — expect that delay on the first click
> after idle time, that's normal for the free tier, not a bug.

---

## Local development (optional, before you deploy)

```bash
# backend
cd backend && cp .env.example .env   # fill in your Supabase values
npm install && npm run dev           # http://localhost:8080

# storefront (separate terminal)
cd storefront && cp .env.example .env
npm install && npm run dev           # http://localhost:5173

# dashboard (separate terminal)
cd dashboard && cp .env.example .env
npm install && npm run dev           # http://localhost:5174
```

---

## Trying it end to end

1. Open the storefront, fill out the form, submit.
2. Open the dashboard — the new journey shows up (poll refresh is every 10s,
   or reload). It'll already be sitting at **Insurance Prior Auth** — intake
   and the safety-gate agent run synchronously on submit.
3. Click the journey to open its detail panel: stage history, open
   tasks/exceptions, and the audit trail.
4. Click **Simulate partner response** to step it through Insurance PA →
   Telehealth → Pharmacy → Logistics → Refill. This button exists because no
   real payer/telehealth/pharmacy integration is connected yet — it stands in
   for that response the same way the workflow engine would react to a real
   one. Swapping it for a real webhook later doesn't change anything else.
5. Visit the **Agents** tab and flip a kill switch — try `guardrail` (GOV,
   fail-closed) vs `denial-risk` (ORCH, fail-open) on a fresh submission to
   see the different failure behavior.

---

## Where the AI agents plug in later

`backend/src/agents.js` has one deterministic stub function per agent you
listed — intake completeness, guardrail, denial-risk, cost-optimizer,
adherence — each with a fixed input/output shape. Replacing a stub's body
with a real model call (or a call out to a hosted agent) doesn't require
touching any route, because everything goes through `runAgent(id, input)`,
which already handles the kill-switch and fail-open/fail-closed behavior per
agent. Adding a new agent is: add a row to `agent_registry`, add a function,
add it to `AGENT_FNS`.

## Where "minimum necessary data" is enforced

`backend/src/contracts.js` defines an explicit allow-list of fields per
downstream role (dashboard, telehealth, pharmacy, logistics). Right now only
the dashboard path is wired end-to-end (via `journey_dashboard_view` in
Postgres, which is a second, physical enforcement of the same rule at the
database level). When you add a real telehealth or pharmacy integration,
build its response through `scopeFields()` instead of returning a patient
row directly, and it inherits the same guarantee.

## Known limitations of this demo

- No real payer, telehealth, pharmacy, or courier integration — `simulate-next`
  stands in for all of them.
- No authentication on the dashboard or backend yet — anyone with the
  dashboard URL can see the (PHI-free) workflow view, and anyone with the
  backend URL can call the API. Add Supabase Auth (or Render's built-in basic
  auth) in front of the dashboard, and an API key check in the backend,
  before sharing this outside your own testing.
- The SLA sweep runs as an in-process timer, which is fine for a demo but
  will reset if Render spins the free-tier service down; move it to a Render
  Cron Job calling a dedicated endpoint for anything long-running.
- Agents are deterministic stubs, not real models, by design — see above.
