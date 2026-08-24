-- ============================================================================
-- Migration 2: patient login accounts + real eligibility-check integration.
-- Run this in Supabase → SQL Editor AFTER schema.sql (and seed.sql if used).
-- Safe to run once; re-running will error on the duplicate column/table,
-- which just means it already applied.
-- ============================================================================

-- Links a patient row to their Supabase Auth account, so the backend can
-- verify "is the person calling /api/patient/me actually this patient".
alter table patients add column if not exists auth_user_id uuid unique;

-- ----------------------------------------------------------------------------
-- Requests sent to the payer simulator, and its decisions. This table is
-- shared by both services: the main backend writes the request (mirroring
-- the fields a real X12 270 inquiry carries), and the payer-simulator
-- service writes the decision after either auto-adjudicating or a human
-- reviewer acting on it in the payer dashboard.
-- ----------------------------------------------------------------------------
create table if not exists eligibility_requests (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid references journeys(id) not null,
  request jsonb not null,             -- the 270-style payload as sent
  missing_fields text[] default '{}', -- required fields that were absent
  status text not null default 'submitted',
    -- submitted | needs_info | auto_approved | auto_denied | pending_review | approved | denied
  decision jsonb,                     -- 271-style response once decided
  reviewed_by text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table eligibility_requests enable row level security;
-- No policies: only each service's own service_role key can read/write this,
-- same lockdown pattern as every other table in this schema.
