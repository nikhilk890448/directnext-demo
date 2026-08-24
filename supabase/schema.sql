-- ============================================================================
-- DirectNEXT demo — Supabase schema
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- ============================================================================
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- PATIENTS — the only table that holds PHI. Nothing in this table is ever
-- returned by the dashboard API. The backend reaches it with the Supabase
-- service_role key (server-side only); RLS below blocks every other key.
-- ----------------------------------------------------------------------------
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  patient_ref text unique not null,          -- pseudonymous reference shown everywhere else, e.g. P-10432
  first_name text not null,
  last_name text not null,
  dob date,
  email text,
  phone text,
  address jsonb,
  condition text,
  insurance jsonb,                            -- { payer, member_id, group_number }
  consent jsonb default '{"care_coordination": true}'::jsonb,
  created_at timestamptz default now()
);

-- ----------------------------------------------------------------------------
-- JOURNEYS — one row per patient's trip through the program.
-- ----------------------------------------------------------------------------
create table if not exists journeys (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) not null,
  current_stage text not null default 'intake',
  status text not null default 'in_progress',   -- in_progress | completed | abandoned
  stage_entered_at timestamptz default now(),
  sla_due_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Append-only canonical event log (mirrors the "canonical event" contract).
create table if not exists journey_events (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid references journeys(id) not null,
  event_type text not null,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Closed-out stage durations, used for stage-latency reporting.
create table if not exists stage_history (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid references journeys(id) not null,
  stage text not null,
  entered_at timestamptz not null,
  exited_at timestamptz,
  duration_hours numeric
);

-- Work queue / exceptions. `reason` must always be written PHI-free —
-- e.g. "Payer response delayed", never "John Smith's claim was denied".
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid references journeys(id) not null,
  type text not null,
  reason text not null,
  priority text not null default 'medium',      -- low | medium | high
  assigned_role text,
  status text not null default 'open',          -- open | accepted | resolved
  created_at timestamptz default now(),
  resolved_at timestamptz
);

-- Hash-chained audit trail. `decision` must also always be PHI-free.
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid references journeys(id),
  actor text not null,
  decision text not null,
  fields_shared text,
  consent_basis text,
  input_hash text,
  prev_hash text not null,
  hash text not null,
  created_at timestamptz default now()
);

-- Registry of the AI agents this workflow can call. Deterministic stubs today;
-- swap the function bodies in backend/src/agents.js for real model calls later
-- without changing any caller, same as the plane/kill-switch pattern below.
create table if not exists agent_registry (
  id text primary key,
  name text not null,
  plane text not null check (plane in ('GOV','ORCH')),  -- GOV can veto (fail-closed); ORCH never blocks (fail-open)
  status text not null default 'up',                     -- up | down
  config jsonb default '{}'::jsonb
);

insert into agent_registry (id, name, plane) values
  ('intake-completeness', 'Intake Completeness Check', 'ORCH'),
  ('guardrail',           'Appropriateness Guardrail',  'GOV'),
  ('audit',               'Audit & Compliance',         'GOV'),
  ('adherence',           'Adherence Predictor',        'ORCH'),
  ('cost-optimizer',      'Cheapest Option Finder',     'ORCH'),
  ('denial-risk',         'Insurance Denial Predictor', 'ORCH')
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- PHI-FREE VIEWS — this is what the pharma dashboard is allowed to query.
-- Only patient_ref (a token), stage, timing and status ever cross this line.
-- No name, DOB, address, condition, or insurance detail is selected here.
-- ----------------------------------------------------------------------------
create or replace view journey_dashboard_view as
select
  j.id as journey_id,
  p.patient_ref,
  j.current_stage,
  j.status,
  j.stage_entered_at,
  j.sla_due_at,
  (j.sla_due_at is not null and now() > j.sla_due_at and j.status = 'in_progress') as is_breached,
  j.updated_at
from journeys j
join patients p on p.id = j.patient_id;

create or replace view task_dashboard_view as
select
  t.id, t.journey_id, p.patient_ref, t.type, t.reason, t.priority,
  t.assigned_role, t.status, t.created_at, t.resolved_at
from tasks t
join journeys j on j.id = t.journey_id
join patients p on p.id = j.patient_id;

create or replace view stage_latency_view as
select stage, percentile_cont(0.5) within group (order by duration_hours) as median_hours, count(*) as n
from stage_history
where exited_at is not null
group by stage;

-- ----------------------------------------------------------------------------
-- LOCK DOWN PHI. Enabling RLS with zero policies means only the service_role
-- key (used exclusively by the backend, never shipped to a browser) can read
-- or write these tables. The anon/authenticated keys get nothing.
-- ----------------------------------------------------------------------------
alter table patients enable row level security;
alter table journeys enable row level security;
alter table tasks enable row level security;
alter table journey_events enable row level security;
alter table stage_history enable row level security;
alter table audit_log enable row level security;
